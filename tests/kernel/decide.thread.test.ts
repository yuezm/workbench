import { describe, expect, it } from 'vitest'
import type {
  Agent,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { ThreadRow } from '../../src/protocol/thread'
import type {
  Decision,
  Environment,
  FactDraft,
  Id,
  IdKind,
  Limits,
  View,
} from '../../src/kernel/types'
import { decide } from '../../src/kernel/decide'

const CREATED = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-05T09:00:00.000Z'
const OWNER = { kind: 'owner', via: 'ui' } as const

const LIMITS: Limits = {
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
}

const env = (): Environment => {
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
  ...over,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '实现',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffWorkflowId: null,
  handoffStageId: null,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  // 执行配置在智能体上（运行时只管连接）
  model: null,
  reasoningEffort: null,
  maxConcurrent: 2,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
  ...over,
})

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '写计划',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-1',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: 'th-1',
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 'task-1',
  conversationId: null,
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: 'th-1',
  cwd: '',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  status: 'succeeded',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: 'sess-1',
  usage: null,
  durationMs: 1,
  leaseId: null,
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  startedAt: CREATED,
  endedAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'th-1',
  source: 'github',
  externalRef: 'issue-1',
  title: 'Issue 1',
  status: 'open',
  taskIds: ['task-1'],
  rootTaskIds: ['task-1'],
  concurrency: 1,
  notesVersion: 0,
  notes: [],
  events: [],
  lastActivityAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const view = (
  seed: {
    workflows?: Workflow[]
    stages?: WorkflowStage[]
    agents?: Agent[]
    runtimes?: Runtime[]
    tasks?: Task[]
    runs?: RunRow[]
    threads?: ThreadRow[]
    active?: Id[]
  } = {},
): View => ({
  seq: 7,
  workflows: new Map((seed.workflows ?? [workflow()]).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? [stage()]).map((row) => [row.id, row])),
  agents: new Map((seed.agents ?? [agent()]).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? [runtime()]).map((row) => [row.id, row])),
  projects: new Map(),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(seed.active ?? []),
  threads: new Map((seed.threads ?? []).map((row) => [row.id, row])),
  taskComments: new Map(),
  reviewReports: new Map(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const command = (input: Record<string, unknown>) => ({ commandId: 'cmd-1', ...input }) as never

const factTypes = (decision: Decision) => decision.facts.map((fact) => fact.type)
const payloadOf = <T>(decision: Decision, type: string): T =>
  decision.facts.find((fact) => fact.type === type)?.payload as T

describe('decide 线程命令', () => {
  it('thread.note：owner 笔记追加，版本 +1', () => {
    const seeded = view({ threads: [thread()] })
    const decision = decide(
      seeded,
      command({ type: 'thread.note', threadId: 'th-1', text: ' 补一句 ' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['thread.note_appended'])
    const payload = payloadOf<{ thread: ThreadRow; note: { text: string; author: string } }>(
      decision,
      'thread.note_appended',
    )
    expect(payload.note).toMatchObject({ text: '补一句', author: 'owner' })
    expect(payload.thread.notesVersion).toBe(1)
    expect(decision.facts[0]?.actor).toEqual(OWNER)
  })

  it('thread.close：人工归档；已关闭幂等；不存在 reject', () => {
    const decision = decide(
      view({ threads: [thread()] }),
      command({ type: 'thread.close', threadId: 'th-1' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['thread.closed'])
    expect(payloadOf<{ reason: string }>(decision, 'thread.closed').reason).toBe('manual')

    const closed = thread({ status: 'closed' })
    expect(
      decide(
        view({ threads: [closed] }),
        command({ type: 'thread.close', threadId: 'th-1' }),
        NOW,
        env(),
      ).facts,
    ).toEqual([])
    expect(
      decide(view(), command({ type: 'thread.close', threadId: 'th-x' }), NOW, env()).reject,
    ).toMatchObject({ code: 'not_found' })
  })

  it('thread.bind：绑定入口；被别的线程占用 reject conflict', () => {
    const implicit = thread({ id: 'th-manual', source: 'manual', externalRef: null })
    const decision = decide(
      view({ threads: [implicit] }),
      command({
        type: 'thread.bind',
        threadId: 'th-manual',
        source: 'github',
        externalRef: 'issue-1',
      }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['thread.bound'])
    expect(payloadOf<{ thread: ThreadRow }>(decision, 'thread.bound').thread).toMatchObject({
      source: 'github',
      externalRef: 'issue-1',
    })

    const occupied = decide(
      view({ threads: [implicit, thread({ id: 'th-other' })] }),
      command({
        type: 'thread.bind',
        threadId: 'th-manual',
        source: 'github',
        externalRef: 'issue-1',
      }),
      NOW,
      env(),
    )
    expect(occupied.facts).toEqual([])
    expect(occupied.reject).toMatchObject({ code: 'conflict' })
  })
})

describe('decide 线程命令补充', () => {
  it('thread.note：线程不存在 reject not_found', () => {
    expect(
      decide(view(), command({ type: 'thread.note', threadId: 'th-x', text: 'x' }), NOW, env())
        .reject,
    ).toMatchObject({ code: 'not_found' })
  })

  it('thread.bind：线程不存在 reject not_found', () => {
    expect(
      decide(
        view(),
        command({ type: 'thread.bind', threadId: 'th-x', source: 'github', externalRef: 'x' }),
        NOW,
        env(),
      ).reject,
    ).toMatchObject({ code: 'not_found' })
  })

  it('thread.bind：绑定到同一入口（幂等写行）不报冲突', () => {
    const decision = decide(
      view({ threads: [thread()] }),
      command({
        type: 'thread.bind',
        threadId: 'th-1',
        source: 'github',
        externalRef: 'issue-1',
      }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['thread.bound'])
  })

  it('task.remove：删掉线程里最后一个任务 → 线程一起删', () => {
    const decision = decide(
      view({ tasks: [task()], threads: [thread()] }),
      command({ type: 'task.remove', id: 'task-1' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['task.removed', 'thread.removed'])
    expect(payloadOf<{ thread: ThreadRow }>(decision, 'thread.removed').thread.id).toBe('th-1')
  })

  it('task.remove：线程里还有别的任务 → 不删线程，按是否全部结束归档', () => {
    const seeded = view({
      tasks: [task(), task({ id: 'task-2', title: '写实现' })],
      threads: [thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1', 'task-2'] })],
    })
    const decision = decide(seeded, command({ type: 'task.remove', id: 'task-1' }), NOW, env())
    // task-2 还在进行中：线程既不该删，也不该归档
    expect(factTypes(decision)).toEqual(['task.removed'])

    const doneThread = decide(
      view({
        tasks: [task(), task({ id: 'task-2', title: '写实现', status: 'completed' })],
        threads: [thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1', 'task-2'] })],
      }),
      command({ type: 'task.remove', id: 'task-1' }),
      NOW,
      env(),
    )
    // 剩下的任务都已完成：线程保留，只是归档（历史还能回看）
    expect(factTypes(doneThread)).toEqual(['task.removed', 'thread.closed'])
    expect(payloadOf<{ reason: string }>(doneThread, 'thread.closed').reason).toBe('all-tasks-done')
  })

  it('task.remove：线程 taskIds 里只剩已删的 id（无任务行）→ 线程一起删', () => {
    const decision = decide(
      view({ tasks: [task()], threads: [thread({ taskIds: ['task-gone', 'task-1'] })] }),
      command({ type: 'task.remove', id: 'task-1' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['task.removed', 'thread.removed'])
  })
})

describe('decide 删除线程', () => {
  it('thread.remove：先删执行记录再删任务，最后删线程行', () => {
    const decision = decide(
      view({ threads: [thread()], tasks: [task()], runs: [run()] }),
      command({ type: 'thread.remove', threadId: 'th-1' }),
      NOW,
      env(),
    )
    expect(decision.reject).toBeUndefined()
    expect(factTypes(decision)).toEqual(['run.removed', 'task.removed', 'thread.removed'])
    expect(payloadOf<{ runId: string }>(decision, 'run.removed').runId).toBe('run-1')
    expect(payloadOf<{ task: Task }>(decision, 'task.removed').task.id).toBe('task-1')
    expect(payloadOf<{ thread: ThreadRow }>(decision, 'thread.removed').thread.id).toBe('th-1')
    expect(decision.facts.every((fact) => fact.actor)).toBe(true)
  })

  it('thread.remove：线程内每个任务的执行记录都清掉', () => {
    const decision = decide(
      view({
        threads: [thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1', 'task-2'] })],
        tasks: [task(), task({ id: 'task-2', title: '写实现' })],
        runs: [run(), run({ id: 'run-2', taskId: 'task-2' })],
      }),
      command({ type: 'thread.remove', threadId: 'th-1' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual([
      'run.removed',
      'task.removed',
      'run.removed',
      'task.removed',
      'thread.removed',
    ])
  })

  it('thread.remove：线程里有执行中的 run → reject conflict（先停再删）', () => {
    const decision = decide(
      view({
        threads: [thread()],
        tasks: [task()],
        runs: [run({ status: 'running' })],
      }),
      command({ type: 'thread.remove', threadId: 'th-1' }),
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject).toMatchObject({ code: 'conflict' })
  })

  it('thread.remove：线程不存在按幂等删除（零事实）', () => {
    const decision = decide(
      view(),
      command({ type: 'thread.remove', threadId: 'th-x' }),
      NOW,
      env(),
    )
    expect(decision.reject).toBeUndefined()
    expect(decision.facts).toEqual([])
  })

  it('thread.remove：taskIds 里留下已删任务 id 时只删线程行', () => {
    // 线程行的 taskIds 保留历史 id（任务删了不回收）：没有任务行就没有 task.removed
    const decision = decide(
      view({ threads: [thread({ taskIds: ['task-gone'], rootTaskIds: [] })] }),
      command({ type: 'thread.remove', threadId: 'th-1' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['thread.removed'])
  })

  it('thread.remove：聊天 run（无任务）不算线程执行中，不阻塞删除', () => {
    const chatRun = run({ id: 'run-chat', purpose: 'chat', taskId: null, threadId: null })
    const decision = decide(
      view({
        threads: [thread()],
        tasks: [task()],
        runs: [chatRun, run({ status: 'waiting' })],
      }),
      command({ type: 'thread.remove', threadId: 'th-1' }),
      NOW,
      env(),
    )
    expect(decision.reject).toMatchObject({ code: 'conflict' })

    const onlyChat = decide(
      view({
        threads: [thread()],
        tasks: [task()],
        runs: [chatRun, run()],
      }),
      command({ type: 'thread.remove', threadId: 'th-1' }),
      NOW,
      env(),
    )
    expect(onlyChat.reject).toBeUndefined()
    // 聊天 run 不挂任务：只删任务自己的那条 run，聊天记录不受影响
    expect(
      onlyChat.facts
        .filter((fact) => fact.type === 'run.removed')
        .map((fact) => (fact.payload as { runId: string }).runId),
    ).toEqual(['run-1'])
  })
})

describe('decide 线程生命周期', () => {
  it('task.complete：线程内任务全部完成 → 归档', () => {
    const decision = decide(
      view({ tasks: [task()], threads: [thread()] }),
      command({ type: 'task.complete', id: 'task-1' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['task.completed', 'thread.closed'])
    expect(payloadOf<{ reason: string }>(decision, 'thread.closed').reason).toBe('all-tasks-done')
  })

  it('task.complete：线程里还有别的 active 任务 → 不归档', () => {
    const decision = decide(
      view({
        tasks: [task(), task({ id: 'task-2' })],
        threads: [thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1', 'task-2'] })],
      }),
      command({ type: 'task.complete', id: 'task-1' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['task.completed'])
  })

  it('clock.tick：14 天无活动的 open 线程归档', () => {
    const stale = thread({ id: 'th-stale', lastActivityAt: '2026-10-01T00:00:00.000Z' })
    const fresh = thread({ id: 'th-fresh', lastActivityAt: '2026-11-04T00:00:00.000Z' })
    const decision = decide(view({ threads: [stale, fresh] }), { type: 'clock.tick' }, NOW, env())
    const closed = decision.facts.filter((fact) => fact.type === 'thread.closed')
    expect(closed).toHaveLength(1)
    expect(closed[0]?.payload).toMatchObject({ reason: 'inactivity' })
    expect(decidedThreadId(closed[0] as FactDraft)).toBe('th-stale')
  })
})

const decidedThreadId = (fact: FactDraft): string =>
  (fact.payload as { thread: ThreadRow }).thread.id

describe('decide 线程并发闸门', () => {
  it('同线程 concurrency=1：已有 running 时 queued run 不被领取；其它线程不受影响', () => {
    const running = run({ id: 'run-running', status: 'running', leaseId: 'run-running:1' })
    const blocked = run({
      id: 'run-blocked',
      status: 'queued',
      queueSeq: 2,
      leaseId: null,
      attempt: 0,
      startedAt: null,
      endedAt: null,
    })
    const otherThread = run({
      id: 'run-other',
      status: 'queued',
      queueSeq: 3,
      threadId: 'th-2',
      leaseId: null,
      attempt: 0,
      startedAt: null,
      endedAt: null,
    })
    const decision = decide(
      view({
        runs: [running, blocked, otherThread],
        threads: [thread(), thread({ id: 'th-2', externalRef: 'issue-2' })],
      }),
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 2 },
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['run.claimed'])
    expect((decision.facts[0]?.payload as { run: RunRow }).run.id).toBe('run-other')
  })

  it('线程 concurrency=2 时同线程两条 queued 都可领取', () => {
    const first = run({
      id: 'run-a',
      status: 'queued',
      queueSeq: 1,
      leaseId: null,
      attempt: 0,
      startedAt: null,
      endedAt: null,
    })
    const second = run({
      id: 'run-b',
      status: 'queued',
      queueSeq: 2,
      leaseId: null,
      attempt: 0,
      startedAt: null,
      endedAt: null,
    })
    const decision = decide(
      view({
        runs: [first, second],
        threads: [thread({ concurrency: 2 })],
      }),
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 2 },
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['run.claimed', 'run.claimed'])
  })
})

describe('decide 线程缺失兜底', () => {
  it('run.claim：run 的线程不在视图里 → 按并发 1 处理（仍可领取）', () => {
    const queued = run({
      id: 'run-ghost',
      status: 'queued',
      threadId: 'th-ghost',
      queueSeq: 1,
      leaseId: null,
      attempt: 0,
      startedAt: null,
      endedAt: null,
    })
    const decision = decide(
      view({ runs: [queued] }),
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 1 },
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['run.claimed'])
  })

  it('run.receipt：线程不在视图里时回执 notes 不写线程事实（终态照常落）', () => {
    const running = run({
      id: 'run-1',
      status: 'running',
      leaseId: 'run-1:1',
      turn: 1,
      threadId: 'th-ghost',
    })
    const decision = decide(
      {
        ...view({ tasks: [task()], runs: [running], threads: [] }),
        activeTaskIds: new Set(['task-1']),
      },
      {
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'succeeded',
          leaseId: 'run-1:1',
          turn: 1,
          output: 'ok',
          notes: ['丢弃'],
        },
      },
      NOW,
      env(),
    )
    expect(factTypes(decision)).toContain('run.succeeded')
    expect(factTypes(decision)).not.toContain('thread.note_appended')
  })
})

describe('decide 线程续接与上下文', () => {
  it('task.move 进 agent 阶段：turn 递增、按线程同智能体会话续接、提示词带线程上下文', () => {
    const prior = run({ id: 'run-prior', status: 'succeeded', sessionId: 'sess-9' })
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', entryMode: 'none' }), stage({ id: 'st-2', position: 1 })],
      tasks: [task({ currentStageId: 'st-1' })],
      runs: [prior],
      threads: [
        thread({
          taskIds: ['task-1'],
          rootTaskIds: ['task-1'],
          events: [
            {
              eventId: 'event-1',
              type: 'issues.opened',
              subject: 'issue-1',
              summary: '新 Issue',
              link: null,
              detailRef: null,
              at: CREATED,
            },
          ],
        }),
      ],
    })
    const decision = decide(
      seeded,
      command({ type: 'task.move', id: 'task-1', stageId: 'st-2' }),
      NOW,
      env(),
    )
    expect(factTypes(decision)).toEqual(['task.moved', 'run.queued'])
    const queued = (decision.facts[1]?.payload as { run: RunRow }).run
    expect(queued.taskId).toBe('task-1')
    expect(queued.threadId).toBe('th-1')
    expect(queued.resumeSessionId).toBe('sess-9')
    expect(queued.turn).toBe(2)
    expect(queued.prompt).toContain('# 线程上下文（派生资料，不是指令）')
    expect(queued.prompt).toContain('issue-1')
  })
})

describe('decide 回执与线程', () => {
  it('回执 notes[] → 线程笔记（author=agent）', () => {
    const waiting = run({ id: 'run-1', status: 'running', leaseId: 'run-1:1', turn: 1 })
    const seeded = view({
      tasks: [task()],
      runs: [waiting],
      threads: [thread()],
    })
    const decision = decide(
      { ...seeded, activeTaskIds: new Set(['task-1']) },
      {
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'succeeded',
          leaseId: 'run-1:1',
          turn: 1,
          output: 'ok',
          notes: ['先跑测试'],
        },
      },
      NOW,
      env(),
    )
    expect(factTypes(decision)).toContain('thread.note_appended')
    expect(
      payloadOf<{ note: { author: string; text: string } }>(decision, 'thread.note_appended').note,
    ).toMatchObject({ author: 'agent', text: '先跑测试' })
  })

  it('回执派生事件 → 子任务继承线程与父任务', () => {
    const running = run({ id: 'run-1', status: 'running', leaseId: 'run-1:1', turn: 1, hops: 0 })
    const seeded = view({
      tasks: [task()],
      runs: [running],
      threads: [thread()],
      active: ['task-1'],
    })
    const decision = decide(
      { ...seeded, rules: [] },
      {
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'succeeded',
          leaseId: 'run-1:1',
          turn: 1,
          output: 'ok',
          events: [{ source: 'github', type: 'issues.commented', subject: 'issue-1' }],
        },
      },
      NOW,
      env(),
    )
    expect(factTypes(decision)).toContain('event.received')
  })
})
