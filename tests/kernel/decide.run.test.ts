/**
 * `run.claim` / `run.heartbeat` / `run.receipt` 的黄金用例（T5/T6）：领取排序、按智能体开窗、
 * 租约计算、心跳匹配、回执校验、终态归一、waiting 与阶段流转。夹具只装内核判定需要的
 * 切片（runs / runtimes / agents / tasks / workflows / stages），其余投影表留空。
 */
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Conversation,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type {
  RunClaimedPayload,
  RunRemovedPayload,
  RunWaitingPayload,
} from '../../src/protocol/facts'
import type { Receipt, RunHostSettledInput } from '../../src/protocol/inputs'
import type { ReviewReport } from '../../src/protocol/review'
import { decide } from '../../src/kernel/decide'
import { runAccessOf } from '../../src/kernel/task-effects'
import {
  degradedCommentText,
  repairCommentText,
  stageRoundCount,
  unmetAcceptance,
} from '../../src/kernel/commands/run'
import { project } from '../../src/kernel/project'
import type { Environment, Id, IdKind, Limits, View } from '../../src/kernel/types'

const NOW = '2026-11-04T12:00:00.000Z'
const FUTURE = '2026-11-04T13:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'

const limits = (over: Partial<Limits> = {}): Limits => ({
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

/** 智能体（M27）：并发窗口与访问权限的归属层；缺省 1 个并发位。 */
const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
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
  prompt: 'prompt',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: null,
  endedAt: null,
  createdAt: CREATED,
  conversationId: null,
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: 'C:/work',
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
  attempt: 0,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  ...over,
})

interface Seed {
  conversations?: Conversation[]
  runs?: RunRow[]
  runtimes?: Runtime[]
  /** M21：续轮要能查到绑定的智能体（默认空 = 不产新 run） */
  agents?: Agent[]
  tasks?: Task[]
  workflows?: Workflow[]
  stages?: WorkflowStage[]
  /** M14：评审报告（定位 / 覆盖检查读它） */
  reviewReports?: ReviewReport[]
}

const view = (seed: Seed = {}): View => ({
  seq: 7,
  workflows: new Map((seed.workflows ?? []).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? []).map((row) => [row.id, row])),
  agents: new Map((seed.agents ?? []).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  projects: new Map(),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map((seed.conversations ?? []).map((row) => [row.id, row])),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map((seed.reviewReports ?? []).map((row) => [row.id, row])),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'cv-1',
  title: '对话',
  agentId: 'ag-1',
  projectId: null,
  sessionId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

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
  name: '待办',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffs: [],
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
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

/** 已领取的 run：默认与 `run()` 的 id 配套（leaseId = 'run-1:1'）。 */
const running = (over: Partial<RunRow> = {}): RunRow =>
  run({
    status: 'running',
    attempt: 1,
    leaseId: 'run-1:1',
    leaseUntil: '2026-11-04T12:02:00.000Z',
    deadlineAt: '2026-11-04T12:30:00.000Z',
    startedAt: NOW,
    ...over,
  })

/** 确定性 id 生成器：领取不产实体 id，这里只满足 `Environment` 形状。 */
const env = (over: Partial<Limits> = {}): Environment => {
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: limits(over),
    nextId: (kind: IdKind): Id => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

const claim = (
  target: View,
  runtimeId = 'rt-1',
  capacity = 8,
  environment = env(),
): ReturnType<typeof decide> =>
  decide(target, { type: 'run.claim', runtimeId, capacity }, NOW, environment)

const claimedIds = (decision: ReturnType<typeof decide>): string[] =>
  decision.facts.map((fact) => (fact.payload as RunClaimedPayload).run.id)

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: 'run-1:1',
  turn: 1,
  ...over,
})

const receive = (
  target: View,
  runId = 'run-1',
  payload: Receipt = receipt(),
  environment = env(),
): ReturnType<typeof decide> =>
  decide(target, { type: 'run.receipt', runId, receipt: payload }, NOW, environment)

/** 终态 run 行的期望值：清租约 / 超时 / 结束时刻，其余按回执覆盖。 */
const settledRow = (active: RunRow, over: Partial<RunRow> = {}): RunRow => ({
  ...active,
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  endedAt: NOW,
  leaseId: null,
  leaseUntil: null,
  deadlineAt: null,
  ...over,
})

const HOST = { kind: 'host', via: 'scheduler' } as const

const tick = (target: View, environment = env()): ReturnType<typeof decide> =>
  decide(target, { type: 'clock.tick' }, NOW, environment)

const cancel = (target: View, runId = 'run-1'): ReturnType<typeof decide> =>
  decide(target, { type: 'run.cancel', runId }, NOW, env())

const hostSettle = (
  target: View,
  over: Partial<RunHostSettledInput> = {},
  environment = env(),
): ReturnType<typeof decide> =>
  decide(
    target,
    { type: 'run.host_settled', runId: 'run-1', status: 'failed', ...over },
    NOW,
    environment,
  )

describe('kernel/decide run.claim 领取', () => {
  it('超并发不领取：窗口 = 智能体 maxConcurrent − 该智能体 running 数', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 2 })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-1', createdAt: '2026-01-01T00:00:01.000Z' }),
          run({ id: 'run-2', createdAt: '2026-01-01T00:00:02.000Z' }),
          run({ id: 'run-3', createdAt: '2026-01-01T00:00:03.000Z' }),
        ],
      }),
    )

    expect(decision.reject).toBeUndefined()
    expect(claimedIds(decision)).toEqual(['run-1', 'run-2'])
    expect(decision.facts.every((fact) => fact.type === 'run.claimed')).toBe(true)
  })

  it('并发窗口按智能体：两个智能体各 1，一次 capacity 8 也只能各领 1', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 1 }), agent({ id: 'ag-2', name: '另一个' })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-ag1-a', createdAt: '2026-01-01T00:00:01.000Z' }),
          run({ id: 'run-ag1-b', createdAt: '2026-01-01T00:00:02.000Z' }),
          run({ id: 'run-ag2-a', agentId: 'ag-2', createdAt: '2026-01-01T00:00:03.000Z' }),
          run({ id: 'run-ag2-b', agentId: 'ag-2', createdAt: '2026-01-01T00:00:04.000Z' }),
        ],
      }),
    )

    // capacity 只是单次领取上界；窗口分别由智能体算，互不占用
    expect(claimedIds(decision)).toEqual(['run-ag1-a', 'run-ag2-a'])
  })

  it('run 的智能体查不到（脏投影）：按 1 个并发位放行，不永久卡队列', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 8 })],
        runtimes: [runtime()],
        runs: [
          run({
            id: 'run-ghost-agent',
            agentId: 'ag-missing',
            createdAt: '2026-01-01T00:00:01.000Z',
          }),
          run({ id: 'run-ghost-2', agentId: 'ag-missing', createdAt: '2026-01-01T00:00:02.000Z' }),
        ],
      }),
    )

    expect(claimedIds(decision)).toEqual(['run-ghost-agent'])
  })

  it('capacity 小于候选数：只领上界条数（窗口不是唯一约束）', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 8 })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-1', createdAt: '2026-01-01T00:00:01.000Z' }),
          run({ id: 'run-2', createdAt: '2026-01-01T00:00:02.000Z' }),
        ],
      }),
      'rt-1',
      1,
    )

    expect(claimedIds(decision)).toEqual(['run-1'])
  })

  it('run 没有智能体（脏投影）：按 1 个并发位放行', () => {
    const decision = claim(
      view({
        agents: [agent()],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-no-agent', agentId: null, createdAt: '2026-01-01T00:00:01.000Z' }),
          run({ id: 'run-no-agent-2', agentId: null, createdAt: '2026-01-01T00:00:02.000Z' }),
        ],
      }),
    )

    expect(claimedIds(decision)).toEqual(['run-no-agent'])
  })

  it('窗口为 0 时零事实（running 已占满并发位）', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 2 })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-a', status: 'running', attempt: 1, leaseId: 'run-a:1' }),
          run({ id: 'run-b', status: 'running', attempt: 1, leaseId: 'run-b:1' }),
          run({ id: 'run-c' }),
        ],
      }),
    )

    expect(decision).toEqual({ facts: [] })
  })

  it('waiting 不占位：挂起等回答的 run 已释放并发位', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 1 })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-waiting', status: 'waiting', attempt: 1, leaseId: null }),
          run({ id: 'run-queued', createdAt: '2026-01-01T00:00:02.000Z' }),
        ],
      }),
    )

    expect(claimedIds(decision)).toEqual(['run-queued'])
  })

  it('running 占位、waiting 不占位：窗口只扣 running', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 2 })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-running', status: 'running', attempt: 1, leaseId: 'run-running:1' }),
          run({ id: 'run-waiting', status: 'waiting', attempt: 1 }),
          run({ id: 'run-queued-1', createdAt: '2026-01-01T00:00:03.000Z' }),
          run({ id: 'run-queued-2', createdAt: '2026-01-01T00:00:04.000Z' }),
        ],
      }),
    )

    // 窗口 2 − 1 = 1，只领取排最前的 queued
    expect(claimedIds(decision)).toEqual(['run-queued-1'])
  })

  it('FIFO：notBefore 升序，同序按 queueSeq，再按 createdAt + id（存量兜底）', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 8 })],
        runtimes: [runtime()],
        runs: [
          run({
            id: 'run-late',
            queueSeq: 99,
            createdAt: '2026-01-01T00:00:03.000Z',
            notBefore: '2026-11-04T11:59:00.000Z',
          }),
          run({
            id: 'run-early',
            queueSeq: 1,
            createdAt: '2026-01-01T00:00:01.000Z',
            notBefore: '2026-11-04T11:59:30.000Z',
          }),
          // 同一 notBefore：queueSeq 优先于 createdAt
          run({ id: 'run-seq-b', queueSeq: 5, createdAt: '2026-01-01T00:00:01.000Z' }),
          run({ id: 'run-seq-a', queueSeq: 4, createdAt: '2026-01-01T00:00:09.000Z' }),
          // 存量导入行 queueSeq=0：同值再按 createdAt、id 兜底
          run({ id: 'run-legacy-b', queueSeq: 0, createdAt: '2026-01-01T00:00:03.000Z' }),
          run({ id: 'run-legacy-a', queueSeq: 0, createdAt: '2026-01-01T00:00:03.000Z' }),
        ],
      }),
    )

    // notBefore=null 最前；同 notBefore 按 queueSeq；queueSeq 相同按 createdAt、id；再按 notBefore 先后
    expect(claimedIds(decision)).toEqual([
      'run-legacy-a',
      'run-legacy-b',
      'run-seq-a',
      'run-seq-b',
      'run-late',
      'run-early',
    ])
  })

  it('notBefore 未到不领取；恰好等于 now 可领取', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 8 })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-immediate' }),
          run({ id: 'run-due', notBefore: NOW }),
          run({ id: 'run-future', notBefore: FUTURE }),
        ],
      }),
    )

    expect(claimedIds(decision)).toEqual(['run-immediate', 'run-due'])
  })

  it('多运行时互不影响：各运行时只领自己的 run，窗口按智能体算', () => {
    const target = view({
      // 窗口跟着智能体走：同一连接上挂两个智能体，各算各的
      agents: [
        agent({ id: 'ag-rt1', maxConcurrent: 1 }),
        agent({ id: 'ag-rt2', name: '另一个', maxConcurrent: 2 }),
      ],
      runtimes: [runtime({ id: 'rt-1' }), runtime({ id: 'rt-2', name: '本机 dsh 2' })],
      runs: [
        run({
          id: 'run-rt1-running',
          runtimeId: 'rt-1',
          agentId: 'ag-rt1',
          status: 'running',
          attempt: 1,
        }),
        run({
          id: 'run-rt1-queued',
          runtimeId: 'rt-1',
          agentId: 'ag-rt1',
          createdAt: '2026-01-01T00:00:02.000Z',
        }),
        run({
          id: 'run-rt2-1',
          runtimeId: 'rt-2',
          agentId: 'ag-rt2',
          createdAt: '2026-01-01T00:00:03.000Z',
        }),
        run({
          id: 'run-rt2-2',
          runtimeId: 'rt-2',
          agentId: 'ag-rt2',
          createdAt: '2026-01-01T00:00:04.000Z',
        }),
        run({
          id: 'run-rt2-3',
          runtimeId: 'rt-2',
          agentId: 'ag-rt2',
          createdAt: '2026-01-01T00:00:05.000Z',
        }),
      ],
    })

    expect(claim(target, 'rt-1')).toEqual({ facts: [] })
    expect(claimedIds(claim(target, 'rt-2'))).toEqual(['run-rt2-1', 'run-rt2-2'])
  })

  it('capacity 大于窗口时只领取窗口数', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 3 })],
        runtimes: [runtime()],
        runs: [
          run({ id: 'run-a', status: 'running', attempt: 1 }),
          run({ id: 'run-b', status: 'running', attempt: 1 }),
          run({ id: 'run-c', createdAt: '2026-01-01T00:00:03.000Z' }),
          run({ id: 'run-d', createdAt: '2026-01-01T00:00:04.000Z' }),
        ],
      }),
    )

    expect(claimedIds(decision)).toEqual(['run-c'])
  })

  it('leaseId / attempt / leaseUntil / deadlineAt 按租约与超时口径计算', () => {
    const fresh = run({ id: 'run-fresh', attempt: 0 })
    const retry = run({ id: 'run-retry', attempt: 2, createdAt: '2026-01-01T00:00:02.000Z' })
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 8 })],
        runtimes: [runtime()],
        runs: [fresh, retry],
      }),
      'rt-1',
      8,
      env({ leaseMs: 1_000, runTimeoutMs: 5_000 }),
    )

    expect(decision.facts).toEqual([
      {
        type: 'run.claimed',
        actor: { kind: 'host', via: 'scheduler' },
        at: NOW,
        payload: {
          run: {
            ...fresh,
            status: 'running',
            leaseId: 'run-fresh:1',
            attempt: 1,
            leaseUntil: '2026-11-04T12:00:01.000Z',
            deadlineAt: '2026-11-04T12:00:05.000Z',
            startedAt: NOW,
          },
        },
      },
      {
        type: 'run.claimed',
        actor: { kind: 'host', via: 'scheduler' },
        at: NOW,
        payload: {
          run: {
            ...retry,
            status: 'running',
            leaseId: 'run-retry:3',
            attempt: 3,
            leaseUntil: '2026-11-04T12:00:01.000Z',
            deadlineAt: '2026-11-04T12:00:05.000Z',
            startedAt: NOW,
          },
        },
      },
    ])
  })

  it('M26：阶段配了 runTimeoutMs 就按阶段算 deadlineAt，没配 / 查不到阶段回落全局', () => {
    const decision = claim(
      view({
        agents: [agent({ maxConcurrent: 8 })],
        runtimes: [runtime()],
        stages: [
          stage({ id: 'st-1', runTimeoutMs: 5_400_000 }),
          stage({ id: 'st-2', runTimeoutMs: null }),
        ],
        runs: [
          run({ id: 'run-a' }),
          run({ id: 'run-b', stageId: 'st-2', createdAt: '2026-01-01T00:00:01.000Z' }),
          run({ id: 'run-c', stageId: 'st-gone', createdAt: '2026-01-01T00:00:02.000Z' }),
          run({
            id: 'run-d',
            purpose: 'chat',
            stageId: null,
            createdAt: '2026-01-01T00:00:03.000Z',
          }),
        ],
      }),
      'rt-1',
      8,
      env({ leaseMs: 1_000, runTimeoutMs: 60_000 }),
    )

    // 12:00 起算：阶段 90 min / 全局 60 s（阶段没配、阶段不存在、聊天 run 都走全局）
    expect(
      decision.facts.map((fact) => (fact.payload as RunClaimedPayload).run.deadlineAt),
    ).toEqual([
      '2026-11-04T13:30:00.000Z',
      '2026-11-04T12:01:00.000Z',
      '2026-11-04T12:01:00.000Z',
      '2026-11-04T12:01:00.000Z',
    ])
  })

  it('claim 后 run 行：status=running、租约/attempt/startedAt 落到新行，不改输入行', () => {
    const queued = run({ id: 'run-1', attempt: 1, queueSeq: 3, startedAt: null })
    const decision = claim(
      view({ runtimes: [runtime()], runs: [queued] }),
      'rt-1',
      1,
      env({ leaseMs: 1_000, runTimeoutMs: 5_000 }),
    )

    const claimed = (decision.facts[0]?.payload as RunClaimedPayload | undefined)?.run
    expect(claimed).toMatchObject({
      id: 'run-1',
      status: 'running',
      leaseId: 'run-1:2',
      attempt: 2,
      leaseUntil: '2026-11-04T12:00:01.000Z',
      deadlineAt: '2026-11-04T12:00:05.000Z',
      startedAt: NOW,
      queueSeq: 3,
    })
    // 纯函数：原 queued 行不被就地改写
    expect(queued).toMatchObject({
      status: 'queued',
      leaseId: null,
      attempt: 1,
      leaseUntil: null,
      deadlineAt: null,
      startedAt: null,
    })
  })

  it('默认限制：leaseUntil = now + 120s、deadlineAt = now + 30min', () => {
    const decision = claim(view({ runtimes: [runtime()], runs: [run({ id: 'run-1' })] }))

    expect(decision.facts).toHaveLength(1)
    expect(decision.facts[0]?.payload).toEqual({
      run: run({
        id: 'run-1',
        status: 'running',
        leaseId: 'run-1:1',
        attempt: 1,
        leaseUntil: '2026-11-04T12:02:00.000Z',
        deadlineAt: '2026-11-04T12:30:00.000Z',
        startedAt: NOW,
      }),
    })
  })

  it('无候选时零事实（不产 reject）', () => {
    expect(claim(view({ runtimes: [runtime()] }))).toEqual({ facts: [] })
  })

  it('非法 capacity 拒绝：必须是 1–8 的整数', () => {
    const target = view({ runtimes: [runtime()], runs: [run()] })

    for (const capacity of [0, 9, 1.5, Number.NaN]) {
      expect(claim(target, 'rt-1', capacity)).toEqual({
        facts: [],
        reject: { code: 'invalid_input', message: '领取数量必须是 1–8 的整数' },
      })
    }
  })

  it('运行时不存在拒绝；运行时未启用拒绝', () => {
    expect(claim(view(), 'rt-missing')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '运行时不存在: rt-missing' },
    })

    const disabled = view({
      runtimes: [runtime({ enabled: false })],
      runs: [run()],
    })
    expect(claim(disabled)).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '运行时未启用: rt-1' },
    })
  })
})

describe('kernel/decide run.heartbeat 续租', () => {
  const heartbeat = (
    target: View,
    runId: string,
    leaseId: string,
    environment = env({ leaseMs: 1_000 }),
  ): ReturnType<typeof decide> =>
    decide(target, { type: 'run.heartbeat', runId, leaseId }, NOW, environment)

  it('leaseId 匹配当前租约：产 run.lease_extended，续租到 now + leaseMs', () => {
    const running = run({
      id: 'run-1',
      status: 'running',
      attempt: 1,
      leaseId: 'run-1:1',
      leaseUntil: '2026-11-04T12:00:30.000Z',
    })
    const target = view({ runs: [running] })

    expect(heartbeat(target, 'run-1', 'run-1:1')).toEqual({
      facts: [
        {
          type: 'run.lease_extended',
          actor: { kind: 'host', via: 'scheduler' },
          at: NOW,
          payload: {
            run: { ...running, leaseUntil: '2026-11-04T12:00:01.000Z' },
          },
        },
      ],
    })
  })

  it('leaseId 不匹配：零事实，也不产 reject（避免调度器噪音）', () => {
    const target = view({
      runs: [run({ id: 'run-1', status: 'running', attempt: 1, leaseId: 'run-1:1' })],
    })

    expect(heartbeat(target, 'run-1', 'run-1:2')).toEqual({ facts: [] })
  })

  it('run 不存在 / 尚未领取（leaseId 为空）：零事实', () => {
    const target = view({ runs: [run({ id: 'run-1', leaseId: null })] })

    expect(heartbeat(target, 'run-missing', 'run-missing:1')).toEqual({ facts: [] })
    expect(heartbeat(target, 'run-1', 'run-1:1')).toEqual({ facts: [] })
  })
})

describe('kernel/decide run.receipt 回执', () => {
  it('成功回执：run.succeeded 写终态并清租约/超时；任务不在视图时零流转', () => {
    const active = running()
    const decision = receive(
      view({ runs: [active] }),
      'run-1',
      receipt({
        output: '完成',
        sessionId: 'sess-1',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 },
        exitCode: 0,
        durationMs: 1_234,
        // 成功回执即使带了失败文案也不落库
        error: '不该出现在成功终态',
      }),
    )

    expect(decision).toEqual({
      facts: [
        {
          type: 'run.succeeded',
          actor: HOST,
          at: NOW,
          payload: {
            run: settledRow(active, {
              status: 'succeeded',
              output: '完成',
              sessionId: 'sess-1',
              usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 },
              exitCode: 0,
              durationMs: 1_234,
            }),
          },
        },
      ],
    })
  })

  it('失败回执：errorCode 缺省 run_failed，写 exitCode/durationMs 与失败文案', () => {
    const active = running()
    const decision = receive(
      view({ runs: [active] }),
      'run-1',
      receipt({
        status: 'failed',
        exitCode: 1,
        durationMs: 900,
        error: '启动失败：找不到可执行文件',
      }),
    )

    expect(decision).toEqual({
      facts: [
        {
          type: 'run.failed',
          actor: HOST,
          at: NOW,
          payload: {
            run: settledRow(active, {
              status: 'failed',
              error: '启动失败：找不到可执行文件',
              errorCode: 'run_failed',
              exitCode: 1,
              durationMs: 900,
            }),
          },
        },
      ],
    })

    // 回执带 errorCode 时按原值归类，不再回退 run_failed
    const timeout = receive(
      view({ runs: [running()] }),
      'run-1',
      receipt({ status: 'failed', errorCode: 'timeout' }),
    )
    expect((timeout.facts[0]?.payload as { run: RunRow }).run.errorCode).toBe('timeout')
  })

  it('取消回执：errorCode 缺省 cancelled，且不推进阶段', () => {
    const active = running()
    const decision = receive(
      view({
        runs: [active],
        workflows: [workflow()],
        stages: [stage()],
        tasks: [task()],
      }),
      'run-1',
      receipt({ status: 'cancelled' }),
    )

    expect(decision.facts).toEqual([
      {
        type: 'run.cancelled',
        actor: HOST,
        at: NOW,
        payload: {
          run: settledRow(active, { status: 'cancelled', errorCode: 'cancelled' }),
        },
      },
    ])
  })

  it('迟到回执（旧 attempt 的 leaseId）：只记 receipt_rejected，不改状态', () => {
    const active = running({ attempt: 2, leaseId: 'run-1:2' })
    const decision = receive(
      view({ runs: [active] }),
      'run-1',
      receipt({ leaseId: 'run-1:1', turn: 1 }),
    )

    expect(decision).toEqual({
      facts: [
        {
          type: 'run.receipt_rejected',
          actor: HOST,
          at: NOW,
          payload: { runId: 'run-1', leaseId: 'run-1:1', turn: 1, reason: 'lease_mismatch' },
        },
      ],
    })
  })

  it('轮次不匹配（旧 turn）：只记 receipt_rejected', () => {
    const active = running({ attempt: 2, leaseId: 'run-1:2', turn: 2 })
    const decision = receive(
      view({ runs: [active] }),
      'run-1',
      receipt({ leaseId: 'run-1:2', turn: 1 }),
    )

    expect(decision).toEqual({
      facts: [
        {
          type: 'run.receipt_rejected',
          actor: HOST,
          at: NOW,
          payload: { runId: 'run-1', leaseId: 'run-1:2', turn: 1, reason: 'turn_mismatch' },
        },
      ],
    })
  })

  it('重复终态（run 已落任意终态）：只记 receipt_rejected', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      const done = running({ status, leaseId: null, endedAt: NOW })
      const decision = receive(
        view({ runs: [done] }),
        'run-1',
        receipt({ leaseId: 'run-1:1', turn: 1 }),
      )

      expect(decision).toEqual({
        facts: [
          {
            type: 'run.receipt_rejected',
            actor: HOST,
            at: NOW,
            payload: { runId: 'run-1', leaseId: 'run-1:1', turn: 1, reason: 'terminal' },
          },
        ],
      })
    }
  })

  it('未知 run：reject not_found，不伪造审计事实', () => {
    expect(receive(view(), 'run-missing')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '运行不存在: run-missing' },
    })
  })

  it('回执带 ask：先建卡再 run.waiting（释放租约/超时，且不占并发位）', () => {
    const active = running({ sessionId: 'sess-old' })
    const decision = receive(
      view({ runs: [active] }),
      'run-1',
      receipt({
        status: 'succeeded',
        ask: [{ title: '确认', options: ['好'] }],
        sessionId: 'sess-wait',
      }),
    )

    expect(decision.facts).toEqual([
      {
        type: 'card.opened',
        actor: HOST,
        at: NOW,
        payload: {
          card: {
            id: 'card-new-1',
            runId: 'run-1',
            taskId: 't-1',
            conversationId: null,
            title: '确认',
            text: '',
            kind: 'ask',
            options: ['好'],
            key: null,
            version: 1,
            status: 'open',
            delivery: 'pending',
            deliveryRef: null,
            optionIndex: null,
            answeredBy: null,
            answeredAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      },
      {
        type: 'run.waiting',
        actor: HOST,
        at: NOW,
        payload: {
          run: {
            ...active,
            status: 'waiting',
            sessionId: 'sess-wait',
            leaseId: null,
            leaseUntil: null,
            deadlineAt: null,
          },
          cardIds: ['card-new-1'],
        },
      },
    ])

    // 用同一视图再领取：waiting 不占位，下一条 queued 可以被领取
    const waiting = (decision.facts[1]?.payload as RunWaitingPayload).run
    const nextClaim = claim(
      view({
        agents: [agent({ maxConcurrent: 1 })],
        runtimes: [runtime()],
        runs: [waiting, run({ id: 'run-2', createdAt: '2026-01-01T00:00:02.000Z' })],
      }),
    )
    expect(claimedIds(nextClaim)).toEqual(['run-2'])
  })

  it('回执 ask 且没带 sessionId：保留 run 上已有的会话 id', () => {
    const active = running({ sessionId: 'sess-old' })
    const decision = receive(
      view({ runs: [active] }),
      'run-1',
      receipt({ ask: [{ title: '确认', options: ['好'] }] }),
    )

    const waiting = (decision.facts[1]?.payload as RunWaitingPayload).run
    expect(waiting.sessionId).toBe('sess-old')
  })

  it('成功且还有下一阶段：产 task.moved 到下一阶段（updatedAt=now）', () => {
    const active = running()
    const current = task({ currentStageId: 'st-1' })
    const decision = receive(
      view({
        runs: [active],
        workflows: [workflow()],
        stages: [stage({ id: 'st-1', position: 0 }), stage({ id: 'st-2', position: 1 })],
        tasks: [current],
      }),
      'run-1',
      receipt({ output: 'ok' }),
    )

    expect(decision.facts).toEqual([
      {
        type: 'run.succeeded',
        actor: HOST,
        at: NOW,
        payload: { run: settledRow(active, { status: 'succeeded', output: 'ok' }) },
      },
      {
        type: 'task.moved',
        actor: HOST,
        at: NOW,
        payload: {
          task: { ...current, currentStageId: 'st-2', updatedAt: NOW, gateFails: 0 },
          from: 'st-1',
          to: 'st-2',
        },
      },
    ])
  })

  it('成功且已是最后阶段：产 task.completed', () => {
    const active = running()
    const current = task()
    const decision = receive(
      view({
        runs: [active],
        workflows: [workflow()],
        stages: [stage({ id: 'st-1', position: 0 })],
        tasks: [current],
      }),
      'run-1',
      receipt(),
    )

    expect(decision.facts[1]).toEqual({
      type: 'task.completed',
      actor: HOST,
      at: NOW,
      payload: { task: { ...current, status: 'completed', updatedAt: NOW, gateFails: 0 } },
    })
  })

  it('失败且打回目标就是原地：零流转效果，不重建 run', () => {
    const decision = receive(
      view({
        runs: [running()],
        workflows: [workflow()],
        stages: [stage({ id: 'st-1', position: 0 })],
        tasks: [task({ currentStageId: 'st-1' })],
      }),
      'run-1',
      receipt({ status: 'failed' }),
    )

    expect(decision.facts).toHaveLength(1)
    expect(decision.facts[0]?.type).toBe('run.failed')
  })

  it('失败且未配置打回目标（不指定）：原地不动，只落 run.failed', () => {
    const current = task({ currentStageId: 'st-2' })
    const decision = receive(
      view({
        runs: [running()],
        workflows: [workflow()],
        stages: [stage({ id: 'st-1', position: 0 }), stage({ id: 'st-2', position: 1 })],
        tasks: [current],
      }),
      'run-1',
      receipt({ status: 'failed' }),
    )

    expect(decision.facts).toHaveLength(1)
    expect(decision.facts[0]?.type).toBe('run.failed')
  })

  it('失败且显式配置打回目标：产 task.moved 到该阶段', () => {
    const current = task({ currentStageId: 'st-2' })
    const decision = receive(
      view({
        runs: [running()],
        workflows: [workflow()],
        stages: [
          stage({ id: 'st-1', position: 0 }),
          stage({ id: 'st-2', position: 1, onRejectStageId: 'st-1' }),
        ],
        tasks: [current],
      }),
      'run-1',
      receipt({ status: 'failed' }),
    )

    expect(decision.facts[1]).toEqual({
      type: 'task.moved',
      actor: HOST,
      at: NOW,
      payload: {
        task: { ...current, currentStageId: 'st-1', updatedAt: NOW, gateFails: 0 },
        from: 'st-2',
        to: 'st-1',
      },
    })
  })

  it('任务已完成 / 阶段无效：只落终态，零流转事实', () => {
    const completed = task({ status: 'completed' })
    const completedDecision = receive(
      view({
        runs: [running()],
        workflows: [workflow()],
        stages: [stage()],
        tasks: [completed],
      }),
      'run-1',
      receipt(),
    )
    expect(completedDecision.facts).toHaveLength(1)

    const invalid = task({ currentStageId: 'st-missing' })
    const invalidDecision = receive(
      view({
        runs: [running()],
        workflows: [workflow()],
        stages: [stage()],
        tasks: [invalid],
      }),
      'run-1',
      receipt(),
    )
    expect(invalidDecision.facts).toHaveLength(1)
    expect(invalidDecision.facts[0]?.type).toBe('run.succeeded')
  })

  it('运行数据缺挂载（stage 缺 taskId / 工作流已删 / chat 缺 conversationId）：只落终态', () => {
    const stageRun = running({
      id: 'run-no-task',
      taskId: null,
      stageId: null,
      leaseId: 'run-no-task:1',
    })
    expect(
      receive(view({ runs: [stageRun] }), 'run-no-task', receipt({ leaseId: 'run-no-task:1' }))
        .facts,
    ).toHaveLength(1)

    // 任务在，但它引用的工作流不在视图里
    expect(
      receive(view({ runs: [running()], stages: [stage()], tasks: [task()] }), 'run-1', receipt())
        .facts,
    ).toHaveLength(1)

    const chatRun = running({
      id: 'run-no-cv',
      purpose: 'chat',
      taskId: null,
      stageId: null,
      conversationId: null,
      leaseId: 'run-no-cv:1',
    })
    expect(
      receive(view({ runs: [chatRun] }), 'run-no-cv', receipt({ leaseId: 'run-no-cv:1' })).facts,
    ).toHaveLength(1)
  })

  it('聊天终态：产 assistant message.appended（挂 runId，content=output）', () => {
    const chat = running({
      id: 'run-chat',
      purpose: 'chat',
      taskId: null,
      stageId: null,
      conversationId: 'cv-1',
      leaseId: 'run-chat:1',
    })
    const decision = receive(
      view({ runs: [chat], conversations: [conversation()] }),
      'run-chat',
      receipt({ leaseId: 'run-chat:1', output: '你好' }),
    )

    expect(decision.facts).toEqual([
      {
        type: 'run.succeeded',
        actor: HOST,
        at: NOW,
        payload: { run: settledRow(chat, { status: 'succeeded', output: '你好' }) },
      },
      {
        type: 'message.appended',
        actor: HOST,
        at: NOW,
        payload: {
          conversationId: 'cv-1',
          messageId: 'message-new-1',
          role: 'assistant',
          content: '你好',
          runId: 'run-chat',
          error: null,
        },
      },
    ])
  })

  it('聊天失败终态：run.error 与 message.error 都用回执失败文案', () => {
    const chat = running({
      id: 'run-chat',
      purpose: 'chat',
      taskId: null,
      stageId: null,
      conversationId: 'cv-1',
      leaseId: 'run-chat:1',
    })
    const decision = receive(
      view({ runs: [chat], conversations: [conversation()] }),
      'run-chat',
      receipt({ leaseId: 'run-chat:1', status: 'failed', error: '进程崩溃' }),
    )

    expect(decision.facts[0]).toEqual({
      type: 'run.failed',
      actor: HOST,
      at: NOW,
      payload: {
        run: settledRow(chat, { status: 'failed', error: '进程崩溃', errorCode: 'run_failed' }),
      },
    })
    expect(decision.facts[1]).toEqual({
      type: 'message.appended',
      actor: HOST,
      at: NOW,
      payload: {
        conversationId: 'cv-1',
        messageId: 'message-new-1',
        role: 'assistant',
        content: '',
        runId: 'run-chat',
        error: '进程崩溃',
      },
    })
  })
})

describe('kernel/decide 删除任务与 run.removed（D13）', () => {
  const removeTask = (target: View): ReturnType<typeof decide> =>
    decide(target, { type: 'task.remove', commandId: 'cmd-1', id: 't-1' }, NOW, env())

  it('task.remove：先按入队序删该任务的全部 run，再删任务', () => {
    const decision = removeTask(
      view({
        tasks: [task()],
        runs: [
          run({ id: 'run-b', queueSeq: 2 }),
          run({ id: 'run-a', queueSeq: 1 }),
          run({ id: 'run-other', taskId: 't-2', queueSeq: 3 }),
        ],
      }),
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'run.removed',
      'run.removed',
      'task.removed',
    ])
    expect(
      decision.facts.slice(0, 2).map((fact) => (fact.payload as RunRemovedPayload).runId),
    ).toEqual(['run-a', 'run-b'])
    expect((decision.facts[2]?.payload as { task: Task }).task.id).toBe('t-1')
  })

  it('task.remove：任务没有 run 时只产 task.removed', () => {
    const decision = removeTask(view({ tasks: [task()] }))

    expect(decision.facts.map((fact) => fact.type)).toEqual(['task.removed'])
  })

  it('workflow.remove：级联删任务时逐任务先删 run 再删任务', () => {
    const decision = decide(
      view({
        workflows: [workflow()],
        stages: [stage({ id: 'st-1', position: 0 })],
        tasks: [task({ id: 't-1' }), task({ id: 't-2' })],
        runs: [
          run({ id: 'run-1', taskId: 't-1', queueSeq: 1 }),
          run({ id: 'run-2', taskId: 't-1', queueSeq: 2 }),
          run({ id: 'run-3', taskId: 't-2', queueSeq: 3 }),
        ],
      }),
      { type: 'workflow.remove', commandId: 'cmd-1', id: 'wf-1' },
      NOW,
      env(),
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'workflow.removed',
      'stage.deleted',
      'run.removed',
      'run.removed',
      'task.removed',
      'run.removed',
      'task.removed',
    ])
    expect(
      decision.facts
        .filter((fact) => fact.type === 'run.removed')
        .map((fact) => (fact.payload as RunRemovedPayload).runId),
    ).toEqual(['run-1', 'run-2', 'run-3'])
  })

  it('删除事实序列自洽：project 折叠后得到 runs / tasks 删除（重建等价）', () => {
    const decision = removeTask(
      view({
        tasks: [task()],
        runs: [run({ id: 'run-a', queueSeq: 1 }), run({ id: 'run-b', queueSeq: 2 })],
      }),
    )

    const changes = decision.facts.flatMap((fact, index) => project({ ...fact, seq: index + 1 }))

    expect(changes).toEqual([
      { table: 'runs', key: 'run-a', row: null },
      { table: 'runs', key: 'run-b', row: null },
      { table: 'tasks', key: 't-1', row: null },
    ])
  })
})

describe('kernel/decide clock.tick 时间到期', () => {
  it('租约过期：attempts+1、回 queued、notBefore=now+backoff，清租约与超时', () => {
    const active = running({ leaseUntil: NOW, deadlineAt: FUTURE })
    const decision = tick(
      view({ runs: [active] }),
      env({ backoffBaseMs: 1_000, backoffCapMs: 10_000 }),
    )

    expect(decision.facts).toEqual([
      {
        type: 'run.abandoned',
        actor: { kind: 'host', via: 'timer' },
        at: NOW,
        payload: {
          run: {
            ...active,
            status: 'queued',
            attempts: 1,
            notBefore: '2026-11-04T12:00:01.000Z',
            leaseId: null,
            leaseUntil: null,
            deadlineAt: null,
          },
        },
      },
    ])
  })

  it('退避按 attempts 指数递增：第二次失败 = base × 2', () => {
    const active = running({ leaseUntil: NOW, deadlineAt: FUTURE, attempts: 1 })
    const decision = tick(
      view({ runs: [active] }),
      env({ backoffBaseMs: 1_000, backoffCapMs: 10_000 }),
    )

    expect((decision.facts[0]?.payload as { run: RunRow }).run).toMatchObject({
      attempts: 2,
      notBefore: '2026-11-04T12:00:02.000Z',
    })
  })

  it('退避封顶 backoffCapMs', () => {
    const active = running({ leaseUntil: NOW, deadlineAt: FUTURE, attempts: 5 })
    const decision = tick(
      view({ runs: [active] }),
      env({ backoffBaseMs: 1_000, backoffCapMs: 3_000, maxAttempts: 10 }),
    )

    expect((decision.facts[0]?.payload as { run: RunRow }).run.notBefore).toBe(
      '2026-11-04T12:00:03.000Z',
    )
  })

  it('attempts 达到 maxAttempts：落 run.failed{executor_lost}，不再入队', () => {
    const active = running({ leaseUntil: NOW, deadlineAt: FUTURE, attempts: 2 })
    const decision = tick(view({ runs: [active] }), env({ maxAttempts: 3 }))

    expect(decision.facts).toEqual([
      {
        type: 'run.failed',
        actor: { kind: 'host', via: 'timer' },
        at: NOW,
        payload: {
          run: settledRow(active, { status: 'failed', errorCode: 'executor_lost', attempts: 3 }),
        },
      },
    ])
  })

  it('取消后崩溃：租约过期直接落 run.cancelled，不再重排执行', () => {
    const active = running({ cancelRequested: true, leaseUntil: NOW, deadlineAt: FUTURE })
    const decision = tick(view({ runs: [active] }))

    expect(decision.facts).toEqual([
      {
        type: 'run.cancelled',
        actor: { kind: 'host', via: 'timer' },
        at: NOW,
        payload: {
          run: {
            ...active,
            status: 'cancelled',
            error: '已取消',
            errorCode: 'cancelled',
            endedAt: NOW,
            leaseId: null,
            leaseUntil: null,
            deadlineAt: null,
          },
        },
      },
    ])
  })

  it('deadlineAt 到期：优先落 run.failed{timeout}（即使租约也过期）', () => {
    const active = running({ leaseUntil: NOW, deadlineAt: NOW })
    const decision = tick(view({ runs: [active] }))

    expect(decision.facts).toEqual([
      {
        type: 'run.failed',
        actor: { kind: 'host', via: 'timeout' },
        at: NOW,
        payload: { run: settledRow(active, { status: 'failed', errorCode: 'timeout' }) },
      },
    ])
  })

  it('未到期 / 终态 / waiting：零事实', () => {
    expect(tick(view({ runs: [running({ leaseUntil: FUTURE, deadlineAt: FUTURE })] }))).toEqual({
      facts: [],
    })
    expect(
      tick(view({ runs: [running({ status: 'succeeded', leaseUntil: NOW, deadlineAt: NOW })] })),
    ).toEqual({ facts: [] })
    expect(
      tick(view({ runs: [running({ status: 'waiting', leaseUntil: NOW, deadlineAt: NOW })] })),
    ).toEqual({ facts: [] })
  })
})

describe('kernel/decide run.cancel 取消', () => {
  it('queued / running / waiting 可取消：产 run.cancel_requested 并标记 cancelRequested', () => {
    for (const status of ['queued', 'running', 'waiting'] as const) {
      const active = run({ status, leaseId: status === 'queued' ? null : 'run-1:1' })
      expect(cancel(view({ runs: [active] }))).toEqual({
        facts: [
          {
            type: 'run.cancel_requested',
            actor: { kind: 'owner', via: 'ui' },
            at: NOW,
            payload: { run: { ...active, cancelRequested: true }, by: 'owner' },
          },
        ],
      })
    }
  })

  it('终态 reject conflict；不存在 reject not_found', () => {
    expect(cancel(view({ runs: [run({ status: 'succeeded' })] }))).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '运行已结束，无法取消: run-1' },
    })
    expect(cancel(view(), 'run-missing')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '运行不存在: run-missing' },
    })
  })

  it('重复取消：零事实（幂等）', () => {
    expect(cancel(view({ runs: [run({ status: 'running', cancelRequested: true })] }))).toEqual({
      facts: [],
    })
  })
})

describe('kernel/decide run.host_settled 宿主兜底', () => {
  it('failed：默认 executor_lost，写 error/output/session/usage/duration 并清租约', () => {
    const active = running({ sessionId: 'sess-old' })
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
    const decision = hostSettle(view({ runs: [active] }), {
      status: 'failed',
      leaseId: 'run-1:1',
      turn: 1,
      error: '执行器不可达',
      output: '部分输出',
      sessionId: 'sess-new',
      usage,
      durationMs: 500,
    })

    expect(decision).toEqual({
      facts: [
        {
          type: 'run.failed',
          actor: HOST,
          at: NOW,
          payload: {
            run: settledRow(active, {
              status: 'failed',
              error: '执行器不可达',
              errorCode: 'executor_lost',
              output: '部分输出',
              sessionId: 'sess-new',
              usage,
              durationMs: 500,
            }),
          },
        },
      ],
    })
  })

  it('cancelled：默认 errorCode cancelled，actor host/cancel', () => {
    const active = running()
    const decision = hostSettle(view({ runs: [active] }), {
      status: 'cancelled',
      error: '已取消',
    })

    expect(decision.facts).toEqual([
      {
        type: 'run.cancelled',
        actor: { kind: 'host', via: 'cancel' },
        at: NOW,
        payload: {
          run: settledRow(active, {
            status: 'cancelled',
            error: '已取消',
            errorCode: 'cancelled',
          }),
        },
      },
    ])
  })

  it('显式 errorCode（timeout）按原值归类', () => {
    const decision = hostSettle(view({ runs: [running()] }), {
      status: 'failed',
      errorCode: 'timeout',
    })

    expect((decision.facts[0]?.payload as { run: RunRow }).run.errorCode).toBe('timeout')
  })

  it('迟到（leaseId / turn 不匹配）与重复（run 已终态）：零事实（幂等）', () => {
    expect(
      hostSettle(view({ runs: [running({ leaseId: 'run-1:2' })] }), { leaseId: 'run-1:1' }),
    ).toEqual({ facts: [] })
    expect(hostSettle(view({ runs: [running({ turn: 2 })] }), { turn: 1 })).toEqual({ facts: [] })
    expect(hostSettle(view({ runs: [running({ status: 'succeeded' })] }))).toEqual({ facts: [] })
  })

  it('未知 run reject not_found；succeeded 状态不产成功终态', () => {
    expect(hostSettle(view(), { runId: 'run-missing' })).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '运行不存在: run-missing' },
    })
    expect(hostSettle(view({ runs: [running()] }), { status: 'succeeded' })).toEqual({
      facts: [],
    })
  })
})

describe('kernel/decide 对话输入（T14a 已实现，不再 unsupported）', () => {
  it('chat.create 走已实现分支：缺智能体时 not_found', () => {
    expect(
      decide(view(), { commandId: 'm5-chat', type: 'chat.create', agentId: 'ag-404' }, NOW, env()),
    ).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '智能体不存在: ag-404' },
    })
  })
})

describe('kernel/decide 闸门流转（M11）', () => {
  const gateStage = (over: Partial<WorkflowStage> = {}): WorkflowStage =>
    stage({
      id: 'st-2',
      position: 1,
      name: '自测',
      gate: { maxFails: 2, onPassStageId: 'st-3', onFailStageId: 'st-1' },
      ...over,
    })

  const gateView = (taskOver: Partial<Task> = {}): View =>
    view({
      runs: [running()],
      workflows: [{ id: 'wf-1', name: '研发', description: '', createdAt: CREATED }],
      stages: [stage({ id: 'st-1', position: 0 }), gateStage(), stage({ id: 'st-3', position: 2 })],
      tasks: [task({ currentStageId: 'st-2', ...taskOver })],
    })

  it('pass 且证据齐全 → 走通过分支', () => {
    const decision = receive(
      gateView(),
      'run-1',
      receipt({ verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 0 }] }),
    )
    const moved = decision.facts.find((fact) => fact.type === 'task.moved')
    expect(moved?.payload).toMatchObject({ from: 'st-2', to: 'st-3' })
  })

  it('说 pass 但证据里有非 0 退出码 → 视为没结论，原地不动', () => {
    const decision = receive(
      gateView(),
      'run-1',
      receipt({ verdict: 'pass', checks: [{ cmd: 'pnpm check', exitCode: 1 }] }),
    )
    expect(
      decision.facts.some((fact) => fact.type === 'task.moved' || fact.type === 'task.completed'),
    ).toBe(false)
  })

  it('说 pass 但拿不出证据 → 视为没结论', () => {
    const decision = receive(gateView(), 'run-1', receipt({ verdict: 'pass' }))
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(false)
  })

  it('fail 未达上限 → 走未通过分支并累计次数', () => {
    const decision = receive(gateView(), 'run-1', receipt({ verdict: 'fail' }))
    const moved = decision.facts.find((fact) => fact.type === 'task.moved')
    expect(moved?.payload).toMatchObject({ from: 'st-2', to: 'st-1' })
    expect((moved?.payload as { task: Task }).task.gateFails).toBe(1)
  })

  it('fail 达上限 → 放行、打 gate:degraded 标签、记一条反馈', () => {
    const decision = receive(gateView({ gateFails: 1 }), 'run-1', receipt({ verdict: 'fail' }))
    const moved = decision.facts.find((fact) => fact.type === 'task.moved')
    const movedTask = (moved?.payload as { task: Task }).task
    expect(movedTask.currentStageId).toBe('st-3')
    expect(movedTask.labels).toContain('gate:degraded')
    expect(movedTask.gateFails).toBe(0)
    const comment = decision.facts.find((fact) => fact.type === 'task.comment_added')
    expect(comment?.payload).toMatchObject({
      comment: { taskId: 't-1', author: 'agent' },
    })
  })
})

describe('kernel/decide 闸门标签与放行留痕（M11 补充）', () => {
  const gateStage = (over: Partial<WorkflowStage> = {}): WorkflowStage =>
    stage({
      id: 'st-2',
      position: 1,
      name: '自测',
      gate: { maxFails: 2, onPassStageId: 'st-3', onFailStageId: 'st-1' },
      ...over,
    })

  const gateView = (taskOver: Partial<Task> = {}): View =>
    view({
      runs: [running()],
      workflows: [{ id: 'wf-1', name: '研发', description: '', createdAt: CREATED }],
      stages: [stage({ id: 'st-1', position: 0 }), gateStage(), stage({ id: 'st-3', position: 2 })],
      tasks: [task({ currentStageId: 'st-2', ...taskOver })],
    })

  it('fail 达上限且任务已有 gate:degraded 标签：标签不重复追加', () => {
    const decision = receive(
      gateView({ gateFails: 1, labels: ['gate:degraded'] }),
      'run-1',
      receipt({ verdict: 'fail' }),
    )
    const moved = decision.facts.find((fact) => fact.type === 'task.moved')
    const movedTask = (moved?.payload as { task: Task }).task
    expect(movedTask.labels.filter((label) => label === 'gate:degraded')).toHaveLength(1)
  })

  it('放行留痕的文案：闸门配置缺省时次数按 0 算，配置齐全时用配置值', () => {
    expect(degradedCommentText('自测', undefined)).toBe(
      '闸门「自测」已连续 0 次未通过，按配置放行（任务已打 gate:degraded 标签）。',
    )
    expect(degradedCommentText('自测', null)).toBe(
      '闸门「自测」已连续 0 次未通过，按配置放行（任务已打 gate:degraded 标签）。',
    )
    expect(degradedCommentText('自测', 2)).toBe(
      '闸门「自测」已连续 2 次未通过，按配置放行（任务已打 gate:degraded 标签）。',
    )
  })
})
describe('kernel/decide run.receipt 评审结论（M14）', () => {
  const reviewStages = (): WorkflowStage[] => [
    stage({ id: 'st-review', name: '评审', position: 0, onRejectStageId: 'st-fix' }),
    stage({ id: 'st-fix', name: '修复', position: 1 }),
    stage({ id: 'st-done', name: '归档', position: 2, entryMode: 'none', agentId: null }),
  ]

  const seeded = (over: Partial<ReviewReport> = {}): ReviewReport => ({
    id: 'run-review:1',
    taskId: 't-1',
    stageId: 'st-review',
    runId: 'run-review',
    threadId: null,
    rev: 1,
    verdict: 'fail',
    checks: [{ cmd: 'pnpm check', exitCode: 1 }],
    findings: [
      {
        id: 'run-review:1#R1',
        key: 'R1',
        severity: 'high',
        location: 'src/a.ts:64',
        claim: 'BOM 文件被判非法 JSON',
        evidence: null,
        requiredAction: '改成 utf-8-sig 后复跑',
        status: 'open',
        note: null,
        addressedByRunId: null,
        updatedAt: CREATED,
      },
    ],
    artifact: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  })

  const reviewView = (taskOver: Partial<Task> = {}, reportOver: Partial<ReviewReport> = {}): View =>
    view({
      runs: [running()],
      workflows: [workflow()],
      stages: reviewStages(),
      tasks: [task({ currentStageId: 'st-fix', ...taskOver })],
      reviewReports: [seeded(reportOver)],
    })

  it('评审轮回执带 verdict + findings：产 review.reported（rev / id / 判定证据入行）', () => {
    const decision = receive(
      view({ runs: [running()], workflows: [workflow()], stages: reviewStages(), tasks: [task()] }),
      'run-1',
      receipt({
        verdict: 'fail',
        checks: [{ cmd: 'pnpm check', exitCode: 1 }],
        findings: [
          {
            key: 'R1',
            severity: 'high',
            claim: 'BOM',
            requiredAction: '复跑',
            location: 'src/a.ts:1',
          },
          { key: 'R2', severity: 'low', claim: '文案', requiredAction: '改文案' },
        ],
      }),
    )
    const reported = decision.facts.find((fact) => fact.type === 'review.reported')
    const row = (reported?.payload as { report: ReviewReport }).report
    expect(row.id).toBe('run-1:1')
    expect(row.rev).toBe(1)
    expect(row.verdict).toBe('fail')
    expect(row.findings.map((item) => item.id)).toEqual(['run-1:1#R1', 'run-1:1#R2'])
    expect(row.checks).toEqual([{ cmd: 'pnpm check', exitCode: 1 }])
  })

  it('修复轮没逐条回应：停在原阶段（不打回、不前进），并追加漏项评论', () => {
    const decision = receive(reviewView(), 'run-1', receipt())
    expect(decision.facts.some((fact) => fact.type === 'run.succeeded')).toBe(true)
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(false)
    expect(decision.facts.some((fact) => fact.type === 'task.completed')).toBe(false)
    const comment = decision.facts.find(
      (fact) =>
        fact.type === 'task.comment_added' &&
        (fact.payload as { comment: { text: string } }).comment.text.includes('未处置条目'),
    )
    expect(comment).toBeDefined()
  })

  it('修复轮逐条回应且检查通过：照常前进到下一阶段', () => {
    const decision = receive(
      reviewView(),
      'run-1',
      receipt({
        addresses: [{ findingId: 'run-review:1#R1', disposition: 'fixed', checkRef: 'cmd-0' }],
        checks: [{ cmd: 'cmd-0', exitCode: 0 }],
      }),
    )
    const moved = decision.facts.find((fact) => fact.type === 'task.moved')
    expect((moved?.payload as { to: string }).to).toBe('st-done')
    expect(decision.facts.some((fact) => fact.type === 'review.addressed')).toBe(true)
  })

  it('rejected / deferred 带理由也算处置完成（留痕后放行）', () => {
    const decision = receive(
      reviewView(),
      'run-1',
      receipt({
        addresses: [{ findingId: 'run-review:1#R1', disposition: 'deferred', note: '下轮一起改' }],
      }),
    )
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(true)
  })
})

describe('kernel/commands/run 阶段内多轮自修复（M21）', () => {
  const acceptanceStage = (over: Partial<WorkflowStage> = {}): WorkflowStage =>
    stage({
      acceptance: ['pnpm check 退出码 0', '覆盖每条验收标准'],
      maxRounds: 2,
      ...over,
    })

  /** 一条正在跑、等待回执的 run（lease 与 `receipt()` 默认值配套）。 */
  const activeRun = (): RunRow => running({ sessionId: 'ss-1' })

  /** 「已完成」内置阶段：默认流转的终点，用来验证「全达 → 正常流转」。 */
  const doneStage = (): WorkflowStage =>
    stage({
      id: 'st-done',
      name: '已完成',
      position: 1,
      entryMode: 'none',
      agentId: null,
      builtin: 'done',
      acceptance: [],
    })

  const baseSeed = (over: Partial<Seed> = {}): Seed => ({
    runs: [activeRun()],
    runtimes: [runtime()],
    agents: [agent()],
    workflows: [workflow()],
    tasks: [task()],
    stages: [acceptanceStage({ onCompleteStageId: 'st-done' }), doneStage()],
    ...over,
  })

  const submit = (target: View, body: Receipt, environment = env()): ReturnType<typeof decide> =>
    decide(target, { type: 'run.receipt', runId: 'run-1', receipt: body }, NOW, environment)

  it('验收未全达且还有轮次：原地续一轮，不流转', () => {
    const decision = submit(
      view(baseSeed()),
      receipt({
        acceptance: [
          { no: 1, met: true },
          { no: 2, met: false },
        ],
      }),
    )
    const comment = decision.facts.find((fact) => fact.type === 'task.comment_added')
    expect(comment).toBeDefined()
    expect((comment!.payload as { comment: { text: string } }).comment.text).toBe(
      repairCommentText(1, 2, ['覆盖每条验收标准'], false),
    )
    const queued = decision.facts.filter((fact) => fact.type === 'run.queued')
    expect(queued).toHaveLength(1)
    const nextRun = (queued[0].payload as { run: RunRow }).run
    expect(nextRun.status).toBe('queued')
    expect(nextRun.stageId).toBe('st-1')
    expect(nextRun.taskId).toBe('t-1')
    // 同一任务续接同一会话：不换 agent、不开新会话
    expect(nextRun.resumeSessionId).toBe('ss-1')
    // 不流转：没有 task.moved / task.completed
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(false)
  })

  it('轮次用尽：只留评论，仍按原规则流转（不续轮、不打标签覆盖流转）', () => {
    const decision = submit(
      view(
        baseSeed({
          stages: [acceptanceStage({ maxRounds: 1, onCompleteStageId: 'st-done' }), doneStage()],
        }),
      ),
      receipt({ acceptance: [{ no: 1, met: false }] }),
    )
    const comment = decision.facts.find((fact) => fact.type === 'task.comment_added')
    expect(comment).toBeDefined()
    expect((comment!.payload as { comment: { text: string } }).comment.text).toContain(
      '已达本阶段轮次上限',
    )
    expect(decision.facts.some((fact) => fact.type === 'run.queued')).toBe(false)
    // 流转仍走配置的「完成后进入」
    const moved = decision.facts.find((fact) => fact.type === 'task.moved')
    expect(moved).toBeDefined()
    expect((moved!.payload as { to: string }).to).toBe('st-done')
  })

  it('验收全达：不产自评评论、不续轮，正常流转', () => {
    const decision = submit(
      view(baseSeed()),
      receipt({
        acceptance: [
          { no: 1, met: true },
          { no: 2, met: true },
        ],
      }),
    )
    expect(decision.facts.some((fact) => fact.type === 'task.comment_added')).toBe(false)
    expect(decision.facts.some((fact) => fact.type === 'run.queued')).toBe(false)
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(true)
  })

  it('回执缺条目按未达处理（fail-closed）：只说达成第一条也算没做完', () => {
    const decision = submit(view(baseSeed()), receipt({ acceptance: [{ no: 1, met: true }] }))
    expect(decision.facts.some((fact) => fact.type === 'run.queued')).toBe(true)
  })

  it('回执没带验收自评：全部条目按未达处理（0/2 达成，仍续轮）', () => {
    const decision = submit(view(baseSeed()), receipt())
    const comment = decision.facts.find((fact) => fact.type === 'task.comment_added')
    expect((comment!.payload as { comment: { text: string } }).comment.text).toContain('0/2 达成')
    expect(decision.facts.some((fact) => fact.type === 'run.queued')).toBe(true)
  })

  it('阶段没配轮次上限：按默认下限 1 轮算，首轮即用尽，只留评论不续轮', () => {
    const decision = submit(
      view(
        baseSeed({
          stages: [acceptanceStage({ maxRounds: null, onCompleteStageId: 'st-done' }), doneStage()],
        }),
      ),
      receipt({ acceptance: [{ no: 1, met: false }] }),
    )
    const comment = decision.facts.find((fact) => fact.type === 'task.comment_added')
    expect((comment!.payload as { comment: { text: string } }).comment.text).toContain(
      '已达本阶段轮次上限',
    )
    expect(decision.facts.some((fact) => fact.type === 'run.queued')).toBe(false)
  })

  it('本轮没有 sessionId：续轮沿用上一轮要续接的会话（resumeSessionId）', () => {
    const decision = submit(
      view(baseSeed({ runs: [running({ sessionId: null, resumeSessionId: 'ss-old' })] })),
      receipt({ acceptance: [{ no: 2, met: false }] }),
    )
    const queued = decision.facts.filter((fact) => fact.type === 'run.queued')
    expect((queued[0].payload as { run: RunRow }).run.resumeSessionId).toBe('ss-old')
  })

  it('本轮与上一轮都没有会话：续轮不带 resumeSessionId（不伪造续接）', () => {
    const decision = submit(
      view(baseSeed({ runs: [running({ sessionId: null })] })),
      receipt({ acceptance: [{ no: 2, met: false }] }),
    )
    const queued = decision.facts.filter((fact) => fact.type === 'run.queued')
    expect(queued).toHaveLength(1)
    expect((queued[0].payload as { run: RunRow }).run.resumeSessionId).toBeNull()
  })

  it('unmetAcceptance：阶段没声明验收条目时没有未达项（不误判成没做完）', () => {
    expect(unmetAcceptance({ acceptance: [] }, receipt())).toEqual([])
    // 老事实 / 存量导入的阶段行连字段都没有：同样按「未声明」处理
    expect(unmetAcceptance({}, receipt())).toEqual([])
    expect(unmetAcceptance({ acceptance: ['覆盖每条验收标准'] }, receipt())).toEqual([
      '覆盖每条验收标准',
    ])
  })

  it('阶段没声明验收 / run 失败 / 任务已完成：都不续轮', () => {
    const noAcceptance = submit(
      view(baseSeed({ stages: [acceptanceStage({ acceptance: [] })] })),
      receipt({ acceptance: [{ no: 1, met: false }] }),
    )
    expect(noAcceptance.facts.some((fact) => fact.type === 'task.comment_added')).toBe(false)

    const failed = submit(
      view(baseSeed({ runs: [running({ status: 'failed', errorCode: 'exit_nonzero' })] })),
      receipt({ status: 'failed', errorCode: 'exit_nonzero', acceptance: [{ no: 2, met: false }] }),
    )
    expect(failed.facts.some((fact) => fact.type === 'run.queued')).toBe(false)

    const done = submit(
      view(baseSeed({ tasks: [task({ status: 'completed' })] })),
      receipt({ acceptance: [{ no: 2, met: false }] }),
    )
    expect(done.facts.some((fact) => fact.type === 'run.queued')).toBe(false)
  })

  it('stageRoundCount 按 (任务, 阶段) 数 stage run：派生轮数，不新增列', () => {
    const target = view({
      runs: [
        run({ id: 'r1', stageId: 'st-1' }),
        run({ id: 'r2', stageId: 'st-1' }),
        run({ id: 'r3', stageId: 'st-2' }),
        run({ id: 'r4', purpose: 'chat', stageId: 'st-1' }),
      ],
    })
    expect(stageRoundCount(target, 't-1', 'st-1')).toBe(2)
    expect(stageRoundCount(target, 't-1', 'st-2')).toBe(1)
    expect(stageRoundCount(target, 't-9', 'st-1')).toBe(0)
  })

  it('repairCommentText：达成计数、未达清单与下一步说明都在文案里', () => {
    const continuing = repairCommentText(1, 3, ['覆盖每条验收标准', '不改 schema'], false)
    expect(continuing).toContain('1/3 达成')
    expect(continuing).toContain('1. 覆盖每条验收标准')
    expect(continuing).toContain('2. 不改 schema')
    expect(continuing).toContain('按配置续第 2 轮')

    const exhausted = repairCommentText(2, 3, ['覆盖每条验收标准'], true)
    expect(exhausted).toContain('已达本阶段轮次上限')
  })
})

describe('kernel/runAccessOf（M28：闸门阶段至少 full）', () => {
  it('闸门阶段强制 full；非闸门阶段按智能体权限折算', () => {
    expect(runAccessOf({ gate: { maxFails: 1 } }, 'workspace-write')).toBe('full')
    expect(runAccessOf({ gate: { maxFails: 1 } }, 'read-only')).toBe('full')
    expect(runAccessOf({ gate: null }, 'workspace-write')).toBe('edit')
    expect(runAccessOf({}, 'danger-full-access')).toBe('full')
    expect(runAccessOf({ gate: null }, 'read-only')).toBe('read')
  })
})

describe('kernel/decide 阶段交付物（M28）', () => {
  it('回执 deliverables 落到终态 run 行；没声明时保留上一轮的值', () => {
    const active = running()
    const decision = receive(
      view({ runs: [active] }),
      'run-1',
      receipt({
        deliverables: {
          branch: 'feat/x',
          base: 'develop',
          commits: ['57be895'],
          files: ['src/a.ts', 'src/b.ts'],
          gates: [{ cmd: 'pnpm check', exitCode: 0 }],
        },
      }),
    )
    const settled = (decision.facts[0]?.payload as { run: RunRow }).run
    expect(settled.deliverables).toEqual({
      branch: 'feat/x',
      base: 'develop',
      commits: ['57be895'],
      files: ['src/a.ts', 'src/b.ts'],
      gates: [{ cmd: 'pnpm check', exitCode: 0 }],
    })

    // 续接轮没重复声明：沿用上一轮（否则下游会以为交付物消失了）
    const continued = receive(
      view({
        runs: [
          running({
            deliverables: {
              branch: 'feat/x',
              base: 'develop',
              commits: [],
              files: [],
              gates: [],
            },
          }),
        ],
      }),
      'run-1',
      receipt({ deliverables: undefined }),
    )
    const kept = (continued.facts[0]?.payload as { run: RunRow }).run
    expect(kept.deliverables?.branch).toBe('feat/x')
  })

  it('只声明一部分（校验允许的形状）也落成五项齐全：缺项补 null / 空数组', () => {
    const decision = receive(
      view({ runs: [running()] }),
      'run-1',
      // `{branch}` 是 validate 明确放行的形状；不补齐的话下游读 `commits.length` 会崩
      receipt({ deliverables: { branch: 'feat/x' } }),
    )
    const settled = (decision.facts[0]?.payload as { run: RunRow }).run
    expect(settled.deliverables).toEqual({
      branch: 'feat/x',
      base: null,
      commits: [],
      files: [],
      gates: [],
    })
  })
})
