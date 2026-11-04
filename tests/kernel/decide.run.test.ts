/**
 * `run.claim` / `run.heartbeat` 的黄金用例（T5）：领取排序、按运行时开窗、租约计算、
 * 心跳匹配。夹具只装内核判定需要的切片（runs / runtimes），其余投影表留空。
 */
import { describe, expect, it } from 'vitest'
import type { RunRow, Runtime } from '../../src/protocol/entities'
import type { RunClaimedPayload } from '../../src/protocol/facts'
import type { Input } from '../../src/protocol/inputs'
import { decide } from '../../src/kernel/decide'
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
  protocolFamily: 'dsh',
  command: 'dsh',
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
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
  ...over,
})

interface Seed {
  runs?: RunRow[]
  runtimes?: Runtime[]
}

const view = (seed: Seed = {}): View => ({
  seq: 7,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  tasks: new Map(),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map(),
  messages: new Map(),
  activeTaskIds: new Set(),
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

describe('kernel/decide run.claim 领取', () => {
  it('超并发不领取：窗口 = maxConcurrent − running 数', () => {
    const decision = claim(
      view({
        runtimes: [runtime({ maxConcurrent: 2 })],
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

  it('窗口为 0 时零事实（running 已占满并发位）', () => {
    const decision = claim(
      view({
        runtimes: [runtime({ maxConcurrent: 2 })],
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
        runtimes: [runtime({ maxConcurrent: 1 })],
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
        runtimes: [runtime({ maxConcurrent: 2 })],
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
        runtimes: [runtime({ maxConcurrent: 8 })],
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
        runtimes: [runtime({ maxConcurrent: 8 })],
        runs: [
          run({ id: 'run-immediate' }),
          run({ id: 'run-due', notBefore: NOW }),
          run({ id: 'run-future', notBefore: FUTURE }),
        ],
      }),
    )

    expect(claimedIds(decision)).toEqual(['run-immediate', 'run-due'])
  })

  it('多运行时互不影响：各运行时按自己的窗口领取', () => {
    const target = view({
      runtimes: [
        runtime({ id: 'rt-1', maxConcurrent: 1 }),
        runtime({ id: 'rt-2', name: '本机 dsh 2', maxConcurrent: 2 }),
      ],
      runs: [
        run({ id: 'run-rt1-running', runtimeId: 'rt-1', status: 'running', attempt: 1 }),
        run({ id: 'run-rt1-queued', runtimeId: 'rt-1', createdAt: '2026-01-01T00:00:02.000Z' }),
        run({ id: 'run-rt2-1', runtimeId: 'rt-2', createdAt: '2026-01-01T00:00:03.000Z' }),
        run({ id: 'run-rt2-2', runtimeId: 'rt-2', createdAt: '2026-01-01T00:00:04.000Z' }),
        run({ id: 'run-rt2-3', runtimeId: 'rt-2', createdAt: '2026-01-01T00:00:05.000Z' }),
      ],
    })

    expect(claim(target, 'rt-1')).toEqual({ facts: [] })
    expect(claimedIds(claim(target, 'rt-2'))).toEqual(['run-rt2-1', 'run-rt2-2'])
  })

  it('capacity 大于窗口时只领取窗口数', () => {
    const decision = claim(
      view({
        runtimes: [runtime({ maxConcurrent: 3 })],
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
      view({ runtimes: [runtime({ maxConcurrent: 8 })], runs: [fresh, retry] }),
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

describe('kernel/decide 未实现的宿主输入', () => {
  it('T5 阶段统一 reject unsupported，不静默产零事实', () => {
    const pending: Input[] = [
      {
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1 },
      },
      { type: 'run.host_settled', runId: 'run-1', status: 'failed' },
      { type: 'run.cancel', runId: 'run-1' },
      { type: 'clock.tick' },
      { type: 'conversation.create', agentId: 'ag-1' },
      { type: 'conversation.send', conversationId: 'c-1', content: 'hi' },
      { type: 'conversation.rename', conversationId: 'c-1', title: '标题' },
      { type: 'conversation.remove', conversationId: 'c-1' },
    ]

    for (const each of pending) {
      expect(decide(view(), each, NOW, env())).toEqual({
        facts: [],
        reject: { code: 'unsupported', message: '输入暂未支持: ' + each.type },
      })
    }
  })
})
