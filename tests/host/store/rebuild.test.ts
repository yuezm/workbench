// @vitest-environment node
/**
 * 账本专项：重建等价、强杀重启、白名单外表保留、why 时间线（M1 T9）。
 *
 * 用真实内核（decide / project / viewSpec）跑真实 store：增量投影与 `rebuild()` 是两条
 * 独立写入路径，这里断言同一份事实序列 fold 两次得到逐表相同的投影。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { decide } from '../../../src/kernel/decide'
import { project } from '../../../src/kernel/project'
import { IMPORT_ROOT_LABEL, timeline } from '../../../src/kernel/timeline'
import type { Actor, Fact, FactDraft, KernelPort } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import type { Command } from '../../../src/protocol/commands'
import type {
  Agent,
  Runtime,
  RuntimeProbe,
  Task,
  Workflow,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../src/protocol/entities'
import { openDatabase } from '../../../src/host/db'
import { withTx } from '../../../src/host/schema'
import { allFacts, appendFacts, lastSeq } from '../../../src/host/store/facts'
import { createStore, type Store } from '../../../src/host/store/index'
import { importLegacyIfNeeded } from '../../../src/host/store/import'
import { readProjectionMeta, rebuildProjection } from '../../../src/host/store/projection'
import { createMemoryDb, dumpProjection } from './test-support'

const AT = '2026-03-03T03:03:03.000Z'
const IMPORT_AT = '2026-02-02T02:02:02.000Z'
const OWNER: Actor = { kind: 'owner', via: 'ui' }
const realKernel: KernelPort = { decide, project, viewSpec }

const probe: RuntimeProbe = {
  state: 'ready',
  path: 'C:\\tools\\dsh.exe',
  cliVersion: '1.2.3',
  protocolVersion: 2,
  pluginVersion: '0.1.0',
  error: null,
  output: 'ok',
  elapsedMs: 12,
  checkedAt: AT,
}

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`缺少${label}`)
  return value
}

function findRuntime(store: Store, name: string): Runtime {
  return must(
    store.query('runtimes.all').find((item) => item.name === name),
    `运行时 ${name}`,
  )
}

function findAgent(store: Store, name: string): Agent {
  return must(
    store.query('agents.all').find((item) => item.name === name),
    `智能体 ${name}`,
  )
}

function findWorkflow(store: Store, name: string): WorkflowWithStages {
  return must(
    store.query('workflows.all').find((item) => item.name === name),
    `工作流 ${name}`,
  )
}

function findTask(store: Store, workflowId: string, title: string): Task {
  return must(
    store.query('tasks.byWorkflow', { workflowId }).find((item) => item.title === title),
    `任务 ${title}`,
  )
}

type CommandInput = Command extends infer C
  ? C extends Command
    ? Omit<C, 'commandId'>
    : never
  : never

describe('重建等价：≥200 条混合命令', () => {
  it('增量投影与 rebuild 后逐表全等（含删除 tombstone）', () => {
    const db = memory()
    const store = createStore({ db, kernel: realKernel })
    store.ensureProjection()

    let commands = 0
    let commandSeq = 0
    const send = (input: CommandInput): void => {
      commandSeq += 1
      store.dispatch({ ...input, commandId: `rebuild-${commandSeq}` } as Command)
      commands += 1
    }

    // 运行时：创建 → 更新 → 探测；另建一个临时运行时删除（tombstone）
    send({ type: 'runtime.create', input: { name: '运行时 A' } })
    const runtime = findRuntime(store, '运行时 A')
    send({
      type: 'runtime.update',
      id: runtime.id,
      patch: { model: 'deepseek/v4', reasoningEffort: 'high', maxConcurrent: 3 },
    })
    send({ type: 'runtime.probed', id: runtime.id, probe })
    send({ type: 'runtime.create', input: { name: '临时运行时' } })
    send({ type: 'runtime.remove', id: findRuntime(store, '临时运行时').id })

    // 智能体：三个常驻 + 一个创建后删除；改名走 agent.update
    for (let index = 0; index < 3; index += 1) {
      send({ type: 'agent.create', input: { name: `智能体 ${index}`, runtimeId: runtime.id } })
    }
    const agents = store.query('agents.all')
    const boundAgent = must(agents[1], '第二个智能体')
    send({
      type: 'agent.update',
      id: must(agents[0], '第一个智能体').id,
      patch: { name: '智能体 0（改）', description: '改过' },
    })
    send({ type: 'agent.create', input: { name: '临时智能体', runtimeId: runtime.id } })
    send({ type: 'agent.remove', id: findAgent(store, '临时智能体').id })

    // 主流程：三阶段 → 四个任务 → 移动/完成/删除 → 改名并换序（UNIQUE(position) 腾位）
    send({
      type: 'workflow.create',
      input: {
        name: '主流程',
        stages: [
          { name: '待办', entryMode: 'none' },
          { name: '实现', entryMode: 'agent', agentId: boundAgent.id },
          { name: '验收', entryMode: 'user' },
        ],
      },
    })
    const main = findWorkflow(store, '主流程')
    for (let index = 0; index < 4; index += 1) {
      send({ type: 'task.create', input: { title: `主任务 ${index}`, workflowId: main.id } })
    }
    const mainTasks = store.query('tasks.byWorkflow', { workflowId: main.id })
    const firstTaskId = must(mainTasks[0], '主任务 0').id
    send({ type: 'task.move', id: firstTaskId, stageId: main.stages[1].id })
    send({ type: 'task.move', id: firstTaskId, stageId: main.stages[2].id })
    send({ type: 'task.complete', id: must(mainTasks[1], '主任务 1').id })
    send({ type: 'task.remove', id: must(mainTasks[2], '主任务 2').id })
    send({
      type: 'workflow.update',
      id: main.id,
      input: {
        name: '主流程（改）',
        stages: [
          { id: main.stages[0].id, name: '待办', entryMode: 'none' },
          { id: main.stages[2].id, name: '验收', entryMode: 'user' },
          { id: main.stages[1].id, name: '实现', entryMode: 'agent', agentId: boundAgent.id },
          { name: '复盘', entryMode: 'none' },
        ],
      },
    })

    // 临时流程：连带阶段与任务一起删除（workflow.remove 显式产出 tombstone）
    send({
      type: 'workflow.create',
      input: { name: '临时流程', stages: [{ name: '唯一阶段', entryMode: 'none' }] },
    })
    const tempWorkflow = findWorkflow(store, '临时流程')
    send({ type: 'task.create', input: { title: '临时任务', workflowId: tempWorkflow.id } })
    send({ type: 'workflow.remove', id: tempWorkflow.id })

    // 循环混合操作把命令数推过 200：每轮建流程/建任务/移动/完成/删除任务/删流程
    let round = 0
    while (commands < 200) {
      round += 1
      const name = `循环流程 ${round}`
      send({
        type: 'workflow.create',
        input: {
          name,
          stages: [
            { name: '开始', entryMode: 'none' },
            { name: '结束', entryMode: 'none' },
          ],
        },
      })
      const loopWorkflow = findWorkflow(store, name)
      send({
        type: 'task.create',
        input: { title: `${name} 任务 1`, workflowId: loopWorkflow.id },
      })
      send({
        type: 'task.create',
        input: { title: `${name} 任务 2`, workflowId: loopWorkflow.id },
      })
      const loopTasks = store.query('tasks.byWorkflow', { workflowId: loopWorkflow.id })
      send({
        type: 'task.move',
        id: must(loopTasks[0], `${name} 任务 1`).id,
        stageId: loopWorkflow.stages[1].id,
      })
      send({ type: 'task.complete', id: must(loopTasks[1], `${name} 任务 2`).id })
      send({ type: 'task.remove', id: must(loopTasks[0], `${name} 任务 1`).id })
      send({ type: 'workflow.remove', id: loopWorkflow.id })
    }

    // 增量投影后的状态：只剩主流程及其阶段/任务；删除类事实已落成 tombstone
    expect(commands).toBeGreaterThanOrEqual(200)
    expect(store.factsCount()).toBeGreaterThanOrEqual(200)
    expect(store.query('workflows.all').map((item) => item.name)).toEqual(['主流程（改）'])

    const workflowsBefore = store.query('workflows.all')
    const tasksBefore = store.query('tasks.byWorkflow', { workflowId: main.id })
    const incremental = dumpProjection(db)
    const metaBefore = readProjectionMeta(db)
    expect(incremental.runtimes).toHaveLength(1)
    expect(incremental.agents).toHaveLength(3)
    expect(incremental.workflows).toHaveLength(1)
    expect(incremental.workflow_stages).toHaveLength(4)
    expect(tasksBefore.map((item) => item.title)).toEqual(['主任务 0', '主任务 1', '主任务 3'])

    store.rebuild()

    expect(dumpProjection(db)).toEqual(incremental)
    expect(store.query('workflows.all')).toEqual(workflowsBefore)
    expect(store.query('tasks.byWorkflow', { workflowId: main.id })).toEqual(tasksBefore)
    expect(readProjectionMeta(db)).toEqual(metaBefore)
    expect(metaBefore?.seq).toBe(store.factsCount())
    expect(store.factsSince(0)).toHaveLength(store.factsCount())
  })
})

describe('强杀重启：事实已提交、投影落后', () => {
  it('重开后 ensureProjection 追平，投影与全量应用逐表全等', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwf-rebuild-'))
    const file = path.join(root, 'ai-workflow.db')
    let reopened: DatabaseSync | null = null
    try {
      let factsSnapshot: Fact[] = []
      let lagging: Record<string, unknown[]> = {}
      let metaBeforeLag: ReturnType<typeof readProjectionMeta> = null
      let existingTaskId = ''
      let targetStageId = ''

      const db = openDatabase(file)
      try {
        const store = createStore({ db, kernel: realKernel })
        store.ensureProjection()

        // 强杀前已经提交并落了投影的命令
        store.dispatch({
          type: 'runtime.create',
          commandId: 'kill-runtime',
          input: { name: '运行时 A' },
        })
        store.dispatch({
          type: 'workflow.create',
          commandId: 'kill-workflow',
          input: {
            name: '流程',
            stages: [
              { name: '待办', entryMode: 'none' },
              { name: '实现', entryMode: 'none' },
            ],
          },
        })
        const workflow = findWorkflow(store, '流程')
        store.dispatch({
          type: 'task.create',
          commandId: 'kill-task',
          input: { title: '既有任务', workflowId: workflow.id },
        })
        const existingTask = findTask(store, workflow.id, '既有任务')
        existingTaskId = existingTask.id
        targetStageId = workflow.stages[1].id
        const factsBeforeLag = store.factsCount()
        metaBeforeLag = readProjectionMeta(db)
        expect(metaBeforeLag?.seq).toBe(factsBeforeLag)

        // 强杀模拟：事实已提交（appendFacts），但投影与 meta 都没跟上
        const aheadRuntime: Runtime = {
          id: 'rt-ahead',
          name: '崩溃前新增运行时',
          protocolFamily: 'dsh',
          command: 'dsh',
          profile: 'multica',
          permissionMode: 'workspace-write',
          model: null,
          reasoningEffort: null,
          workdir: null,
          maxConcurrent: 1,
          enabled: true,
          createdAt: AT,
          lastProbe: null,
        }
        const aheadWorkflow: Workflow = {
          id: 'wf-ahead',
          name: '崩溃前新增流程',
          description: '',
          createdAt: AT,
        }
        const aheadStage: WorkflowStage = {
          id: 'st-ahead',
          workflowId: aheadWorkflow.id,
          name: '唯一阶段',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
        }
        const aheadTask: Task = {
          id: 'tk-ahead',
          title: '崩溃前新增任务',
          description: '',
          workflowId: aheadWorkflow.id,
          currentStageId: aheadStage.id,
          status: 'active',
          createdAt: AT,
          updatedAt: AT,
        }
        const drafts: FactDraft[] = [
          { type: 'runtime.created', actor: OWNER, at: AT, payload: { runtime: aheadRuntime } },
          { type: 'workflow.created', actor: OWNER, at: AT, payload: { workflow: aheadWorkflow } },
          { type: 'stage.created', actor: OWNER, at: AT, payload: { stage: aheadStage } },
          { type: 'task.created', actor: OWNER, at: AT, payload: { task: aheadTask } },
          {
            type: 'task.moved',
            actor: OWNER,
            at: AT,
            payload: {
              task: { ...existingTask, currentStageId: targetStageId, updatedAt: AT },
              from: existingTask.currentStageId,
              to: targetStageId,
            },
          },
        ]
        withTx(db, () => appendFacts(db, drafts))

        factsSnapshot = allFacts(db)
        expect(store.factsCount()).toBe(factsBeforeLag + drafts.length)
        expect(lastSeq(db)).toBe(factsBeforeLag + drafts.length)
        // 崩溃点：事实已到账，投影仍停在强杀前
        lagging = dumpProjection(db)
        expect(lagging.runtimes).toHaveLength(1)
        expect((lagging.runtimes as Array<{ id: string }>)[0]?.id).not.toBe(aheadRuntime.id)
        expect(lagging.workflows).toHaveLength(1)
        expect(readProjectionMeta(db)).toEqual(metaBeforeLag)
      } finally {
        db.close()
      }

      // 全量应用预期：独立内存库按 seq 重放全部事实
      const full = memory()
      withTx(full, () => appendFacts(full, factsSnapshot))
      rebuildProjection(full, realKernel)
      const expected = dumpProjection(full)
      const expectedMeta = readProjectionMeta(full)
      expect(expected.runtimes).toHaveLength(2)
      expect(expected.workflows).toHaveLength(2)
      expect(expected.tasks).toHaveLength(2)

      // 重开：meta.seq 落后 → ensureProjection 重建
      reopened = openDatabase(file)
      const restarted = createStore({ db: reopened, kernel: realKernel })
      expect(restarted.ensureProjection()).toEqual({ rebuilt: true })
      expect(dumpProjection(reopened)).toEqual(expected)
      expect(readProjectionMeta(reopened)).toEqual(expectedMeta)
      expect(readProjectionMeta(reopened)?.seq).toBe(restarted.factsCount())
      expect(readProjectionMeta(reopened)?.seq).toBe(lastSeq(reopened))
      // 追平后再对账不重建
      expect(restarted.ensureProjection()).toEqual({ rebuilt: false })

      // 语义断言：崩溃前提交的事实生效
      expect(restarted.query('runtimes.all').map((item) => item.name)).toContain('崩溃前新增运行时')
      expect(
        restarted
          .query('workflows.all')
          .map((item) => item.name)
          .sort(),
      ).toEqual(['崩溃前新增流程', '流程'])
      expect(restarted.query('task.byId', { taskId: existingTaskId })?.currentStageId).toBe(
        targetStageId,
      )
      expect(restarted.query('task.byId', { taskId: 'tk-ahead' })?.currentStageId).toBe('st-ahead')
    } finally {
      reopened?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('重建边界：运行/聊天四表纳入白名单', () => {
  it('runs / run_events / conversations / messages 没有事实支撑的行重建后清空', () => {
    const db = memory()
    const store = createStore({ db, kernel: realKernel })
    store.ensureProjection()
    store.dispatch({
      type: 'runtime.create',
      commandId: 'wl-runtime',
      input: { name: '运行时' },
    })
    const runtime = findRuntime(store, '运行时')
    store.dispatch({
      type: 'agent.create',
      commandId: 'wl-agent',
      input: { name: '智能体', runtimeId: runtime.id },
    })
    const agent = findAgent(store, '智能体')
    store.dispatch({
      type: 'workflow.create',
      commandId: 'wl-workflow',
      input: { name: '流程', stages: [{ name: '阶段', entryMode: 'none' }] },
    })
    const workflow = findWorkflow(store, '流程')
    store.dispatch({
      type: 'task.create',
      commandId: 'wl-task',
      input: { title: '任务', workflowId: workflow.id },
    })
    const task = findTask(store, workflow.id, '任务')
    const entitiesBefore = dumpProjection(db)

    // 旧写路径直接落库、没有对应事实的运行/聊天行：重建后不应保留。
    db.prepare('INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)').run(
      'run-1',
      task.id,
      'running',
      AT,
    )
    db.prepare(
      'INSERT INTO run_events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('run-1', 1, 'status', '{"state":"running"}', AT)
    db.prepare(
      'INSERT INTO conversations (id, title, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('cv-1', '对话', agent.id, AT, AT)
    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('ms-1', 'cv-1', 'user', '你好', AT)

    store.rebuild()

    const rebuilt = dumpProjection(db)
    expect(rebuilt).toEqual(entitiesBefore)
    expect(rebuilt.runs).toEqual([])
    expect(rebuilt.run_events).toEqual([])
    expect(rebuilt.conversations).toEqual([])
    expect(rebuilt.messages).toEqual([])
  })
})

describe('why 时间线：kernel/timeline', () => {
  it('按 seq 还原 task 的 created → moved → completed 链', () => {
    const db = memory()
    const store = createStore({ db, kernel: realKernel })
    store.ensureProjection()
    store.dispatch({
      type: 'workflow.create',
      commandId: 'tl-workflow',
      input: {
        name: '流程',
        stages: [
          { name: '待办', entryMode: 'none' },
          { name: '完成', entryMode: 'none' },
        ],
      },
    })
    const workflow = findWorkflow(store, '流程')
    store.dispatch({
      type: 'task.create',
      commandId: 'tl-task',
      input: { title: '任务', workflowId: workflow.id },
    })
    const task = findTask(store, workflow.id, '任务')
    store.dispatch({
      type: 'task.move',
      commandId: 'tl-move',
      id: task.id,
      stageId: workflow.stages[1].id,
    })
    store.dispatch({ type: 'task.complete', commandId: 'tl-complete', id: task.id })

    const entries = timeline(store.factsSince(0), 'task', task.id)

    expect(entries.map((entry) => entry.fact.type)).toEqual([
      'task.created',
      'task.moved',
      'task.completed',
    ])
    expect(entries.every((entry) => !entry.imported && entry.label === null)).toBe(true)
    const seqs = entries.map((entry) => entry.fact.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('导入根标「迁移导入」，并与后续 task.moved 组成链', () => {
    const db = memory()
    db.exec(`
      INSERT INTO runtimes (id, name, created_at) VALUES ('rt-legacy', '旧运行时', '${IMPORT_AT}');
      INSERT INTO agents (id, name, runtime_id, created_at)
        VALUES ('ag-legacy', '旧智能体', 'rt-legacy', '${IMPORT_AT}');
      INSERT INTO workflows (id, name, created_at) VALUES ('wf-legacy', '旧流程', '${IMPORT_AT}');
      INSERT INTO workflow_stages (id, workflow_id, name, position, entry_mode, created_at) VALUES
        ('st-1', 'wf-legacy', '待办', 0, 'none', '${IMPORT_AT}'),
        ('st-2', 'wf-legacy', '完成', 1, 'none', '${IMPORT_AT}');
      INSERT INTO tasks (id, title, workflow_id, current_stage_id, status, created_at, updated_at)
        VALUES ('tk-1', '旧任务', 'wf-legacy', 'st-1', 'active', '${IMPORT_AT}', '${IMPORT_AT}');
    `)

    const imported = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
    expect(imported.imported).toBe(true)

    const store = createStore({ db, kernel: realKernel })
    expect(store.ensureProjection()).toEqual({ rebuilt: false })
    store.dispatch({ type: 'task.move', commandId: 'legacy-move', id: 'tk-1', stageId: 'st-2' })

    const entries = timeline(store.factsSince(0), 'task', 'tk-1')

    expect(entries.map((entry) => entry.fact.type)).toEqual(['snapshot.imported', 'task.moved'])
    expect(entries[0]).toMatchObject({ imported: true, label: IMPORT_ROOT_LABEL })
    expect(entries[0]?.fact.cause).toBeUndefined()
    expect(entries[1]).toMatchObject({ imported: false, label: null })
    expect(entries.map((entry) => entry.fact.seq)).toEqual([5, 6])
  })
})
