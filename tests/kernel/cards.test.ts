/**
 * `src/kernel/cards.ts` 的决策出口：随 run / 任务结束收卡（`closeCardsOnFinish`）。
 *
 * 重点是「同批新开的卡」这条：它不在视图里（视图是上一轮的快照），只能按行造事实；
 * 而且只有属于**本批**结束的 run / 任务的卡才该收——别的卡照常开着。
 */
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
