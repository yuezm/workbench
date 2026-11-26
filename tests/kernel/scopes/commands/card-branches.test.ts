// @vitest-environment node
/**
 * 通道投递回写（`scopes/commands/card.ts#deliveryFacts`）：老卡没有 `deliveryRefs` 这一列。
 *
 * 重建前写下的卡片行缺按通道的记录；回写不能因此抛错，也不能把整张卡的投递账丢掉。
 */
import { describe, expect, it } from 'vitest'
import type { Card } from '@workbench/protocol/entities'
import { deliveredCard } from '@workbench/kernel/scopes/commands/card'
import { TEST_AT, emptyView } from '../../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

/** M43 之前的卡片行：没有 `deliveryRefs`（列是后来 ALTER 出来的）。 */
const legacyCard = (over: Partial<Card> = {}): Card =>
  ({
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
    delivery: 'pending',
    deliveryRef: null,
    deliveryRefs: undefined,
    deliveryAttempts: 0,
    nextDeliveryAt: null,
    deliveryGivenUp: false,
    optionIndex: null,
    answeredBy: null,
    answeredByRef: null,
    answeredAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  }) as unknown as Card

describe('deliveryFacts：缺按通道记录的老卡', () => {
  it('回写送达时补出该通道条目，并记本版本首个 ref 与一次尝试', () => {
    const decision = deliveredCard(
      emptyView({ cards: new Map([['card-1', legacyCard()]]) }),
      { type: 'card.delivered', cardId: 'card-1', version: 1, channel: 'in-app', ref: 'msg-1' },
      TEST_AT,
    )
    const card = (decision.facts[0]!.payload as { card: Card }).card
    expect(card.delivery).toBe('delivered')
    expect(card.deliveryRef).toBe('msg-1')
    expect(card.deliveryAttempts).toBe(1)
    expect(card.deliveryRefs).toMatchObject({ 'in-app': { version: 1, ref: 'msg-1' } })
  })

  it('版本对不上：零事实（旧版通道回写不能覆盖新版卡）', () => {
    const decision = deliveredCard(
      emptyView({ cards: new Map([['card-1', legacyCard()]]) }),
      { type: 'card.delivered', cardId: 'card-1', version: 2, channel: 'in-app', ref: 'msg-1' },
      TEST_AT,
    )
    expect(decision.facts).toEqual([])
  })
})
