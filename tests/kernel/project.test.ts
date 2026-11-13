// @vitest-environment node
import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Card,
  Conversation,
  Message,
  RunEventRow,
  RunRow,
  Runtime,
  RuntimeProbe,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { FactPayload, FactType } from '../../src/protocol/facts'
import { normalizeCard, normalizeTask, project } from '../../src/kernel/project'
import type { Change, Fact, Id, ProjectionRow, ProjectionTable } from '../../src/kernel/types'

const ACTOR = { kind: 'owner', via: 'ui' } as const
const AT = '2026-11-04T12:00:00.000Z'

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: 'd',
  createdAt: AT,
  ...over,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
  exits: {},
  judge: null,
  handoffs: [],
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  instructions: '',
  acceptance: [],
  runTimeoutMs: null,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  // 执行配置在智能体上（运行时只管连接）
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: AT,
  ...over,
})

const probe: RuntimeProbe = {
  state: 'ready',
  path: 'C:/bin/dsh.cmd',
  cliVersion: '1.0.0',
  protocolVersion: 1,
  pluginVersion: null,
  error: null,
  output: '',
  elapsedMs: 5,
  checkedAt: AT,
}

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  enabled: true,
  createdAt: AT,
  lastProbe: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-1',
  status: 'active',
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
  handoffFromRunId: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'queued',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: 'D:/work',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 0,
  prompt: '做点什么',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: null,
  endedAt: null,
  createdAt: AT,
  conversationId: null,
  leaseId: null,
  attempt: 0,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  ...over,
})

const runEvent = (over: Partial<RunEventRow> = {}): RunEventRow => ({
  runId: 'run-1',
  seq: 1,
  type: 'text',
  text: 'hi',
  ...over,
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'cv-1',
  title: '新对话',
  agentId: 'ag-1',
  projectId: null,
  sessionId: null,
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const message = (over: Partial<Message> = {}): Message => ({
  id: 'ms-1',
  conversationId: 'cv-1',
  role: 'user',
  content: '你好',
  error: null,
  createdAt: AT,
  ...over,
})

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '选一个',
  text: '做哪个？',
  kind: 'ask',
  options: ['甲', '乙'],
  key: 'pick',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const fact = <T extends FactType>(
  seq: number,
  type: T,
  payload: FactPayload<T>,
  cause?: number,
): Fact<T> => ({ seq, type, actor: ACTOR, at: AT, payload, cause })

const put = (table: ProjectionTable, row: ProjectionRow & { id: Id }): Change => ({
  table,
  key: row.id,
  row,
})

/** 显式键的 upsert（`run_events` 行没有 `id`）。 */
const putKeyed = (table: ProjectionTable, key: Id, row: ProjectionRow): Change => ({
  table,
  key,
  row,
})

const unset = (table: ProjectionTable, key: Id): Change => ({ table, key, row: null })

type Tables = Record<ProjectionTable, Map<Id, ProjectionRow>>

const emptyTables = (): Tables => ({
  tasks: new Map(),
  workflows: new Map(),
  workflow_stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  runs: new Map(),
  run_events: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  rule_sets: new Map(),
  rule_fires: new Map(),
  threads: new Map(),
  plugin_settings: new Map(),
  task_comments: new Map(),
  review_reports: new Map(),
})

/** 按 seq 顺序 fold 事实：投影应用器的最小等价实现（重建与实时写入共用路径）。 */
const fold = (facts: Fact[]): Tables => {
  const tables = emptyTables()
  for (const item of facts) {
    for (const change of project(item)) {
      const rows = tables[change.table]
      if (change.row === null) rows.delete(change.key)
      else rows.set(change.key, change.row)
    }
  }
  return tables
}

describe('kernel/project', () => {
  it('实体事实 upsert 对应行（五表）', () => {
    expect(project(fact(1, 'workflow.created', { workflow: workflow() }))).toEqual([
      put('workflows', workflow()),
    ])
    expect(
      project(fact(2, 'workflow.updated', { workflow: workflow({ name: '研发v2' }) })),
    ).toEqual([put('workflows', workflow({ name: '研发v2' }))])
    expect(project(fact(3, 'stage.created', { stage: stage() }))).toEqual([
      put('workflow_stages', stage()),
    ])
    expect(
      project(fact(4, 'stage.updated', { stage: stage({ position: 2, entryMode: 'agent' }) })),
    ).toEqual([put('workflow_stages', stage({ position: 2, entryMode: 'agent' }))])
    expect(project(fact(5, 'agent.created', { agent: agent() }))).toEqual([put('agents', agent())])
    expect(project(fact(6, 'agent.updated', { agent: agent({ name: '新名字' }) }))).toEqual([
      put('agents', agent({ name: '新名字' })),
    ])
    expect(project(fact(7, 'runtime.created', { runtime: runtime() }))).toEqual([
      put('runtimes', runtime()),
    ])
    expect(project(fact(8, 'runtime.updated', { runtime: runtime({ enabled: false }) }))).toEqual([
      put('runtimes', runtime({ enabled: false })),
    ])
    expect(project(fact(9, 'runtime.probed', { runtime: runtime({ lastProbe: probe }) }))).toEqual([
      put('runtimes', runtime({ lastProbe: probe })),
    ])
    expect(project(fact(10, 'task.created', { task: task() }))).toEqual([put('tasks', task())])
    expect(
      project(
        fact(11, 'task.moved', {
          task: task({ currentStageId: 'st-2' }),
          from: 'st-1',
          to: 'st-2',
        }),
      ),
    ).toEqual([put('tasks', task({ currentStageId: 'st-2' }))])
    expect(project(fact(12, 'task.completed', { task: task({ status: 'completed' }) }))).toEqual([
      put('tasks', task({ status: 'completed' })),
    ])
    // M10：删项目时遗留任务归默认目录 —— 整行更新，阶段不动
    expect(project(fact(20, 'task.updated', { task: task({ projectId: null }) }))).toEqual([
      put('tasks', task({ projectId: null })),
    ])
    // M7.5：任务上下文 / 反馈是独立投影行（纯追加），任务行不动
    expect(
      project(
        fact(18, 'task.comment_added', {
          comment: {
            id: 'tc-1',
            taskId: 'task-1',
            author: 'owner',
            text: '按钮改成粉色',
            createdAt: '2026-11-05T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual([
      put('task_comments', {
        id: 'tc-1',
        taskId: 'task-1',
        author: 'owner',
        text: '按钮改成粉色',
        createdAt: '2026-11-05T00:00:00.000Z',
      }),
    ])
    // M8：子任务全部结束是审计事实，不写投影
    expect(
      project(
        fact(19, 'task.children_settled', {
          parentTaskId: 'task-1',
          childIds: ['task-2'],
          batchNo: null,
          action: 'wake',
        }),
      ),
    ).toEqual([])
  })

  it('删除类事实的 payload 行就是 tombstone，投影写 row:null', () => {
    const removedWorkflow = workflow()
    const deletedStage = stage()
    const removedAgent = agent()
    const removedRuntime = runtime({ lastProbe: probe })
    const removedTask = task()

    expect(project(fact(13, 'workflow.removed', { workflow: removedWorkflow }))).toEqual([
      unset('workflows', removedWorkflow.id),
    ])
    expect(project(fact(14, 'stage.deleted', { stage: deletedStage }))).toEqual([
      unset('workflow_stages', deletedStage.id),
    ])
    expect(project(fact(15, 'agent.removed', { agent: removedAgent }))).toEqual([
      unset('agents', removedAgent.id),
    ])
    expect(project(fact(16, 'runtime.removed', { runtime: removedRuntime }))).toEqual([
      unset('runtimes', removedRuntime.id),
    ])
    expect(project(fact(17, 'task.removed', { task: removedTask }))).toEqual([
      unset('tasks', removedTask.id),
    ])
  })

  it('snapshot.imported 按 payload.table 批量 upsert', () => {
    expect(
      project(
        fact(18, 'snapshot.imported', {
          table: 'workflows',
          rows: [workflow(), workflow({ id: 'wf-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('workflows', workflow()), put('workflows', workflow({ id: 'wf-2' }))])
    expect(
      project(
        fact(19, 'snapshot.imported', {
          table: 'workflow_stages',
          rows: [stage(), stage({ id: 'st-2', position: 1 })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([
      put('workflow_stages', stage()),
      put('workflow_stages', stage({ id: 'st-2', position: 1 })),
    ])
    expect(
      project(
        fact(20, 'snapshot.imported', {
          table: 'tasks',
          rows: [task(), task({ id: 't-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('tasks', task()), put('tasks', task({ id: 't-2' }))])
    expect(
      project(
        fact(21, 'snapshot.imported', {
          table: 'agents',
          rows: [agent(), agent({ id: 'ag-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('agents', agent()), put('agents', agent({ id: 'ag-2' }))])
    expect(
      project(
        fact(22, 'snapshot.imported', {
          table: 'runtimes',
          rows: [runtime(), runtime({ id: 'rt-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('runtimes', runtime()), put('runtimes', runtime({ id: 'rt-2' }))])
  })

  it('重建可重放：同一事实序列 fold 两次结果全等', () => {
    const facts: Fact[] = [
      fact(1, 'snapshot.imported', {
        table: 'workflows',
        rows: [workflow()],
        importedFrom: 'v2',
      }),
      fact(2, 'snapshot.imported', {
        table: 'workflow_stages',
        rows: [stage()],
        importedFrom: 'v2',
      }),
      fact(3, 'snapshot.imported', { table: 'runtimes', rows: [runtime()], importedFrom: 'v2' }),
      fact(4, 'snapshot.imported', { table: 'agents', rows: [agent()], importedFrom: 'v2' }),
      fact(5, 'snapshot.imported', { table: 'tasks', rows: [task()], importedFrom: 'v2' }),
      fact(6, 'stage.created', {
        stage: stage({ id: 'st-2', position: 1, name: '进行中' }),
      }),
      fact(7, 'task.moved', {
        task: task({ currentStageId: 'st-2' }),
        from: 'st-1',
        to: 'st-2',
      }),
      fact(8, 'task.completed', { task: task({ currentStageId: 'st-2', status: 'completed' }) }),
      fact(9, 'stage.deleted', { stage: stage() }),
    ]

    const first = fold(facts)
    const second = fold(facts)

    expect(second).toEqual(first)
    expect(first.workflows.get('wf-1')).toEqual(workflow())
    expect(first.workflow_stages.get('st-1')).toBeUndefined()
    expect(first.workflow_stages.get('st-2')).toEqual(
      stage({ id: 'st-2', position: 1, name: '进行中' }),
    )
    expect(first.tasks.get('t-1')).toEqual(task({ currentStageId: 'st-2', status: 'completed' }))
    expect(first.agents.get('ag-1')).toEqual(agent())
    expect(first.runtimes.get('rt-1')).toEqual(runtime())
  })

  it('删除后再次 upsert 与顺序无关地覆盖同一行（破坏性顺序）', () => {
    const facts: Fact[] = [
      fact(1, 'task.created', { task: task() }),
      fact(2, 'task.removed', { task: task() }),
      fact(3, 'task.created', { task: task({ title: '重建' }) }),
    ]

    const tables = fold(facts)

    expect(tables.tasks.size).toBe(1)
    expect(tables.tasks.get('t-1')).toEqual(task({ title: '重建' }))
  })
})

describe('kernel/project：运行事实', () => {
  it('run.queued：整行 upsert，queueSeq 用事实 seq 回填', () => {
    const row = run({ queueSeq: 0 })

    expect(project(fact(30, 'run.queued', { run: row }))).toEqual([
      put('runs', run({ queueSeq: 30 })),
    ])
  })

  it('其余 run 状态事实：payload.run 整行 upsert（不需要合并旧行）', () => {
    const claimed = run({
      status: 'running',
      leaseId: 'run-1:1',
      attempt: 1,
      leaseUntil: '2026-11-04T12:02:00.000Z',
      deadlineAt: '2026-11-04T12:30:00.000Z',
      startedAt: AT,
    })
    expect(project(fact(31, 'run.claimed', { run: claimed }))).toEqual([put('runs', claimed)])

    const extended = { ...claimed, leaseUntil: '2026-11-04T12:04:00.000Z' }
    expect(project(fact(32, 'run.lease_extended', { run: extended }))).toEqual([
      put('runs', extended),
    ])

    const waiting = run({ status: 'waiting', turn: 2, leaseId: null, leaseUntil: null })
    expect(project(fact(33, 'run.waiting', { run: waiting, cardIds: ['card-1'] }))).toEqual([
      put('runs', waiting),
    ])

    const abandoned = run({
      status: 'queued',
      attempts: 1,
      notBefore: '2026-11-04T12:10:00.000Z',
    })
    expect(project(fact(34, 'run.abandoned', { run: abandoned }))).toEqual([put('runs', abandoned)])

    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
    }
    const running = run({ status: 'running', usage })
    expect(project(fact(35, 'run.usage', { run: running }))).toEqual([put('runs', running)])

    const cancelled = run({ status: 'cancelled', cancelRequested: true, endedAt: AT })
    expect(project(fact(36, 'run.cancel_requested', { run: cancelled, by: 'owner' }))).toEqual([
      put('runs', cancelled),
    ])
    expect(project(fact(37, 'run.cancelled', { run: cancelled }))).toEqual([put('runs', cancelled)])

    const failed = run({
      status: 'failed',
      error: '超时',
      errorCode: 'timeout',
      endedAt: AT,
    })
    expect(project(fact(38, 'run.failed', { run: failed }))).toEqual([put('runs', failed)])

    const succeeded = run({ status: 'succeeded', output: '完成', endedAt: AT })
    expect(project(fact(39, 'run.succeeded', { run: succeeded }))).toEqual([put('runs', succeeded)])
  })

  it('run.frames：逐帧追加，Change.key = <runId>:<seq>', () => {
    const frames = [
      runEvent({ seq: 1, type: 'status', status: 'running' }),
      runEvent({ seq: 2, type: 'text', text: 'ok' }),
      runEvent({ runId: 'run-2', seq: 1, type: 'text', text: '另一 run' }),
    ]

    expect(project(fact(40, 'run.frames', { runId: 'run-1', turn: 1, frames }))).toEqual([
      putKeyed('run_events', 'run-1:1', frames[0]),
      putKeyed('run_events', 'run-1:2', frames[1]),
      putKeyed('run_events', 'run-2:1', frames[2]),
    ])
  })

  it('run.receipt_rejected 只审计、无投影变更', () => {
    expect(
      project(
        fact(41, 'run.receipt_rejected', {
          runId: 'run-1',
          leaseId: 'run-1:1',
          turn: 2,
          reason: 'stale_lease',
        }),
      ),
    ).toEqual([])
  })

  it('run.removed 只删 runs 行；run_events 由宿主按 run_id 联删', () => {
    expect(project(fact(42, 'run.removed', { runId: 'run-1' }))).toEqual([unset('runs', 'run-1')])
  })
})

describe('kernel/project：对话与消息', () => {
  it('conversation.created / updated：整行 upsert', () => {
    expect(project(fact(50, 'conversation.created', { conversation: conversation() }))).toEqual([
      put('conversations', conversation()),
    ])
    expect(
      project(
        fact(51, 'conversation.updated', {
          conversation: conversation({ title: '改名', sessionId: 's-1', updatedAt: AT }),
        }),
      ),
    ).toEqual([
      put('conversations', conversation({ title: '改名', sessionId: 's-1', updatedAt: AT })),
    ])
  })

  it('conversation.created / updated：projectId 原样保留（M11 会话挂在项目上）', () => {
    expect(
      project(
        fact(55, 'conversation.created', { conversation: conversation({ projectId: 'pj-1' }) }),
      ),
    ).toEqual([put('conversations', conversation({ projectId: 'pj-1' }))])
    expect(
      project(
        fact(56, 'conversation.updated', {
          conversation: conversation({ projectId: null, updatedAt: AT }),
        }),
      ),
    ).toEqual([put('conversations', conversation({ projectId: null, updatedAt: AT }))])
  })

  it('conversation.created / updated：老事实缺 projectId 时归一为 null（默认目录）', () => {
    const legacy = { ...conversation(), projectId: undefined } as unknown as Conversation
    expect(project(fact(57, 'conversation.created', { conversation: legacy }))).toEqual([
      put('conversations', conversation()),
    ])
    expect(project(fact(58, 'conversation.updated', { conversation: legacy }))).toEqual([
      put('conversations', conversation()),
    ])
  })

  it('conversation.removed：只删 conversations 行；messages 由宿主按 conversation_id 联删', () => {
    expect(project(fact(52, 'conversation.removed', { conversation: conversation() }))).toEqual([
      unset('conversations', 'cv-1'),
    ])
  })

  it('message.appended：createdAt 取事实 at，error 缺省为 null', () => {
    expect(
      project(
        fact(53, 'message.appended', {
          conversationId: 'cv-1',
          messageId: 'ms-1',
          role: 'user',
          content: '你好',
        }),
      ),
    ).toEqual([put('messages', message())])

    expect(
      project(
        fact(54, 'message.appended', {
          conversationId: 'cv-1',
          messageId: 'ms-2',
          role: 'assistant',
          content: '',
          runId: 'run-1',
          error: '超时',
        }),
      ),
    ).toEqual([
      put('messages', message({ id: 'ms-2', role: 'assistant', content: '', error: '超时' })),
    ])
  })
})

describe('kernel/project：四张新表的 snapshot.imported', () => {
  it('runs 按行 upsert（queueSeq 缺省由宿主补）', () => {
    expect(
      project(
        fact(60, 'snapshot.imported', {
          table: 'runs',
          rows: [run({ queueSeq: 0 }), run({ id: 'run-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([put('runs', run({ queueSeq: 0 })), put('runs', run({ id: 'run-2' }))])
  })

  it('run_events 按 (runId,seq) 拼 key', () => {
    expect(
      project(
        fact(61, 'snapshot.imported', {
          table: 'run_events',
          rows: [
            runEvent({ seq: 1 }),
            runEvent({ runId: 'run-2', seq: 1, type: 'status', status: 'running' }),
          ],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([
      putKeyed('run_events', 'run-1:1', runEvent({ seq: 1 })),
      putKeyed(
        'run_events',
        'run-2:1',
        runEvent({ runId: 'run-2', seq: 1, type: 'status', status: 'running' }),
      ),
    ])
  })

  it('conversations / messages 按 id upsert', () => {
    expect(
      project(
        fact(62, 'snapshot.imported', {
          table: 'conversations',
          rows: [conversation(), conversation({ id: 'cv-2' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([
      put('conversations', conversation()),
      put('conversations', conversation({ id: 'cv-2' })),
    ])
    expect(
      project(
        fact(63, 'snapshot.imported', {
          table: 'messages',
          rows: [message(), message({ id: 'ms-2', role: 'assistant' })],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([
      put('messages', message()),
      put('messages', message({ id: 'ms-2', role: 'assistant' })),
    ])
  })
})

describe('kernel/project：卡片与派生事件（M4）', () => {
  it('card.* 六条事实一律整行 upsert 到 cards', () => {
    expect(project(fact(70, 'card.opened', { card: card() }))).toEqual([put('cards', card())])

    const updated = card({ version: 2, title: '再选一个', updatedAt: AT })
    expect(
      project(fact(71, 'card.updated', { card: updated, changes: ['title', 'version'] })),
    ).toEqual([put('cards', updated)])

    const delivered = card({ delivery: 'delivered', deliveryRef: 'in-app' })
    expect(project(fact(72, 'card.delivered', { card: delivered, ref: 'in-app' }))).toEqual([
      put('cards', delivered),
    ])

    const failed = card({ delivery: 'failed' })
    expect(project(fact(73, 'card.delivery_failed', { card: failed, error: '通知失败' }))).toEqual([
      put('cards', failed),
    ])

    const answered = card({
      status: 'answered',
      optionIndex: 1,
      answeredBy: 'channel',
      answeredAt: AT,
    })
    expect(project(fact(74, 'card.answered', { card: answered, by: 'channel' }))).toEqual([
      put('cards', answered),
    ])

    const resolved = card({ status: 'resolved' })
    expect(project(fact(75, 'card.resolved', { card: resolved, reason: 'agent' }))).toEqual([
      put('cards', resolved),
    ])
  })

  it('event.received / event.dropped 无投影：返回空变更', () => {
    expect(
      project(
        fact(80, 'event.received', {
          eventId: 'ev-1',
          source: 'agent',
          type: 'issues.opened',
          subject: 'issue-1',
          summary: '新 issue',
          detailRef: 'artifacts/ev-1.md',
          link: null,
          hops: 1,
          originRunId: 'run-1',
          dedupeKey: 'issue-1',
        }),
      ),
    ).toEqual([])
    expect(
      project(fact(81, 'event.dropped', { eventId: 'ev-2', hops: 9, reason: 'max_hops' })),
    ).toEqual([])
  })

  it('老事实缺 kind：按「有选项 = ask / 无选项 = notice」归一（M12）', () => {
    const legacyAsk = card()
    const legacyNotice = card({ options: [], title: '已刷新依赖' })
    const noticeCard = card({ options: [], title: '已刷新依赖', kind: 'notice' })
    const withoutKind = (row: Card): Card => {
      const copy = { ...row } as Partial<Card>
      delete copy.kind
      return copy as Card
    }

    expect(project(fact(80, 'card.opened', { card: withoutKind(legacyAsk) }))).toEqual([
      put('cards', legacyAsk),
    ])
    expect(project(fact(81, 'card.opened', { card: withoutKind(legacyNotice) }))).toEqual([
      put('cards', noticeCard),
    ])
    // 已有 kind 的行原样保留，不被重新推断
    expect(
      project(fact(82, 'card.opened', { card: card({ kind: 'notice', options: ['甲'] }) })),
    ).toEqual([put('cards', card({ kind: 'notice', options: ['甲'] }))])
  })

  it('重建 fold 卡片事实后 cards 表与最后一行全等', () => {
    const facts: Fact[] = [
      fact(90, 'card.opened', { card: card() }),
      fact(91, 'card.delivered', { card: card({ delivery: 'delivered' }), ref: 'in-app' }),
      fact(92, 'card.answered', {
        card: card({
          delivery: 'delivered',
          status: 'answered',
          optionIndex: 0,
          answeredBy: 'ui',
          answeredAt: AT,
        }),
        by: 'ui',
      }),
    ]

    const tables = fold(facts)

    expect(tables.cards.size).toBe(1)
    expect(tables.cards.get('card-1')).toEqual(
      card({
        status: 'answered',
        optionIndex: 0,
        answeredBy: 'ui',
        answeredAt: AT,
        delivery: 'delivered',
      }),
    )
  })

  it('规则事实：rules.replaced 整行 upsert，rule.fired 追加 rule_fires', () => {
    const ruleSet = {
      id: 'current' as const,
      version: 2,
      replacedAt: AT,
      rules: [
        {
          id: 'rule-1',
          name: '每日早报',
          when: { cron: '0 9 * * *' as const },
          to: { workflowId: 'wf-1' },
          enabled: true,
        },
      ],
    }
    expect(project(fact(100, 'rules.replaced', { ruleSet }))).toEqual([put('rule_sets', ruleSet)])

    const fire = {
      id: 'fire-1',
      ruleId: 'rule-1',
      version: 2,
      scheduledFor: AT,
      firedAt: AT,
      taskId: null,
    }
    expect(project(fact(101, 'rule.fired', { fire }))).toEqual([put('rule_fires', fire)])
  })

  it('M6 老事实 replay：任务行缺 origin/ruleId/externalRef/labels 时补默认值', () => {
    const legacy = {
      id: 't-1',
      title: '老任务',
      description: '',
      workflowId: 'wf-1',
      currentStageId: 'st-1',
      status: 'active',
      createdAt: AT,
      updatedAt: AT,
    } as unknown as Task
    const changes = project(fact(102, 'task.created', { task: legacy }))
    expect(changes).toEqual([
      {
        table: 'tasks',
        key: 't-1',
        row: {
          ...legacy,
          origin: 'manual',
          ruleId: null,
          externalRef: null,
          labels: [],
          projectId: null,
          threadId: null,
          parentTaskId: null,
          spawnedByRunId: null,
          batchNo: null,
          spawnKey: null,
          handoffFromTaskId: null,
          handoffFromStageId: null,
          handoffFromRunId: null,
        },
      },
    ])
  })

  it('M6.5 线程事实：整行 upsert；event.merged 更新 runs 行', () => {
    const threadRow = {
      id: 'th-1',
      source: 'github',
      externalRef: 'issue-1',
      title: 'Issue 1',
      status: 'open' as const,
      taskIds: ['t-1'],
      rootTaskIds: ['t-1'],
      concurrency: 1,
      notesVersion: 1,
      notes: [{ id: 'n-1', author: 'agent' as const, text: '备注', at: AT }],
      events: [],
      lastActivityAt: AT,
      createdAt: AT,
    }
    expect(project(fact(200, 'thread.opened', { thread: threadRow }))).toEqual([
      put('threads', threadRow),
    ])
    const noted = { ...threadRow, notesVersion: 2 }
    expect(
      project(
        fact(201, 'thread.note_appended', {
          thread: noted,
          note: { id: 'n-2', author: 'owner' as const, text: '补一条', at: AT },
        }),
      ),
    ).toEqual([put('threads', noted)])
    const closed = { ...threadRow, status: 'closed' as const }
    expect(
      project(fact(202, 'thread.closed', { thread: closed, reason: 'manual' as const })),
    ).toEqual([put('threads', closed)])

    const merged = run({ eventIds: ['ev-1'] })
    expect(project(fact(203, 'event.merged', { run: merged, eventId: 'ev-1' }))).toEqual([
      put('runs', merged),
    ])
  })

  it('M14 评审事实：review.reported / review.addressed 一律整行 upsert 到 review_reports', () => {
    const row = {
      id: 'run-1:1',
      taskId: 't-1',
      stageId: 'st-1',
      runId: 'run-1',
      threadId: null,
      rev: 1,
      verdict: 'fail' as const,
      checks: [{ cmd: 'pnpm check', exitCode: 1 }],
      findings: [],
      artifact: null,
      createdAt: AT,
      updatedAt: AT,
    }
    expect(project(fact(300, 'review.reported', { report: row }))).toEqual([
      put('review_reports', row),
    ])
    const addressedRow = {
      ...row,
      findings: [
        {
          id: 'run-1:1#R1',
          key: 'R1',
          severity: 'high' as const,
          location: null,
          claim: '断言',
          evidence: null,
          requiredAction: '复跑',
          status: 'addressed' as const,
          note: null,
          addressedByRunId: 'run-2',
          updatedAt: AT,
        },
      ],
      updatedAt: AT,
    }
    expect(
      project(fact(301, 'review.addressed', { report: addressedRow, addressed: ['run-1:1#R1'] })),
    ).toEqual([put('review_reports', addressedRow)])
  })

  it('M6 存量导入：snapshot.imported 的 tasks 行同样归一', () => {
    const legacy = {
      id: 't-2',
      title: '导入任务',
      description: '',
      workflowId: 'wf-1',
      currentStageId: null,
      status: 'completed',
      createdAt: AT,
      updatedAt: AT,
    } as unknown as Task
    const changes = project(
      fact(103, 'snapshot.imported', { table: 'tasks', rows: [legacy], importedFrom: 'v2' }),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.row).toMatchObject({
      origin: 'manual',
      ruleId: null,
      externalRef: null,
      labels: [],
    })
  })
})

describe('kernel/project：项目（M10）', () => {
  const row = {
    id: 'pj-1',
    name: '工作台',
    path: 'D:/work',
    description: '',
    createdAt: AT,
    updatedAt: AT,
  }

  it('project.created / project.updated 整行 upsert，project.removed 删除行', () => {
    expect(project(fact(1, 'project.created', { project: row }))).toEqual([put('projects', row)])
    expect(project(fact(2, 'project.updated', { project: { ...row, name: '改名' } }))).toEqual([
      put('projects', { ...row, name: '改名' }),
    ])
    expect(project(fact(3, 'project.removed', { project: row }))).toEqual([
      unset('projects', 'pj-1'),
    ])
  })

  it('老任务事实缺 projectId：按 null 归一（界面归入未归属）', () => {
    const legacy = { ...task() } as Record<string, unknown>
    delete legacy.projectId
    const changes = project(fact(4, 'task.created', { task: legacy as unknown as Task }))
    expect((changes[0]?.row as Task).projectId).toBeNull()
  })
})

describe('kernel/project stage 归一（M29 派单）', () => {
  it('老事实缺 handoffs：按 M7 两列归一成「跑完 + 人工往前」两条', () => {
    // 老事实根本没有 handoffs 这个字段：删掉再回放
    const legacy = {
      ...stage(),
      handoffWorkflowId: 'wf-b',
      handoffStageId: 'st-b1',
    } as unknown as Record<string, unknown>
    delete legacy.handoffs

    const changes = project(fact(5, 'stage.created', { stage: legacy as unknown as WorkflowStage }))
    const row = changes[0]?.row as WorkflowStage

    expect(row.handoffs).toEqual([
      { on: 'done', workflowId: 'wf-b', stageId: 'st-b1' },
      { on: 'manual', workflowId: 'wf-b', stageId: 'st-b1', forwardOnly: true },
    ])
  })

  it('老事实的判定阶段：老交接折算成「通过 + 人工往前」', () => {
    const legacy = {
      ...stage({ judge: { maxFails: 2 }, exits: {} }),
      handoffWorkflowId: 'wf-b',
      handoffStageId: null,
    } as unknown as Record<string, unknown>
    delete legacy.handoffs

    const row = project(fact(6, 'stage.created', { stage: legacy as unknown as WorkflowStage }))[0]
      ?.row as WorkflowStage

    expect(row.handoffs?.map((item) => item.on)).toEqual(['passed', 'manual'])
  })

  it('新事实带 handoffs：原样保留，不再看老两列', () => {
    const next = stage({
      handoffs: [{ on: 'errored', workflowId: 'wf-b', stageId: null }],
    })

    const row = project(fact(7, 'stage.created', { stage: next }))[0]?.row as WorkflowStage

    expect(row.handoffs).toEqual([{ on: 'errored', workflowId: 'wf-b', stageId: null }])
  })
})

// —— 性质测试（fast-check）：老事实归一的幂等性 ————————————————————————————————
//
// `normalizeTask` / `normalizeCard` 把老 payload 缺的列补成默认值。漏一个键，重建出来的
// 投影列就是 `undefined`（写库报错或读成脏行）；示例用例只覆盖人想到的那几个老版本。
// 这里随机删掉任意子集的老字段，断言：
// ① `normalize(normalize(x)) = normalize(x)`（重放老事实与二次重建同结果）；
// ② 每个老字段都补上了值，已有值一个不改；③ 卡片的 `kind` 只按「有没有选项」兜底。
// 固定种子，反例可复现（`FC_SEED` 换一批）。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261113)
const PROPERTY_RUNS = 100

const NULLABLE_ID_FIELDS = ['projectId', 'ruleId', 'externalRef', 'threadId'] as const

const TASK_LEGACY_FIELDS = [
  'origin',
  'ruleId',
  'externalRef',
  'labels',
  'projectId',
  'threadId',
  'parentTaskId',
  'spawnedByRunId',
  'batchNo',
  'spawnKey',
  'handoffFromTaskId',
  'handoffFromStageId',
  'handoffFromRunId',
] as const

const nullableIdArb = fc.oneof(fc.constant<string | null>(null), fc.constantFrom('t-1', 'r-1'))

const taskRowArb: Arbitrary<Task> = fc
  .record({
    id: fc.constantFrom('t-1', 't-2'),
    title: fc.string({ maxLength: 6 }),
    description: fc.string({ maxLength: 6 }),
    workflowId: fc.constant('wf-1'),
    projectId: nullableIdArb,
    currentStageId: fc.oneof(fc.constant<string | null>(null), fc.constant('st-1')),
    status: fc.constantFrom<Task['status']>('active', 'completed'),
    origin: fc.constantFrom<Task['origin']>('manual', 'rule', 'handoff', 'spawn'),
    ruleId: nullableIdArb,
    externalRef: nullableIdArb,
    labels: fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
    threadId: nullableIdArb,
    parentTaskId: nullableIdArb,
    spawnedByRunId: nullableIdArb,
    batchNo: fc.oneof(fc.constant<number | null>(null), fc.integer({ min: 1, max: 3 })),
    spawnKey: nullableIdArb,
    handoffFromTaskId: nullableIdArb,
    handoffFromStageId: nullableIdArb,
    handoffFromRunId: nullableIdArb,
    createdAt: fc.constant(AT),
    updatedAt: fc.constant(AT),
  })
  .map((row) => row as unknown as Task)

/** 随机删掉若干老字段：模拟 M6–M10 各版本遗留的 payload。 */
const partialTaskRowArb: Arbitrary<Task> = fc
  .tuple(taskRowArb, fc.subarray([...TASK_LEGACY_FIELDS]))
  .map(([row, missing]) => {
    const copy: Record<string, unknown> = { ...row }
    for (const field of missing) delete copy[field]
    return copy as unknown as Task
  })

const partialCardRowArb: Arbitrary<Card> = fc
  .tuple(
    fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
    fc.boolean(),
    fc.constantFrom<Card['status']>('open', 'answered', 'resolved'),
  )
  .map(([options, dropKind, status]) => {
    const row: Record<string, unknown> = { ...card({ options, status }) }
    if (dropKind) delete row.kind
    return row as unknown as Card
  })

describe('老事实归一的性质（fast-check 随机生成）', () => {
  it('normalizeTask 幂等：重放老事实与二次重建结果相同', () => {
    fc.assert(
      fc.property(partialTaskRowArb, (row) => {
        const once = normalizeTask(row)
        expect(normalizeTask(once)).toEqual(once)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('normalizeTask 补齐所有老字段，已有值一个不改', () => {
    fc.assert(
      fc.property(partialTaskRowArb, (row) => {
        const before = row as Partial<Task>
        const after = normalizeTask(row) as unknown as Record<string, unknown>
        for (const field of TASK_LEGACY_FIELDS) expect(after[field]).toBeDefined()
        expect(Array.isArray(after.labels)).toBe(true)
        for (const [key, value] of Object.entries(before)) {
          if (value === undefined) continue
          expect(after[key]).toEqual(value)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('normalizeTask 的缺省值与契约一致（origin / labels / 可空 id）', () => {
    fc.assert(
      fc.property(partialTaskRowArb, (row) => {
        const before = row as Partial<Task>
        const after = normalizeTask(row)
        if (before.origin === undefined) expect(after.origin).toBe('manual')
        if (before.labels === undefined) expect(after.labels).toEqual([])
        for (const field of NULLABLE_ID_FIELDS) {
          if (before[field] === undefined) expect(after[field]).toBeNull()
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('normalizeCard 幂等；kind 缺失时按「有没有选项」兜底，有值时原样保留', () => {
    fc.assert(
      fc.property(partialCardRowArb, (row) => {
        const once = normalizeCard(row)
        expect(normalizeCard(once)).toEqual(once)
        const original = (row as Partial<Card>).kind
        if (original === undefined) {
          expect(once.kind).toBe(row.options.length > 0 ? 'ask' : 'notice')
        } else {
          expect(once.kind).toBe(original)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('normalizeCard 不动其它字段（选项与状态原样带过）', () => {
    fc.assert(
      fc.property(partialCardRowArb, (row) => {
        const after = normalizeCard(row)
        expect(after.options).toEqual(row.options)
        expect(after.status).toBe(row.status)
        expect(after.id).toBe(row.id)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})
