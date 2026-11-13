// @vitest-environment node
/**
 * `src/kernel/cards.ts` 的决策出口：随 run / 任务结束收卡（`closeCardsOnFinish`）。
 *
 * 重点是「同批新开的卡」这条：它不在视图里（视图是上一轮的快照），只能按行造事实；
 * 而且只有属于**本批**结束的 run / 任务的卡才该收——别的卡照常开着。
 */
import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Card, RunRow } from '../../src/protocol/entities'
import { CARD_TIMEOUT_MS, closeCardsOnFinish, expiredCardFacts } from '../../src/kernel/cards'
import type { Decision, FactDraft, View } from '../../src/kernel/types'

const NOW = '2026-11-09T00:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'
/** 宿主收尾的 actor（run 终态由调度器写）。 */
const HOST = { kind: 'host', via: 'scheduler' } as const

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-a',
  taskId: 't-1',
  conversationId: null,
  title: '确认',
  text: '',
  kind: 'ask',
  options: ['好', '不好'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const view = (cards: Card[] = [], runs: RunRow[] = []): View => ({
  seq: 7,
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
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

/** run 终态事实：只有 run id 被收卡逻辑读到。 */
const runFinished = (runId: string): FactDraft =>
  ({
    type: 'run.succeeded',
    actor: HOST,
    at: NOW,
    payload: { run: { id: runId } },
  }) as unknown as FactDraft

/** 同批新开一张卡（回执成功的同时给了 notices）。 */
const cardOpened = (row: Card): FactDraft =>
  ({
    type: 'card.opened',
    actor: HOST,
    at: NOW,
    payload: { card: row },
  }) as unknown as FactDraft

describe('closeCardsOnFinish（决策出口：随结束收卡）', () => {
  it('本批结束的 run 名下、视图里仍 open 的卡：补一条 card.resolved', () => {
    const open = card({ id: 'card-old', runId: 'run-a' })
    const decision: Decision = { facts: [runFinished('run-a')] }

    const result = closeCardsOnFinish(view([open]), decision, NOW)
    const resolved = result.facts.find((fact) => fact.type === 'card.resolved')
    expect(resolved?.payload).toMatchObject({ card: { id: 'card-old', status: 'resolved' } })
  })

  it('同批新开的卡属于本批结束的 run：同批收掉（它不在视图里，按行造事实）', () => {
    const fresh = card({ id: 'card-new', runId: 'run-a' })
    const decision: Decision = { facts: [runFinished('run-a'), cardOpened(fresh)] }

    const result = closeCardsOnFinish(view(), decision, NOW)
    const resolved = result.facts.find((fact) => fact.type === 'card.resolved')
    expect(resolved?.payload).toMatchObject({ card: { id: 'card-new', status: 'resolved' } })
  })

  it('同批新开的卡不属于本批结束的 run：照常开着，不被误收', () => {
    // 回执开了另一条 run 的卡，而本批结束的是 run-a：card-b 不该被收
    const other = card({ id: 'card-other', runId: 'run-b' })
    const decision: Decision = { facts: [runFinished('run-a'), cardOpened(other)] }

    const result = closeCardsOnFinish(view(), decision, NOW)
    expect(result.facts.some((fact) => fact.type === 'card.resolved')).toBe(false)
    expect(result).toBe(decision)
  })

  it('本批没有 run / 任务结束：零事实（决策原样返回）', () => {
    const decision: Decision = { facts: [cardOpened(card({ id: 'card-x', runId: 'run-a' }))] }
    expect(closeCardsOnFinish(view(), decision, NOW)).toBe(decision)
  })

  it('本批已答 / 已关的卡不再补一条关闭', () => {
    const open = card({ id: 'card-answered', runId: 'run-a' })
    const decision: Decision = {
      facts: [
        runFinished('run-a'),
        {
          type: 'card.answered',
          actor: HOST,
          at: NOW,
          payload: { card: open },
        } as unknown as FactDraft,
      ],
    }

    const result = closeCardsOnFinish(view([open]), decision, NOW)
    expect(result.facts.some((fact) => fact.type === 'card.resolved')).toBe(false)
  })
})

/** 等待中的 run（超时续接需要它的 id / turn / sessionId）。 */
const waitingRun = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-a',
    purpose: 'stage',
    taskId: 't-1',
    conversationId: null,
    stageId: 'st-1',
    agentId: 'ag-1',
    runtimeId: 'rt-1',
    ruleId: null,
    rulesVersion: 0,
    executorKey: 'dsh',
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
    queueSeq: 1,
    status: 'waiting',
    prompt: '',
    output: '',
    error: null,
    errorCode: null,
    exitCode: null,
    sessionId: 'sess-1',
    usage: null,
    durationMs: null,
    leaseId: null,
    attempt: 1,
    attempts: 0,
    leaseUntil: null,
    notBefore: null,
    deadlineAt: null,
    cancelRequested: false,
    deliverables: null,
    startedAt: CREATED,
    endedAt: null,
    createdAt: CREATED,
    ...over,
  }) as RunRow

describe('expiredCardFacts（M28：卡片超时）', () => {
  const later = (ms: number): string => new Date(Date.parse(CREATED) + ms).toISOString()

  it('到期且 run 仍 waiting：关掉 ask 卡并续接一轮，提示词列出超时问题', () => {
    const ask = card({ id: 'card-old', title: '方案选型' })
    const decision = expiredCardFacts(view([ask], [waitingRun()]), later(CARD_TIMEOUT_MS + 1000))

    const resolved = decision.filter((fact) => fact.type === 'card.resolved')
    expect(resolved).toHaveLength(1)
    expect((resolved[0]?.payload as { reason: string }).reason).toBe('expired')
    expect(resolved[0]?.actor).toEqual({ kind: 'host', via: 'timer' })

    const queued = decision.find((fact) => fact.type === 'run.queued')
    const run = (queued?.payload as { run: RunRow }).run
    expect(run.status).toBe('queued')
    expect(run.turn).toBe(2)
    expect(run.resumeSessionId).toBe('sess-1')
    expect(run.prompt).toContain('# 卡片超时')
    expect(run.prompt).toContain('方案选型')
    expect(run.prompt).toContain('好 / 不好')
  })

  it('未到期 / 非 ask / run 不在 waiting：零事实', () => {
    const ask = card({ id: 'card-fresh' })
    expect(expiredCardFacts(view([ask], [waitingRun()]), later(CARD_TIMEOUT_MS - 1000))).toEqual([])
    const notice = card({ id: 'card-notice', kind: 'notice', options: [] })
    expect(expiredCardFacts(view([notice], [waitingRun()]), later(CARD_TIMEOUT_MS + 1000))).toEqual(
      [],
    )
    const done = card({ id: 'card-answered', status: 'answered', optionIndex: 0 })
    expect(expiredCardFacts(view([done], [waitingRun()]), later(CARD_TIMEOUT_MS + 1000))).toEqual(
      [],
    )
    const running = waitingRun({ status: 'running' })
    expect(expiredCardFacts(view([ask], [running]), later(CARD_TIMEOUT_MS + 1000))).toEqual([])
    // 聊天 run 不超时续接：没人问话时助手自己接着说一轮不是「继续干活」
    const chat = waitingRun({ purpose: 'chat', taskId: null, stageId: null, conversationId: 'c-1' })
    expect(expiredCardFacts(view([ask], [chat]), later(CARD_TIMEOUT_MS + 1000))).toEqual([])
    // run 行缺失（脏投影）：只跳过，不炸
    expect(expiredCardFacts(view([ask], []), later(CARD_TIMEOUT_MS + 1000))).toEqual([])
  })

  it('同一 run 多张卡：一起关，只续接一次', () => {
    const first = card({ id: 'card-a', title: 'A' })
    const second = card({ id: 'card-b', title: 'B', createdAt: later(1000) })
    const decision = expiredCardFacts(
      view([first, second], [waitingRun()]),
      later(CARD_TIMEOUT_MS + 60_000),
    )
    expect(decision.filter((fact) => fact.type === 'card.resolved')).toHaveLength(2)
    const queued = decision.filter((fact) => fact.type === 'run.queued')
    expect(queued).toHaveLength(1)
    expect((queued[0]?.payload as { run: RunRow }).run.prompt).toContain('A')
    expect((queued[0]?.payload as { run: RunRow }).run.prompt).toContain('B')
  })
})

// —— 性质测试（fast-check）：随结束收卡的因果 ————————————————————————————————————
//
// 示例用例是「一张本批结束 run 的卡 + 一张别的 run 的卡」这类手挑组合。这里随机生成
// 任意卡片状态 × 任意本批事实，断言五条因果：
// ① 原事实前缀原样保留，追加的只有 `card.resolved`；
// ② 被收的卡必属于本批结束的 run / 任务；
// ③ 视图里非 open 的卡永不被收，本批新开的卡按 run 是否结束决定；
// ④ 本批已经答 / 关过的卡不补第二条关闭；⑤ 同卡至多一条、重复调用幂等。
// 固定种子，反例可复现（`FC_SEED` 换一批）。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261113)
const PROPERTY_RUNS = 100

const taskFinished = (taskId: string): FactDraft =>
  ({
    type: 'task.completed',
    actor: HOST,
    at: NOW,
    payload: { task: { id: taskId } },
  }) as unknown as FactDraft

const cardAnswered = (row: Card): FactDraft =>
  ({
    type: 'card.answered',
    actor: HOST,
    at: NOW,
    payload: { card: row, by: 'ui' },
  }) as unknown as FactDraft

const cardResolved = (row: Card): FactDraft =>
  ({
    type: 'card.resolved',
    actor: HOST,
    at: NOW,
    payload: { card: row, reason: 'manual' },
  }) as unknown as FactDraft

const propertyCardArb: Arbitrary<Card> = fc
  .tuple(
    fc.constantFrom('c1', 'c2', 'c3', 'c4', 'c5'),
    fc.constantFrom('run-a', 'run-b'),
    fc.constantFrom('t-1', 't-2', null),
    fc.constantFrom<Card['status']>('open', 'answered', 'resolved'),
  )
  .map(([id, runId, taskId, status]): Card => card({ id, runId, taskId, status }))

const propertyCardsArb: Arbitrary<Card[]> = fc.uniqueArray(propertyCardArb, {
  selector: (row) => row.id,
  maxLength: 5,
})

const finishedFactArb: Arbitrary<FactDraft> = fc.oneof(
  fc.constantFrom('run-a', 'run-b').map((runId) => runFinished(runId)),
  fc.constantFrom('t-1', 't-2').map((taskId) => taskFinished(taskId)),
)

const touchedFactArb: Arbitrary<FactDraft> = fc
  .tuple(fc.constantFrom('c1', 'c2', 'c3', 'c4', 'c5'), fc.constantFrom('answered', 'resolved'))
  .map(([id, kind]) =>
    kind === 'answered' ? cardAnswered(card({ id })) : cardResolved(card({ id })),
  )

/** 本批新开的卡：不在视图里，run / task 也可能不在本批结束范围内。 */
const openedFactArb: Arbitrary<FactDraft> = fc
  .tuple(fc.constantFrom('run-a', 'run-b'), fc.constantFrom('t-1', 't-2', null))
  .map(([runId, taskId]) =>
    cardOpened(card({ id: `c-new-${String(runId)}-${String(taskId)}`, runId, taskId })),
  )

const batchArb: Arbitrary<FactDraft[]> = fc.array(
  fc.oneof(finishedFactArb, touchedFactArb, openedFactArb),
  { maxLength: 4 },
)

/** 本批结束的 run / 任务 id（与实现同口径，独立算一遍）。 */
const finishedOf = (facts: readonly FactDraft[]): { runs: Set<string>; tasks: Set<string> } => {
  const runs = new Set<string>()
  const tasks = new Set<string>()
  for (const fact of facts) {
    if (
      fact.type === 'run.succeeded' ||
      fact.type === 'run.failed' ||
      fact.type === 'run.cancelled'
    ) {
      runs.add((fact.payload as { run: { id: string } }).run.id)
    }
    if (fact.type === 'task.completed') {
      tasks.add((fact.payload as { task: { id: string } }).task.id)
    }
  }
  return { runs, tasks }
}

/** 追加的 `card.resolved` 卡 id（跳过本批原有的那批事实）。 */
const appendedClosedIds = (facts: readonly FactDraft[], from: number): string[] =>
  facts
    .slice(from)
    .filter((fact) => fact.type === 'card.resolved')
    .map((fact) => (fact.payload as { card: Card }).card.id)

describe('closeCardsOnFinish 的性质（fast-check 随机生成）', () => {
  it('原事实前缀原样保留，追加的只有 card.resolved', () => {
    fc.assert(
      fc.property(propertyCardsArb, batchArb, (cards, facts) => {
        const result = closeCardsOnFinish(view(cards), { facts }, NOW)
        expect(result.facts.slice(0, facts.length)).toEqual(facts)
        for (const fact of result.facts.slice(facts.length)) expect(fact.type).toBe('card.resolved')
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('被收的卡必属于本批结束的 run / 任务', () => {
    fc.assert(
      fc.property(propertyCardsArb, batchArb, (cards, facts) => {
        const { runs, tasks } = finishedOf(facts)
        const result = closeCardsOnFinish(view(cards), { facts }, NOW)
        const byId = new Map(cards.map((row) => [row.id, row]))
        /** 同批新开的卡按行携带（不在视图里），覆盖视图行的口径与实现一致 */
        const openedById = new Map(
          facts
            .filter((fact) => fact.type === 'card.opened')
            .map((fact) => (fact.payload as { card: Card }).card)
            .map((row) => [row.id, row]),
        )
        for (const id of appendedClosedIds(result.facts, facts.length)) {
          const row = openedById.get(id) ?? byId.get(id)
          expect(row).toBeDefined()
          const hit =
            row !== undefined &&
            ((row.runId !== null && runs.has(row.runId)) ||
              (row.taskId !== null && tasks.has(row.taskId)))
          expect(hit).toBe(true)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('视图里非 open 的卡永不被收', () => {
    fc.assert(
      fc.property(propertyCardsArb, batchArb, (cards, facts) => {
        const result = closeCardsOnFinish(view(cards), { facts }, NOW)
        const closed = new Set(appendedClosedIds(result.facts, facts.length))
        for (const row of cards) {
          if (row.status === 'open') continue
          expect(closed.has(row.id)).toBe(false)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('本批已经答 / 关过的卡不补第二条关闭；同一张卡至多一条 resolved', () => {
    fc.assert(
      fc.property(propertyCardsArb, batchArb, (cards, facts) => {
        const touched = new Set(
          facts
            .filter((fact) => fact.type === 'card.answered' || fact.type === 'card.resolved')
            .map((fact) => (fact.payload as { card: Card }).card.id),
        )
        const result = closeCardsOnFinish(view(cards), { facts }, NOW)
        const closed = appendedClosedIds(result.facts, facts.length)
        expect(new Set(closed).size).toBe(closed.length)
        for (const id of closed) expect(touched.has(id)).toBe(false)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('收掉的卡都是 resolved + cancelled，且重复调用幂等（同一决策引用）', () => {
    fc.assert(
      fc.property(propertyCardsArb, batchArb, (cards, facts) => {
        const first = closeCardsOnFinish(view(cards), { facts }, NOW)
        for (const fact of first.facts.slice(facts.length)) {
          const payload = fact.payload as { card: Card; reason: string }
          expect(payload.card.status).toBe('resolved')
          expect(payload.reason).toBe('cancelled')
        }
        expect(closeCardsOnFinish(view(cards), first, NOW)).toBe(first)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('本批没有 run / 任务结束：决策原样返回', () => {
    fc.assert(
      fc.property(propertyCardsArb, touchedFactArb, openedFactArb, (cards, touched, opened) => {
        const facts = [touched, opened]
        const decision: Decision = { facts }
        expect(closeCardsOnFinish(view(cards), decision, NOW)).toBe(decision)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})
