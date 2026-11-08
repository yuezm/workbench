// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { project } from '../../../src/kernel/project'
import { IMPORT_ROOT_LABEL, timeline } from '../../../src/kernel/timeline'
import { KERNEL_VERSION } from '../../../src/kernel/types'
import type { Fact, ProjectionTable } from '../../../src/kernel/types'
import type {
  Agent,
  RunErrorCode,
  RunEventRow,
  RunEventType,
  RunRow,
  RunStatus,
  RunUsage,
  Runtime,
  RuntimeProbe,
  Task,
  Workflow,
  WorkflowStage,
} from '../../../src/protocol/entities'
import { openDatabase } from '../../../src/host/db'
import { projectionFormat } from '../../../src/host/schema'
import { allFacts, appendFacts, factsCount } from '../../../src/host/store/facts'
import { createFakeKernel } from './fake-kernel'
import {
  IMPORT_BATCH_SIZE,
  IMPORT_ORDER,
  importLegacyIfNeeded,
} from '../../../src/host/store/import'
import {
  ensureProjection,
  readProjectionMeta,
  rebuildProjection,
} from '../../../src/host/store/projection'
import { dumpProjection, sample } from './test-support'

/** 导入事实的统一时间：阶段 created_at 与事件 created_at 都对齐到它。 */
const IMPORT_AT = '2026-02-02T02:02:02.000Z'

/** 旧表行的时间（早于导入时间，用于验证时间列被归一）。 */
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
  runs: RunRow[]
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

/**
 * 存量 runs 行的 M2 缺列默认值（T2 口径）：归一只补这些，业务字段（状态/提示词/输出/
 * 用量/时间戳）保留原值。独立写一遍而不是复用实现里的常量，测试才真能钉住口径。
 */
const RUN_DEFAULTS = {
  purpose: 'stage',
  conversationId: null,
  ruleId: null,
  rulesVersion: 0,
  executorKey: '',
  threadId: null,
  cwd: '',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 0,
  leaseId: null,
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
} satisfies Pick<
  RunRow,
  | 'purpose'
  | 'conversationId'
  | 'ruleId'
  | 'rulesVersion'
  | 'executorKey'
  | 'threadId'
  | 'cwd'
  | 'access'
  | 'skill'
  | 'promptRef'
  | 'eventIds'
  | 'hops'
  | 'turn'
  | 'resumeSessionId'
  | 'threadContextRef'
  | 'queueSeq'
  | 'leaseId'
  | 'attempt'
  | 'attempts'
  | 'leaseUntil'
  | 'notBefore'
  | 'deadlineAt'
  | 'cancelRequested'
>

/** 旧 runs 行的业务列（导入前就有的 v2 列）。 */
interface LegacyRunSeed {
  id: string
  taskId: string
  stageId: string | null
  agentId: string | null
  runtimeId: string | null
  status: RunStatus
  prompt: string
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  exitCode: number | null
  sessionId: string | null
  usage: RunUsage | null
  durationMs: number | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

/** 期望的投影/事实行 = 旧业务列 + 缺列默认值。 */
const normalizedRun = (seed: LegacyRunSeed): RunRow => ({ ...RUN_DEFAULTS, ...seed })

interface LegacyRunEventSeed {
  runId: string
  seq: number
  type: RunEventType
  payload: Omit<RunEventRow, 'runId' | 'seq' | 'type'>
  createdAt: string
}

const legacyRuns: LegacyRunSeed[] = [
  {
    id: 'run-1',
    taskId: 'tk-1',
    stageId: 'st-2',
    agentId: 'ag-1',
    runtimeId: 'rt-1',
    status: 'succeeded',
    prompt: '帮我实现',
    output: '完成',
    error: null,
    errorCode: null,
    exitCode: 0,
    sessionId: 'sess-1',
    usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 4 },
    durationMs: 1234,
    startedAt: seedAt(20),
    endedAt: seedAt(21),
    createdAt: seedAt(22),
  },
  {
    id: 'run-2',
    taskId: 'tk-2',
    stageId: null,
    agentId: 'ag-2',
    runtimeId: 'rt-2',
    status: 'failed',
    prompt: '再试一次',
    output: '',
    error: '非零退出',
    errorCode: 'exit_nonzero',
    exitCode: 1,
    sessionId: null,
    usage: null,
    durationMs: 99,
    startedAt: seedAt(23),
    endedAt: seedAt(24),
    createdAt: seedAt(25),
  },
]

const legacyRunEvents: LegacyRunEventSeed[] = [
  { runId: 'run-1', seq: 1, type: 'status', payload: { status: 'running' }, createdAt: seedAt(26) },
  { runId: 'run-1', seq: 2, type: 'text', payload: { text: 'hi' }, createdAt: seedAt(27) },
  {
    runId: 'run-1',
    seq: 3,
    type: 'tool_call',
    payload: { tool: 'read', callId: 'c-1', input: '{}' },
    createdAt: seedAt(28),
  },
  { runId: 'run-2', seq: 1, type: 'text', payload: { text: 'oops' }, createdAt: seedAt(29) },
  {
    runId: 'run-2',
    seq: 2,
    type: 'tool_result',
    payload: { tool: 'read', callId: 'c-1', output: 'x', isError: true },
    createdAt: seedAt(30),
  },
]

/** 期望的 run_events 事实行（时间不进 payload，投影 created_at 取导入 at）。 */
const expectedRunEvents = (): RunEventRow[] =>
  legacyRunEvents.map((event) => ({
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    ...event.payload,
  }))

/** 期望的 runs 事实行（旧业务列 + 缺列默认值）。 */
const expectedRuns = (): RunRow[] => legacyRuns.map(normalizedRun)

/** 造 v2 存量实体五表：含运行时/智能体/工作流/阶段/任务的外键与阶段自引用。 */
function seedEntities(db: DatabaseSync): Omit<LegacySeed, 'runs'> {
  const runtimes: Runtime[] = [
    {
      id: 'rt-1',
      name: '本机 dsh',
      executorKey: 'dsh',
      argsTemplate: '',
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
      executorKey: 'dsh',
      argsTemplate: '',
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
      handoffWorkflowId: null,
      handoffStageId: null,
      instructions: '',
      gate: null,
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
      handoffWorkflowId: null,
      handoffStageId: null,
      instructions: '',
      gate: null,
    },
  ]
  const tasks: Task[] = [
    {
      id: 'tk-1',
      title: '做点什么',
      description: '',
      workflowId: 'wf-1',
      projectId: null,
      currentStageId: 'st-2',
      status: 'active',
      // M6：v2 存量导入后一律是手工任务
      origin: 'manual',
      ruleId: null,
      externalRef: null,
      labels: [],
      // M6.5：v2 没有线程概念
      threadId: null,
      parentTaskId: null,
      spawnedByRunId: null,
      batchNo: null,
      spawnKey: null,
      handoffFromTaskId: null,
      handoffFromStageId: null,
      gateFails: 0,
      createdAt: seedAt(6),
      updatedAt: seedAt(7),
    },
    {
      id: 'tk-2',
      title: '完成的事',
      description: '已归档',
      workflowId: 'wf-1',
      projectId: null,
      currentStageId: null,
      status: 'completed',
      origin: 'manual',
      ruleId: null,
      externalRef: null,
      labels: [],
      threadId: null,
      parentTaskId: null,
      spawnedByRunId: null,
      batchNo: null,
      spawnKey: null,
      handoffFromTaskId: null,
      handoffFromStageId: null,
      gateFails: 0,
      createdAt: seedAt(8),
      updatedAt: seedAt(9),
    },
  ]

  const insertRuntime = db.prepare(
    `INSERT INTO runtimes
       (id, name, executor_key, command, profile, args_template, permission_mode, model,
        reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const runtime of runtimes) {
    insertRuntime.run(
      runtime.id,
      runtime.name,
      runtime.executorKey,
      runtime.command,
      runtime.profile,
      runtime.argsTemplate,
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

/**
 * 造存量运行两表：只写 v2 就有的列（M2 新增列走 schema 默认值），
 * 模拟 M1 旧写路径留下的数据。
 */
function seedRuns(
  db: DatabaseSync,
  runs: readonly LegacyRunSeed[] = legacyRuns,
  events: readonly LegacyRunEventSeed[] = legacyRunEvents,
): void {
  const insertRun = db.prepare(
    `INSERT INTO runs
       (id, task_id, stage_id, agent_id, runtime_id, status, prompt, output, error, error_code,
        exit_code, session_id, usage_json, duration_ms, started_at, ended_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const run of runs) {
    insertRun.run(
      run.id,
      run.taskId,
      run.stageId,
      run.agentId,
      run.runtimeId,
      run.status,
      run.prompt,
      run.output,
      run.error,
      run.errorCode,
      run.exitCode,
      run.sessionId,
      run.usage === null ? null : JSON.stringify(run.usage),
      run.durationMs,
      run.startedAt,
      run.endedAt,
      run.createdAt,
    )
  }

  const insertEvent = db.prepare(
    `INSERT INTO run_events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
  for (const event of events) {
    insertEvent.run(
      event.runId,
      event.seq,
      event.type,
      JSON.stringify(event.payload),
      event.createdAt,
    )
  }
}

/** 造 v2 存量全量：实体五表 + 运行两表。 */
function seedRich(db: DatabaseSync): LegacySeed {
  const entities = seedEntities(db)
  seedRuns(db)
  return { ...entities, runs: expectedRuns() }
}

/**
 * 造一条「投影里遗留的卡片行」：v2 没有卡片事实，这里只验证导入语义会把它清掉
 * （首次迁移清表 / 补迁移后重建）。`run-1` 是 `seedRuns` 已写入的存量 run（外键成立）。
 */
function seedStrayCard(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO cards
       (id, run_id, task_id, conversation_id, title, text, options_json, key, version, status,
        delivery, delivery_ref, option_index, answered_by, answered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'card-legacy',
    'run-1',
    'tk-1',
    null,
    '旧卡',
    '',
    '[]',
    null,
    1,
    'open',
    'pending',
    null,
    null,
    null,
    null,
    seedAt(31),
    seedAt(31),
  )
}

/** 只造实体五表并完成首次迁移（得到「facts 非空」的库，模拟 M1 之后的库）。 */
function seedMigratedEntities(db: DatabaseSync): Omit<LegacySeed, 'runs'> {
  const entities = seedEntities(db)
  importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
  return entities
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
  // M10：v2 没有项目数据；键要补齐以匹配 `ProjectionTable` 全集
  projects: 0,
  runs: 0,
  run_events: 0,
  conversations: 0,
  messages: 0,
  cards: 0,
  rule_sets: 0,
  rule_fires: 0,
  // M6.5：v2 没有线程数据；键要补齐以匹配 `ProjectionTable` 全集
  threads: 0,
  // M7：v2 没有插件设置；键要补齐以匹配 `ProjectionTable` 全集
  plugin_settings: 0,
  // M8：v2 没有任务上下文 / 反馈；键要补齐以匹配 `ProjectionTable` 全集
  task_comments: 0,
})

describe('importLegacyIfNeeded', () => {
  it('v2 存量一次导入：实体五表 + runs/run_events 的事实、投影、元信息逐项正确', () => {
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
      projects: 0,
      tasks: 2,
      runs: 2,
      run_events: 5,
      conversations: 0,
      messages: 0,
      cards: 0,
      rule_sets: 0,
      rule_fires: 0,
      threads: 0,
      plugin_settings: 0,
      task_comments: 0,
    })

    const facts = allFacts(db)
    expect(facts.map((fact) => fact.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(facts.map((fact) => fact.type)).toEqual(Array(7).fill('snapshot.imported'))
    // 聊天两表在这个夹具里没有旧行：空表不产导入根（只写有行的表）
    expect(facts.map((fact) => (fact.payload as { table: string }).table)).toEqual([
      ...IMPORT_ORDER.filter((table) => table !== 'conversations' && table !== 'messages'),
    ])
    expect(facts.every((fact) => fact.cause === undefined)).toBe(true)
    expect(
      facts.every((fact) => fact.actor.kind === 'host' && fact.actor.via === 'reconcile'),
    ).toBe(true)
    expect(facts.every((fact) => fact.at === IMPORT_AT)).toBe(true)

    // 事实 payload 的 rows 与旧表实体逐行相等；运行两表按缺列默认值归一
    expect(payloadOf(facts, 'runtimes').rows).toEqual(legacy.runtimes)
    expect(payloadOf(facts, 'agents').rows).toEqual(legacy.agents)
    expect(payloadOf(facts, 'workflows').rows).toEqual(legacy.workflows)
    expect(payloadOf(facts, 'workflow_stages').rows).toEqual(legacy.workflow_stages)
    expect(payloadOf(facts, 'tasks').rows).toEqual(legacy.tasks)
    expect(payloadOf(facts, 'runs').rows).toEqual(expectedRuns())
    expect(payloadOf(facts, 'run_events').rows).toEqual(expectedRunEvents())

    // 投影与旧表逐行相等；差异只有三类归一：阶段 created_at、runs.attempt、事件 created_at
    const previousStages = before.workflow_stages as Array<Record<string, unknown>>
    const previousRuns = before.runs as Array<Record<string, unknown>>
    const previousEvents = before.run_events as Array<Record<string, unknown>>
    const expectedProjection = {
      ...before,
      workflow_stages: previousStages.map((row) => ({ ...row, created_at: IMPORT_AT })),
      runs: previousRuns.map((row) => ({ ...row, attempt: 1 })),
      run_events: previousEvents.map((row) => ({ ...row, created_at: IMPORT_AT })),
    }
    expect(dumpProjection(db)).toEqual(expectedProjection)
    // M6：v2 存量任务没有来源概念，导入后一律按手工任务落库
    expect(
      db.prepare('SELECT origin, rule_id, external_ref, labels_json FROM tasks ORDER BY id').all(),
    ).toEqual([
      { origin: 'manual', rule_id: null, external_ref: null, labels_json: '[]' },
      { origin: 'manual', rule_id: null, external_ref: null, labels_json: '[]' },
    ])
    // M6.5：v2 存量没有线程概念——线程两列按 null 落库（不属于线程、不是派生任务）
    expect(db.prepare('SELECT thread_id, parent_task_id FROM tasks ORDER BY id').all()).toEqual([
      { thread_id: null, parent_task_id: null },
      { thread_id: null, parent_task_id: null },
    ])
    expect(readProjectionMeta(db)).toEqual({
      format: projectionFormat(KERNEL_VERSION),
      seq: 7,
    })
  })

  it('存量 runs 行归一：业务列保留原值，缺的 M2 列补默认值', () => {
    const db = memory()
    seedRich(db)
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    const rows = db
      .prepare('SELECT * FROM runs ORDER BY created_at, rowid')
      .all() as unknown as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual(['run-1', 'run-2'])

    const expected = expectedRuns()
    rows.forEach((row, index) => {
      const run = expected[index]
      // v2 业务列逐项保留（状态、提示词、输出、错误归类、会话、用量、时间戳）
      expect(row).toMatchObject({
        id: run.id,
        task_id: run.taskId,
        stage_id: run.stageId,
        agent_id: run.agentId,
        runtime_id: run.runtimeId,
        status: run.status,
        prompt: run.prompt,
        output: run.output,
        error: run.error,
        error_code: run.errorCode,
        exit_code: run.exitCode,
        session_id: run.sessionId,
        duration_ms: run.durationMs,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        created_at: run.createdAt,
      })
      expect(row.usage_json).toBe(run.usage === null ? null : JSON.stringify(run.usage))
      // 缺列默认值（T2 口径）
      expect(row).toMatchObject({
        purpose: 'stage',
        conversation_id: null,
        rule_id: null,
        rules_version: 0,
        executor_key: '',
        thread_id: null,
        cwd: '',
        access: 'edit',
        skill: null,
        prompt_ref: null,
        event_ids_json: '[]',
        hops: 0,
        turn: 1,
        resume_session_id: null,
        thread_context_ref: null,
        queue_seq: 0,
        lease_id: null,
        attempt: 1,
        attempts: 0,
        lease_until: null,
        not_before: null,
        deadline_at: null,
        cancel_requested: 0,
      })
      // 状态保留：成功/失败两种存量状态都原样
      expect(row.status).toBe(run.status)
    })
  })

  it('run_events 保持原 (run_id, seq) 与 payload，created_at 归一到导入根时刻', () => {
    const db = memory()
    seedRich(db)
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    const rows = db
      .prepare(
        'SELECT run_id, seq, type, payload_json, created_at FROM run_events ORDER BY run_id, seq',
      )
      .all() as unknown as Array<Record<string, unknown>>

    expect(rows.map((row) => [row.run_id, row.seq])).toEqual([
      ['run-1', 1],
      ['run-1', 2],
      ['run-1', 3],
      ['run-2', 1],
      ['run-2', 2],
    ])
    rows.forEach((row, index) => {
      const seed = legacyRunEvents[index]
      expect(row.type).toBe(seed.type)
      expect(JSON.parse(String(row.payload_json))).toEqual(seed.payload)
      // 事件时间不进行类型：投影时间统一取导入根 at（重建后一致）
      expect(row.created_at).toBe(IMPORT_AT)
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
      seq: 7,
    })
  })

  it('超过 500 行按批次写多条事实', () => {
    const db = memory()
    const insert = db.prepare(
      'INSERT INTO runtimes (id, name, executor_key, created_at) VALUES (?, ?, ?, ?)',
    )
    const total = IMPORT_BATCH_SIZE + 1
    for (let index = 0; index < total; index++) {
      insert.run(`rt-${String(index).padStart(3, '0')}`, `运行时 ${index}`, 'dsh', seedAt(1))
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

  it('旧库遗留 cards 行：首次迁移按导入语义清空，不写卡片事实', () => {
    const db = memory()
    seedRich(db)
    seedStrayCard(db)
    expect(dumpProjection(db).cards).toHaveLength(1)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.counts.cards).toBe(0)
    expect(allFacts(db).some((fact) => fact.type.startsWith('card.'))).toBe(false)
    expect(dumpProjection(db).cards).toEqual([])
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
      projects: [],
      runs: [],
      run_events: [],
      conversations: [],
      messages: [],
      cards: [],
      rule_sets: [],
      rule_fires: [],
      threads: [],
      plugin_settings: [],
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
    expect(facts).toHaveLength(7)
    const at = facts[0]?.at ?? ''
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Number.isNaN(Date.parse(at))).toBe(false)
    expect(new Set(facts.map((fact) => fact.at)).size).toBe(1)
  })

  it('导入根在 timeline 标「迁移导入」，不伪造 cause（含运行 scope）', () => {
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

    // runs 与 run_events 两条导入根都落到同一个 run scope（基线两条，都不伪造因果）
    const runEntries = timeline(facts, 'run', 'run-1')
    expect(runEntries.map((entry) => (entry.fact.payload as { table: string }).table)).toEqual([
      'runs',
      'run_events',
    ])
    expect(runEntries.every((entry) => entry.imported && entry.label === IMPORT_ROOT_LABEL)).toBe(
      true,
    )
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
    const legacy = seedEntities(db)
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

  it('导入后 cards 非空：卡片校验失败整体回滚（v2 无卡片数据的防御断言）', () => {
    const db = memory()
    seedEntities(db)
    const ghostCard = sample.card({ id: 'card-ghost' })
    const noisyKernel = createFakeKernel({
      project: (fact) => {
        const changes = project(fact)
        if (
          fact.type === 'snapshot.imported' &&
          (fact.payload as { table?: string }).table === 'runtimes'
        ) {
          changes.push({ table: 'cards', key: ghostCard.id, row: ghostCard })
        }
        return changes
      },
    })
    const before = dumpProjection(db)

    expect(() => importLegacyIfNeeded(db, noisyKernel, { at: IMPORT_AT })).toThrow(
      /存量导入校验失败（cards）/,
    )
    expect(factsCount(db)).toBe(0)
    expect(readProjectionMeta(db)).toBeNull()
    expect(dumpProjection(db)).toEqual(before)
  })
})

describe('importLegacyIfNeeded：M2 升级补迁移（facts 非空）', () => {
  /** M1 之后的库：实体五表已导入成事实，运行两表仍是旧写路径留下的行。 */
  function migratedDb(): DatabaseSync {
    const db = memory()
    seedMigratedEntities(db)
    seedRuns(db)
    return db
  }

  it('只补 runs/run_events：事实追加、元信息留给重建，ensureProjection 重建后逐行一致', () => {
    const db = migratedDb()
    const before = dumpProjection(db)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.imported).toBe(true)
    expect(result.counts).toEqual({ ...emptyCounts(), runs: 2, run_events: 5 })
    const facts = allFacts(db)
    expect(facts).toHaveLength(7)
    expect(facts.map((fact) => (fact.payload as { table: string }).table)).toEqual([
      'runtimes',
      'agents',
      'workflows',
      'workflow_stages',
      'tasks',
      'runs',
      'run_events',
    ])
    expect(payloadOf(facts, 'runs').rows).toEqual(expectedRuns())
    expect(payloadOf(facts, 'run_events').rows).toEqual(expectedRunEvents())
    // 补迁移不落投影、不写元信息：投影保持旧行，元信息仍是首次迁移时写的 seq 5
    expect(dumpProjection(db)).toEqual(before)
    expect(readProjectionMeta(db)).toEqual({ format: projectionFormat(KERNEL_VERSION), seq: 5 })

    expect(ensureProjection(db, realKernel)).toEqual({ rebuilt: true })
    const previousStages = before.workflow_stages as Array<Record<string, unknown>>
    const previousRuns = before.runs as Array<Record<string, unknown>>
    const previousEvents = before.run_events as Array<Record<string, unknown>>
    expect(dumpProjection(db)).toEqual({
      ...before,
      workflow_stages: previousStages.map((row) => ({ ...row, created_at: IMPORT_AT })),
      runs: previousRuns.map((row) => ({ ...row, attempt: 1 })),
      run_events: previousEvents.map((row) => ({ ...row, created_at: IMPORT_AT })),
    })
    expect(readProjectionMeta(db)).toEqual({ format: projectionFormat(KERNEL_VERSION), seq: 7 })
  })

  it('旧库遗留 cards 行：补迁移不落投影，ensureProjection 重建后清空', () => {
    const db = migratedDb()
    seedStrayCard(db)
    expect(dumpProjection(db).cards).toHaveLength(1)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.counts.cards).toBe(0)
    expect(ensureProjection(db, realKernel)).toEqual({ rebuilt: true })
    expect(dumpProjection(db).cards).toEqual([])
  })

  it('补迁移幂等：已导入根 / 没有运行事实时都不重复导入', () => {
    const db = migratedDb()
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
    const factsBefore = allFacts(db)
    const dumpBefore = dumpProjection(db)

    // 第二次启动：事实里已有 runs/run_events 导入根 → no-op
    expect(importLegacyIfNeeded(db, realKernel, { at: '2026-03-03T00:00:00.000Z' })).toEqual({
      imported: false,
      counts: emptyCounts(),
    })
    expect(allFacts(db)).toEqual(factsBefore)
    expect(dumpProjection(db)).toEqual(dumpBefore)

    // 重建后再启动一次：仍 no-op（投影有数据，事实是唯一真相）
    rebuildProjection(db, realKernel)
    const rebuilt = dumpProjection(db)
    expect(importLegacyIfNeeded(db, realKernel)).toEqual({
      imported: false,
      counts: emptyCounts(),
    })
    expect(allFacts(db)).toEqual(factsBefore)
    expect(dumpProjection(db)).toEqual(rebuilt)
  })

  it('已有运行事实（run.queued）时不迁移：不把投影再导一遍', () => {
    const db = memory()
    seedMigratedEntities(db)
    seedRuns(db)
    const runFact: Fact = appendFacts(db, [
      {
        type: 'run.queued',
        actor: { kind: 'host', via: 'scheduler' },
        at: seedAt(40),
        payload: { run: normalizedRun(legacyRuns[0]) },
      },
    ])[0]
    const before = allFacts(db)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result).toEqual({ imported: false, counts: emptyCounts() })
    expect(allFacts(db)).toEqual(before)
    expect(
      allFacts(db).some((fact) => fact.seq === runFact.seq && fact.type === 'run.queued'),
    ).toBe(true)
  })

  it('facts 非空但 runs 表为空：不产事实（没有可迁移的行）', () => {
    const db = memory()
    seedMigratedEntities(db)
    const before = allFacts(db)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result).toEqual({ imported: false, counts: emptyCounts() })
    expect(allFacts(db)).toEqual(before)
  })

  it('补迁移不传 at：导入根时间取当前时刻（未指定选项）', () => {
    const db = migratedDb()
    const before = Date.now()
    const result = importLegacyIfNeeded(db, realKernel)
    const after = Date.now()

    expect(result.counts).toEqual({ ...emptyCounts(), runs: 2, run_events: 5 })
    // 前 5 条是实体五表的首次迁移根，后 2 条是本次补迁移的运行两表
    const backfilled = allFacts(db).slice(5)
    expect(backfilled.map((fact) => (fact.payload as { table: string }).table)).toEqual([
      'runs',
      'run_events',
    ])
    for (const fact of backfilled) {
      const at = Date.parse(fact.at)
      expect(at).toBeGreaterThanOrEqual(before)
      expect(at).toBeLessThanOrEqual(after)
    }
  })

  it('补迁移超过 500 行按批次写多条事实', () => {
    const db = memory()
    seedMigratedEntities(db)
    const total = IMPORT_BATCH_SIZE + 1
    const seeds: LegacyRunSeed[] = Array.from({ length: total }, (_, index) => ({
      ...legacyRuns[0],
      id: `run-batch-${String(index).padStart(3, '0')}`,
      createdAt: seedAt(50),
    }))
    seedRuns(db, seeds, [])

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.counts.runs).toBe(total)
    expect(result.counts.run_events).toBe(0)
    const runFacts = allFacts(db).filter(
      (fact) => (fact.payload as { table?: string }).table === 'runs',
    )
    expect(runFacts).toHaveLength(2)
    expect(payloadOf(runFacts, 'runs').rows).toHaveLength(IMPORT_BATCH_SIZE)
    expect((runFacts[1].payload as { rows: unknown[] }).rows).toHaveLength(1)
    expect(runFacts[1].seq).toBe(lastFactSeq(db))
  })
})

/** 最后一条事实的 seq（批次路径的序号断言）。 */
function lastFactSeq(db: DatabaseSync): number {
  return allFacts(db).at(-1)?.seq ?? 0
}

// ---------- T14b：旧聊天表迁移（chat_conversations / chat_messages → 导入根 → 删表） ----------

/** 按 T14b 之前的旧 DDL 建聊天两表并插一行对话 + 两条消息（schema 已不再创建它们）。 */
function seedLegacyChat(db: DatabaseSync): { conversationId: string; messageIds: string[] } {
  db.exec(`
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at TEXT NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO chat_conversations (id,title,agent_id,session_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run('cv-legacy', '旧对话', 'ag-1', 'sess-legacy', seedAt(10), seedAt(11))
  const insertMessage = db.prepare(
    `INSERT INTO chat_messages (id,conversation_id,role,content,error,created_at)
     VALUES (?,?,?,?,?,?)`,
  )
  insertMessage.run('msg-1', 'cv-legacy', 'user', '你好', null, seedAt(12))
  insertMessage.run('msg-2', 'cv-legacy', 'assistant', '在', '旧错误', seedAt(13))
  return { conversationId: 'cv-legacy', messageIds: ['msg-1', 'msg-2'] }
}

/** 旧聊天两表是否还在（迁移成功后应该被删除）。 */
function legacyChatTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('chat_conversations','chat_messages') ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name)
}

describe('importLegacyIfNeeded：旧聊天表迁移（T14b）', () => {
  it('首次迁移：聊天两表写成导入根、落投影，并删除旧表', () => {
    const db = memory()
    seedEntities(db)
    const seeded = seedLegacyChat(db)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.counts.conversations).toBe(1)
    expect(result.counts.messages).toBe(2)
    const tables = allFacts(db).map((fact) => (fact.payload as { table: string }).table)
    expect(tables).toContain('conversations')
    expect(tables).toContain('messages')

    const projection = dumpProjection(db)
    // dumpProjection 是投影表的原始行（列名为 snake_case）
    expect(projection.conversations).toEqual([
      {
        id: seeded.conversationId,
        title: '旧对话',
        agent_id: 'ag-1',
        session_id: 'sess-legacy',
        created_at: seedAt(10),
        updated_at: seedAt(11),
      },
    ])
    expect(projection.messages).toEqual([
      {
        id: 'msg-1',
        conversation_id: 'cv-legacy',
        role: 'user',
        content: '你好',
        error: null,
        created_at: seedAt(12),
      },
      {
        id: 'msg-2',
        conversation_id: 'cv-legacy',
        role: 'assistant',
        content: '在',
        error: '旧错误',
        created_at: seedAt(13),
      },
    ])
    // 数据已成事实根：旧表删除，再导一次 no-op
    expect(legacyChatTables(db)).toEqual([])
    expect(importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT }).imported).toBe(false)
  })

  it('M1 存量补迁移：facts 非空时补聊天导入根，ensureProjection 重建后可查', () => {
    const db = memory()
    seedEntities(db)
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
    seedLegacyChat(db)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.imported).toBe(true)
    expect(result.counts).toMatchObject({ conversations: 1, messages: 2 })
    expect(legacyChatTables(db)).toEqual([])
    // 补迁移不落投影：随后的 ensureProjection 按新事实重建
    expect(ensureProjection(db, realKernel)).toEqual({ rebuilt: true })
    const projection = dumpProjection(db)
    expect(projection.conversations).toHaveLength(1)
    expect(projection.messages).toHaveLength(2)
    // 再导一次幂等
    expect(importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT }).imported).toBe(false)
  })

  it('旧聊天表不存在：跳过、不产事实、不抛错', () => {
    const db = memory()
    seedEntities(db)

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    expect(result.counts.conversations).toBe(0)
    expect(result.counts.messages).toBe(0)
    const tables = allFacts(db).map((fact) => (fact.payload as { table: string }).table)
    expect(tables).not.toContain('conversations')
    expect(tables).not.toContain('messages')
    expect(legacyChatTables(db)).toEqual([])
  })

  it('已有聊天事实：跳过旧表补迁移，仍删旧表完成清理', () => {
    const db = memory()
    seedEntities(db)
    importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })
    seedLegacyChat(db)

    const chatFact = {
      type: 'conversation.created' as const,
      actor: { kind: 'owner' as const, via: 'ui' as const },
      at: IMPORT_AT,
      payload: {
        conversation: {
          id: 'cv-fact',
          title: '事实对话',
          agentId: 'ag-1',
          projectId: null,
          sessionId: null,
          createdAt: IMPORT_AT,
          updatedAt: IMPORT_AT,
        },
      },
    }
    appendFacts(db, [chatFact])
    const before = allFacts(db).length

    const result = importLegacyIfNeeded(db, realKernel, { at: IMPORT_AT })

    // 聊天事实已经存在：不再补迁移（不追加 conversations/messages 导入根）
    expect(result.imported).toBe(false)
    expect(result.counts).toMatchObject({ conversations: 0, messages: 0 })
    expect(allFacts(db)).toHaveLength(before)
    expect(legacyChatTables(db)).toEqual([])
  })
})
