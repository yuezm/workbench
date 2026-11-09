/**
 * `src/kernel/cards.ts` 的决策出口：随 run / 任务结束收卡（`closeCardsOnFinish`）。
 *
 * 重点是「同批新开的卡」这条：它不在视图里（视图是上一轮的快照），只能按行造事实；
 * 而且只有属于**本批**结束的 run / 任务的卡才该收——别的卡照常开着。
 */
import { describe, expect, it } from 'vitest'
import type { Card } from '../../src/protocol/entities'
import { closeCardsOnFinish } from '../../src/kernel/cards'
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

const view = (cards: Card[] = []): View => ({
  seq: 7,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(cards.map((row) => [row.id, row])),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
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
