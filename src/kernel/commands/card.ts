/**
 * 卡片（审批）命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Card } from '../../protocol/entities'
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, Id, Iso, View } from '../types'
import type { FactDraft } from '../types'
import { answerFacts, resolveFacts } from '../cards'
import { done, HOST_CHANNEL } from './common'

/**
 * 通道投递回写（D2/D9）：只对「当前仍存在的卡片 + 版本一致」生效。
 */
function deliveryFacts(
  view: View,
  input: { cardId: Id; version: number },
  patch: { kind: 'delivered'; ref: string } | { kind: 'failed'; error: string },
  now: Iso,
): FactDraft[] {
  const card = view.cards.get(input.cardId)
  if (!card || card.version !== input.version) return []
  if (patch.kind === 'delivered') {
    if (card.delivery === 'delivered') return []
    const next: Card = { ...card, delivery: 'delivered', deliveryRef: patch.ref, updatedAt: now }
    return [
      {
        type: 'card.delivered',
        actor: HOST_CHANNEL,
        at: now,
        payload: { card: next, ref: patch.ref },
      },
    ]
  }
  if (card.delivery === 'delivered' || card.delivery === 'failed') return []
  const next: Card = { ...card, delivery: 'failed', deliveryRef: null, updatedAt: now }
  return [
    {
      type: 'card.delivery_failed',
      actor: HOST_CHANNEL,
      at: now,
      payload: { card: next, error: patch.error },
    },
  ]
}

export function answerCard(
  view: View,
  input: Extract<Input, { type: 'card.answer' }>,
  now: Iso,
  env: Environment,
): Decision {
  return answerFacts(view, input, now, env)
}

export function resolveCard(
  view: View,
  input: Extract<Input, { type: 'card.resolve' }>,
  now: Iso,
): Decision {
  return done(resolveFacts(view, input.cardId, 'manual', now))
}

export function deliveredCard(
  view: View,
  input: Extract<Input, { type: 'card.delivered' }>,
  now: Iso,
): Decision {
  return done(deliveryFacts(view, input, { kind: 'delivered', ref: input.ref }, now))
}

export function failedCardDelivery(
  view: View,
  input: Extract<Input, { type: 'card.delivery_failed' }>,
  now: Iso,
): Decision {
  return done(deliveryFacts(view, input, { kind: 'failed', error: input.error }, now))
}
