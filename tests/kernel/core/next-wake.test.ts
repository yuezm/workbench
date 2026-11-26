// @vitest-environment node
/**
 * `nextWakeAt` 的黄金用例（T7）：租约 / 超时 / 退避三类到期的最早未来时刻。
 * 夹具只装 runs 切片；内核不读时钟，`now` 由测试注入。
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Card, RunRow } from '@workbench/protocol/entities'
import type { AutomationRule } from '@workbench/protocol/rules'
import { STALL_REMIND_DELAYS_MS } from '@workbench/protocol/channels'
import { nextWakeAt } from '@workbench/kernel/core/next-wake'
import type { Environment, IdKind, Limits, View } from '@workbench/kernel/core/types'

const NOW = '2026-11-04T12:00:00.000Z'
const FUTURE = '2026-11-04T13:00:00.000Z'
const PAST = '2026-11-04T11:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'

const limits = (): Limits => ({
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
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'running',
  prompt: 'prompt',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: NOW,
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
  leaseId: 'run-1:1',
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  ...over,
})

const view = (runs: RunRow[], rules: AutomationRule[] = [], cards: Card[] = []): View => ({
  seq: 0,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(runs.map((row) => [row.id, row])),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(cards.map((row) => [row.id, row])),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  rules,
  rulesVersion: rules.length === 0 ? 0 : 1,
  ruleSetReplacedAt: rules.length === 0 ? null : CREATED,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const env = (): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: limits(),
  nextId: (kind: IdKind) => `${kind}-1`,
})

describe('kernel/next-wake', () => {
  it('无 run / 终态 run：返回 null', () => {
    expect(nextWakeAt(view([]), NOW, env())).toBeNull()
    expect(
      nextWakeAt(
        view([run({ status: 'succeeded', leaseUntil: FUTURE, deadlineAt: FUTURE })]),
        NOW,
        env(),
      ),
    ).toBeNull()
  })

  it('running：取 leaseUntil 与 deadlineAt 的最早者', () => {
    const target = view([
      run({
        id: 'run-1',
        leaseUntil: '2026-11-04T12:02:00.000Z',
        deadlineAt: '2026-11-04T12:30:00.000Z',
      }),
      run({
        id: 'run-2',
        leaseUntil: '2026-11-04T12:05:00.000Z',
        deadlineAt: '2026-11-04T12:10:00.000Z',
      }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBe('2026-11-04T12:02:00.000Z')
  })

  it('queued：notBefore 参与最早时刻比较', () => {
    const target = view([
      run({
        id: 'run-1',
        leaseUntil: '2026-11-04T12:10:00.000Z',
        deadlineAt: FUTURE,
      }),
      run({
        id: 'run-2',
        status: 'queued',
        leaseUntil: null,
        notBefore: '2026-11-04T12:05:00.000Z',
      }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBe('2026-11-04T12:05:00.000Z')
  })

  it('已过去（≤ now）的时刻不算下一次唤醒', () => {
    const target = view([
      run({ id: 'run-1', leaseUntil: PAST, deadlineAt: PAST }),
      run({ id: 'run-2', status: 'queued', notBefore: PAST }),
      run({
        id: 'run-3',
        leaseUntil: '2026-11-04T12:20:00.000Z',
        deadlineAt: FUTURE,
      }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBe('2026-11-04T12:20:00.000Z')
  })

  it('waiting 与终态不参与；无到期返回 null', () => {
    const target = view([
      run({ id: 'run-1', status: 'waiting', leaseUntil: FUTURE, deadlineAt: FUTURE }),
      run({ id: 'run-2', status: 'cancelled', leaseUntil: FUTURE, deadlineAt: FUTURE }),
      run({ id: 'run-3', status: 'queued', notBefore: null }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBeNull()
  })

  it('cron 规则参与最早时刻（Asia/Shanghai 09:00 = 01:00Z）', () => {
    const cronRule: AutomationRule = {
      id: 'rule-1',
      name: '每日早报',
      when: { cron: '0 9 * * *' },
      to: { workflowId: 'wf-1' },
      enabled: true,
    }
    // NOW = 2026-11-04T20:00 Shanghai；下一次 2026-11-05 09:00 本地 = 01:00Z
    expect(nextWakeAt(view([], [cronRule]), NOW, env())).toBe('2026-11-05T01:00:00.000Z')
  })

  it('停用 / 非法 cron 不参与；cron 与 run 到期取更早者', () => {
    const disabled: AutomationRule = {
      id: 'rule-1',
      name: '停用',
      when: { cron: '0 9 * * *' },
      to: { workflowId: 'wf-1' },
      enabled: false,
    }
    const invalid: AutomationRule = {
      id: 'rule-2',
      name: '非法',
      when: { cron: 'bad' },
      to: { workflowId: 'wf-1' },
      enabled: true,
    }
    expect(nextWakeAt(view([], [disabled, invalid]), NOW, env())).toBeNull()

    const early = run({ leaseUntil: '2026-11-04T12:05:00.000Z' })
    const cronRule: AutomationRule = {
      id: 'rule-1',
      name: '每日早报',
      when: { cron: '0 9 * * *' },
      to: { workflowId: 'wf-1' },
      enabled: true,
    }
    expect(nextWakeAt(view([early], [cronRule]), NOW, env())).toBe('2026-11-04T12:05:00.000Z')
  })
})

/** 卡片行（模块级：M41 的重投排期与后面的性质用例共用）。 */
const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
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
  delivery: 'failed',
  deliveryRef: null,
  deliveryAttempts: 1,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

describe('kernel/next-wake · 卡片重投排期（M41）', () => {
  it('最早的重投时刻参与下一次唤醒', () => {
    const due = card({ nextDeliveryAt: FUTURE })
    expect(nextWakeAt(view([], [], [due]), NOW, env())).toBe(FUTURE)
  })

  it('已放弃的卡没有排期（不空转）', () => {
    const given = card({ nextDeliveryAt: null, deliveryGivenUp: true })
    expect(nextWakeAt(view([], [], [given]), NOW, env())).toBeNull()
  })
})

/**
 * M55：停机卡到点要能自己把宿主叫醒（否则任务停住后定时器再也不会醒——
 * 2026-11-24 任务 `8b76d466` 静默挂住就是这个机制）。
 */
describe('nextWakeAt · 停机卡提醒（M55）', () => {
  const stall = (over: Partial<Card> = {}): Card => ({
    id: 'card-stall',
    runId: 'run-1',
    taskId: 't-1',
    conversationId: null,
    title: '任务停机待接手',
    text: '',
    kind: 'stall',
    options: ['我去处理'],
    key: 'stall',
    version: 1,
    status: 'open',
    delivery: 'delivered',
    deliveryRef: null,
    deliveryRefs: {},
    deliveryAttempts: 1,
    nextDeliveryAt: null,
    deliveryGivenUp: false,
    optionIndex: null,
    answeredBy: null,
    answeredByRef: null,
    answeredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  })

  it('首版 15 分钟后醒来重推', () => {
    const due = new Date(Date.parse(NOW) + 15 * 60_000).toISOString()
    expect(nextWakeAt(view([], [], [stall()]), NOW, env())).toBe(due)
  })

  it('已接手的卡不参与（不空转）', () => {
    expect(nextWakeAt(view([], [], [stall({ status: 'resolved' })]), NOW, env())).toBeNull()
  })

  it('梯度到顶后不再排期', () => {
    expect(nextWakeAt(view([], [], [stall({ version: 9 })]), NOW, env())).toBeNull()
  })
})

// —— 性质测试（fast-check）：唤醒时刻的完备性 ————————————————————————————————
//
// 「下一次唤醒」只有一个正确语义：**所有候选取值的未来最早者**，没有候选就是 null。
// 漏掉任何一类候选（running 的 deadlineAt、queued 的 notBefore、卡的重投排期、停机卡的
// 提醒梯度）都会让宿主定时器睡过头——任务停住却没人喊人，正是 M55 那次静默的机制。
//
// 所以这里的预言机不复用被测实现：它直接按「候选清单」把每个字段摊开取最小，
// 实现漏一项、多算一类状态、把过去的时刻也算进来，都会与清单对不上。
//
// 固定种子：同一份输入永远给出同一条反例；`FC_SEED` 可覆盖。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261126)
const PROPERTY_RUNS = 150

const WAKE_TIMES = [
  '2026-11-04T11:30:00.000Z', // 已过去
  '2026-11-04T12:00:00.000Z', // 正好是 now：不算「下一次」
  '2026-11-04T12:00:01.000Z',
  '2026-11-04T12:05:00.000Z',
  '2026-11-04T13:00:00.000Z',
  '2026-11-05T12:00:00.000Z',
] as const

const wakeTimeOrNullArb = fc.option(fc.constantFrom(...WAKE_TIMES), { nil: null })

const runShapeArb: fc.Arbitrary<Partial<RunRow>> = fc.record({
  status: fc.constantFrom<RunRow['status']>(
    'running',
    'queued',
    'waiting',
    'succeeded',
    'failed',
    'cancelled',
  ),
  leaseUntil: wakeTimeOrNullArb,
  deadlineAt: wakeTimeOrNullArb,
  notBefore: wakeTimeOrNullArb,
})

const cardShapeArb: fc.Arbitrary<Partial<Card>> = fc.record({
  kind: fc.constantFrom<Card['kind']>('ask', 'notice', 'stall'),
  status: fc.constantFrom<Card['status']>('open', 'answered', 'resolved'),
  version: fc.integer({ min: 1, max: 4 }),
  updatedAt: fc.constantFrom(...WAKE_TIMES),
  nextDeliveryAt: wakeTimeOrNullArb,
})

const runsArb = fc
  .array(runShapeArb, { maxLength: 4 })
  .map((rows) => rows.map((row, index) => run({ id: `run-property-${index}`, ...row })))

const cardsArb = fc
  .array(cardShapeArb, { maxLength: 3 })
  .map((rows) => rows.map((row, index) => card({ id: `card-property-${index}`, ...row })))

/** 独立预言机：按候选清单取「> now 的最早时刻」，没有候选就是 null。 */
const earliestCandidate = (runs: RunRow[], cards: Card[]): string | null => {
  const candidates: string[] = []
  for (const row of runs) {
    if (row.status === 'running') {
      if (row.leaseUntil !== null) candidates.push(row.leaseUntil)
      if (row.deadlineAt !== null) candidates.push(row.deadlineAt)
    } else if (row.status === 'queued') {
      if (row.notBefore !== null) candidates.push(row.notBefore)
    }
  }
  for (const row of cards) {
    if (row.nextDeliveryAt !== null) candidates.push(row.nextDeliveryAt)
    if (row.kind !== 'stall' || row.status !== 'open') continue
    const delay = STALL_REMIND_DELAYS_MS[row.version - 1]
    if (delay === undefined) continue
    candidates.push(new Date(Date.parse(row.updatedAt) + delay).toISOString())
  }
  const future = candidates.filter((at) => at > NOW).sort()
  return future.length === 0 ? null : (future[0] as string)
}

describe('kernel/next-wake 性质（fast-check 随机生成）', () => {
  it('结果就是候选清单里最早的未来时刻（清单空则 null）', () => {
    fc.assert(
      fc.property(runsArb, cardsArb, (runs, cards) => {
        const target = view(runs, [], cards)
        const actual = nextWakeAt(target, NOW, env())
        expect(actual, JSON.stringify({ runs, cards })).toBe(earliestCandidate(runs, cards))
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('非 null 的结果严格晚于 now，且是可直接排期的 ISO 时刻', () => {
    fc.assert(
      fc.property(runsArb, cardsArb, (runs, cards) => {
        const actual = nextWakeAt(view(runs, [], cards), NOW, env())
        if (actual === null) return
        expect(actual > NOW, actual).toBe(true)
        expect(Number.isNaN(Date.parse(actual)), actual).toBe(false)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('加一个更晚的候选不改变结果（只认最早那个）', () => {
    fc.assert(
      fc.property(runsArb, cardsArb, fc.constantFrom(...WAKE_TIMES), (runs, cards, later) => {
        const base = nextWakeAt(view(runs, [], cards), NOW, env())
        if (later <= NOW) return
        const padded = view(
          [
            ...runs,
            run({
              id: 'run-property-late',
              status: 'running',
              leaseUntil: later,
              deadlineAt: null,
            }),
          ],
          [],
          cards,
        )
        const actual = nextWakeAt(padded, NOW, env())
        expect(actual, `${later} / base ${base}`).toBe(
          base !== null && base <= later ? base : later,
        )
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})
