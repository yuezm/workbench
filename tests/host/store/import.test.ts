// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { project } from '../../../src/kernel/project'
import { IMPORT_ROOT_LABEL, timeline } from '../../../src/kernel/timeline'
import { KERNEL_VERSION } from '../../../src/kernel/types'
import type { Fact, ProjectionTable } from '../../../src/kernel/types'
import type {
  Agent,
  Runtime,
  RuntimeProbe,
  Task,
  Workflow,
  WorkflowStage,
} from '../../../src/protocol/entities'
import { openDatabase } from '../../../src/host/db'
import { projectionFormat } from '../../../src/host/schema'
import { allFacts, factsCount } from '../../../src/host/store/facts'
import { createFakeKernel } from './fake-kernel'
import {
  IMPORT_BATCH_SIZE,
  IMPORT_ORDER,
  importLegacyIfNeeded,
} from '../../../src/host/store/import'
import { readProjectionMeta, rebuildProjection } from '../../../src/host/store/projection'
import { dumpProjection } from './test-support'

/** 导入事实的统一时间：阶段 created_at 也应对齐到它。 */
const IMPORT_AT = '2026-02-02T02:02:02.000Z'

/** 旧表行的时间（早于导入时间，用于验证阶段 created_at 被改成导入 at）。 */
const seedAt = (second: number): string =>
  `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`

const realKernel = createFakeKernel({ project })

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

function memory(): DatabaseSync {
  const db = openDatabase(':memory:')
  openDbs.push(db)
  return db
}

interface LegacySeed {
  runtimes: Runtime[]
  agents: Agent[]
  workflows: Workflow[]
  workflow_stages: WorkflowStage[]
  tasks: Task[]
}

const probe: RuntimeProbe = {
  state: 'ready',
  path: 'C:\\tools\\dsh.exe',
  cliVersion: '1.2.3',
  protocolVersion: 2,
  pluginVersion: '0.1.0',
  error: null,
  output: 'ok',
  elapsedMs: 12,
  checkedAt: seedAt(1),
}

/** 造 v2 存量：五表各若干行，含运行时/智能体/工作流/阶段/任务的外键与阶段自引用。 */
function seedRich(db: DatabaseSync): LegacySeed {
  const runtimes: Runtime[] = [
    {
      id: 'rt-1',
      name: '本机 dsh',
      protocolFamily: 'dsh',
      command: 'dsh',
      profile: 'multica',
      permissionMode: 'workspace-write',
      model: 'deepseek/v4',
      reasoningEffort: 'high',
      workdir: 'C:/work',
      maxConcurrent: 2,
      enabled: true,
      createdAt: seedAt(1),
      lastProbe: probe,
    },
    {
      id: 'rt-2',
      name: '备用 dsh',
      protocolFamily: 'dsh',
      command: 'dsh',
      profile: 'multica',
      permissionMode: 'read-only',
      model: null,
      reasoningEffort: null,
      workdir: null,
      maxConcurrent: 1,
      enabled: false,
      createdAt: seedAt(2),
      lastProbe: null,
    },
  ]
  const agents: Agent[] = [
    {
      id: 'ag-1',
      name: '实现者',
      description: '写代码',
      runtimeId: 'rt-1',
      systemPrompt: '你是实现者',
      createdAt: seedAt(3),
    },
    {
      id: 'ag-2',
      name: '审查者',
      description: '',
      runtimeId: 'rt-2',
      systemPrompt: '',
      createdAt: seedAt(4),
    },
  ]
  const workflows: Workflow[] = [
    { id: 'wf-1', name: '默认流程', description: '两阶段', createdAt: seedAt(5) },
  ]
  const workflow_stages: WorkflowStage[] = [
    {
      id: 'st-1',
      workflowId: 'wf-1',
      name: '待办',
      position: 0,
      entryMode: 'none',
      agentId: null,
      onCompleteStageId: 'st-2',
      onRejectStageId: null,
    },
    {
      id: 'st-2',
      workflowId: 'wf-1',
      name: '实现',
      position: 1,
      entryMode: 'agent',
      agentId: 'ag-1',
      onCompleteStageId: null,
      onRejectStageId: 'st-1',
    },
  ]
  const tasks: Task[] = [
    {
      id: 'tk-1',
      title: '做点什么',
      description: '',
      workflowId: 'wf-1',
      currentStageId: 'st-2',
      status: 'active',
      createdAt: seedAt(6),
      updatedAt: seedAt(7),
    },
    {
      id: 'tk-2',
      title: '完成的事',
      description: '已归档',
      workflowId: 'wf-1',
      currentStageId: null,
      status: 'completed',
      createdAt: seedAt(8),
      updatedAt: seedAt(9),
    },
  ]

  const insertRuntime = db.prepare(
    `INSERT INTO runtimes
       (id, name, protocol_family, command, profile, permission_mode, model, reasoning_effort,
        workdir, max_concurrent, enabled, last_probe_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const runtime of runtimes) {
    insertRuntime.run(
      runtime.id,
      runtime.name,
      runtime.protocolFamily,
      runtime.command,
      runtime.profile,
      runtime.permissionMode,
      runtime.model,
      runtime.reasoningEffort,
      runtime.workdir,
      runtime.maxConcurrent,
      runtime.enabled ? 1 : 0,
      runtime.lastProbe === null ? null : JSON.stringify(runtime.lastProbe),
      runtime.createdAt,
    )
  }

  const insertAgent = db.prepare(
    `INSERT INTO agents (id, name, description, runtime_id, system_prompt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const agent of agents) {
    insertAgent.run(
      agent.id,
      agent.name,
      agent.description,
      agent.runtimeId,
      agent.systemPrompt,
      agent.createdAt,
    )
  }

  const insertWorkflow = db.prepare(
    'INSERT INTO workflows (id, name, description, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const workflow of workflows) {
    insertWorkflow.run(workflow.id, workflow.name, workflow.description, workflow.createdAt)
  }

  // 旧表阶段行的 created_at 与导入 at 不同：导入后应统一对齐成 at（行类型里没有该字段）。
  // 两个阶段互相引用（on_complete / on_reject），造数时先关外键，模拟已存在的 v2 存量。
  const insertStage = db.prepare(
    `INSERT INTO workflow_stages
       (id, workflow_id, name, position, entry_mode, agent_id, on_complete_stage_id,
        on_reject_stage_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    for (const stage of workflow_stages) {
      insertStage.run(
        stage.id,
        stage.workflowId,
        stage.name,
        stage.position,
        stage.entryMode,
        stage.agentId,
        stage.onCompleteStageId,
        stage.onRejectStageId,
        seedAt(10),
      )
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }

  const insertTask = db.prepare(
    `INSERT INTO tasks
       (id, title, description, workflow_id, current_stage_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const task of tasks) {
    insertTask.run(
      task.id,
      task.title,
      task.description,
      task.workflowId,
      task.currentStageId,
      task.status,
      task.createdAt,
      task.updatedAt,
    )
  }

  return { runtimes, agents, workflows, workflow_stages, tasks }
}

/** 取某表的导入事实 payload（不存在就失败）。 */
function payloadOf(facts: readonly Fact[], table: ProjectionTable): { rows: unknown[] } {
  const fact = facts.find((item) => (item.payload as { table?: string }).table === table)
  if (!fact) throw new Error(`缺少 ${table} 的导入事实`)
  return fact.payload as { rows: unknown[] }
}

const emptyCounts = (): Record<ProjectionTable, number> => ({
  tasks: 0,
  workflows: 0,
  workflow_stages: 0,
  agents: 0,
  runtimes: 0,
})

describe('importLegacyIfNeeded', () => {
  it('v2 存量一次导入：事实、投影、元信息逐项正确', () => {
    const db = memory()
    const legacy = seedRich(db)
    const before = dumpProjection(db)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.imported).toBe(true)
    expect(result.counts).toEqual({
      runtimes: 2,
      agents: 2,
      workflows: 1,
      workflow_stages: 2,
      tasks: 2,
    })

    const facts = allFacts(db)
    expect(facts.map((fact) => fact.seq)).toEqual([1, 2, 3, 4, 5])
    expect(facts.map((fact) => fact.type)).toEqual(Array(5).fill('snapshot.imported'))
    expect(facts.map((fact) => (fact.payload as { table: string }).table)).toEqual([
      ...IMPORT_ORDER,
    ])
    expect(facts.every((fact) => fact.cause === undefined)).toBe(true)
    expect(
      facts.every((fact) => fact.actor.kind === 'host' && fact.actor.via === 'reconcile'),
    ).toBe(true)
    expect(facts.every((fact) => fact.at === IMPORT_AT)).toBe(true)

    // 事实 payload 的 rows 与旧表实体逐行相等
    expect(payloadOf(facts, 'runtimes').rows).toEqual(legacy.runtimes)
    expect(payloadOf(facts, 'agents').rows).toEqual(legacy.agents)
    expect(payloadOf(facts, 'workflows').rows).toEqual(legacy.workflows)
    expect(payloadOf(facts, 'workflow_stages').rows).toEqual(legacy.workflow_stages)
    expect(payloadOf(facts, 'tasks').rows).toEqual(legacy.tasks)

    // 投影与旧表逐列相等；唯一差异是阶段 created_at 对齐成导入 at
    const expected = {
      ...before,
      workflow_stages: (before.workflow_stages as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        created_at: IMPORT_AT,
      })),
    }
    expect(dumpProjection(db)).toEqual(expected)
    expect(readProjectionMeta(db)).toEqual({
      format: projectionFormat(KERNEL_VERSION),
      seq: 5,
    })
  })

  it('导入结果与按事实重建逐表全等', () => {
    const db = memory()
    seedRich(db)
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
    const afterImport = dumpProjection(db)

    rebuildProjection(db, realKernel)

    expect(dumpProjection(db)).toEqual(afterImport)
    expect(readProjectionMeta(db)).toEqual({
      format: projectionFormat(KERNEL_VERSION),
      seq: 5,
    })
  })

  it('超过 500 行按批次写多条事实', () => {
    const db = memory()
    const insert = db.prepare('INSERT INTO runtimes (id, name, created_at) VALUES (?, ?, ?)')
    const total = IMPORT_BATCH_SIZE + 1
    for (let index = 0; index < total; index++) {
      insert.run(`rt-${String(index).padStart(3, '0')}`, `运行时 ${index}`, seedAt(1))
    }

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.counts.runtimes).toBe(total)
    const facts = allFacts(db)
    expect(facts).toHaveLength(2)
    expect(facts.map((fact) => fact.seq)).toEqual([1, 2])
    expect(payloadOf(facts, 'runtimes').rows).toHaveLength(IMPORT_BATCH_SIZE)
    expect((facts[1].payload as { rows: unknown[] }).rows).toHaveLength(1)
    expect(readProjectionMeta(db)).toEqual({ format: projectionFormat(KERNEL_VERSION), seq: 2 })
  })

  it('空库：不产事实、不写投影元信息', () => {
    const db = memory()
    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result).toEqual({ imported: false, counts: emptyCounts() })
    expect(factsCount(db)).toBe(0)
    expect(readProjectionMeta(db)).toBeNull()
    expect(dumpProjection(db)).toEqual({
      tasks: [],
      workflows: [],
      workflow_stages: [],
      agents: [],
      runtimes: [],
    })
  })

  it('第二次调用 no-op：不追加事实、不重写投影与元信息', () => {
    const db = memory()
    seedRich(db)
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
    const factsBefore = allFacts(db)
    const dumpBefore = dumpProjection(db)
    const metaBefore = readProjectionMeta(db)

    const again = importLegacyIfNeeded(db, realKernel, { at: '2026-03-03T00:00:00.000Z' })

    expect(again).toEqual({ imported: false, counts: emptyCounts() })
    expect(allFacts(db)).toEqual(factsBefore)
    expect(dumpProjection(db)).toEqual(dumpBefore)
    expect(readProjectionMeta(db)).toEqual(metaBefore)
  })

  it('不传 at 时用当前时刻作为导入根时间', () => {
    const db = memory()
    seedRich(db)

    importLegacyIfNeeded(db, realKernel)

    const facts = allFacts(db)
    expect(facts).toHaveLength(5)
    const at = facts[0]?.at ?? ''
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Number.isNaN(Date.parse(at))).toBe(false)
    expect(new Set(facts.map((fact) => fact.at)).size).toBe(1)
  })

  it('导入根在 timeline 标「迁移导入」，不伪造 cause', () => {
    const db = memory()
    seedRich(db)
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
    const facts = allFacts(db)

    for (const scope of ['task', 'workflow', 'stage', 'agent', 'runtime'] as const) {
      const id = {
        task: 'tk-1',
        workflow: 'wf-1',
        stage: 'st-1',
        agent: 'ag-1',
        runtime: 'rt-2',
      }[scope]
      const entries = timeline(facts, scope, id)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.imported).toBe(true)
      expect(entries[0]?.label).toBe(IMPORT_ROOT_LABEL)
      expect(entries[0]?.fact.cause).toBeUndefined()
    }
  })

  it('外键冲突：COMMIT 失败整体回滚，不留事实与半套投影', () => {
    const db = memory()
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare(
      `INSERT INTO tasks
         (id, title, description, workflow_id, current_stage_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('tk-bad', '坏任务', '', 'missing-wf', null, 'active', seedAt(1), seedAt(1))
    db.exec('PRAGMA foreign_keys = ON')
    const before = dumpProjection(db)

    expect(() => importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })).toThrow(/FOREIGN KEY/i)
    expect(factsCount(db)).toBe(0)
    expect(readProjectionMeta(db)).toBeNull()
    expect(dumpProjection(db)).toEqual(before)
  })

  it('导入校验失败：整体回滚，facts 与投影回到导入前', () => {
    const db = memory()
    const legacy = seedRich(db)
    const ghost: Runtime = { ...legacy.runtimes[0], id: 'rt-ghost', name: '幽灵运行时' }
    const noisyKernel = createFakeKernel({
      project: (fact) => {
        const changes = project(fact)
        const table = (fact.payload as { table?: string }).table
        if (fact.type === 'snapshot.imported' && table === 'runtimes') {
          changes.push({ table: 'runtimes', key: ghost.id, row: ghost })
        }
        return changes
      },
    })
    const before = dumpProjection(db)

    expect(() => importLegacyIfNeeded(db, noisyKernel, { at: IMPORT_AT })).toThrow(
      /存量导入校验失败/,
    )
    expect(factsCount(db)).toBe(0)
    expect(readProjectionMeta(db)).toBeNull()
    expect(dumpProjection(db)).toEqual(before)
  })
})
