/**
 * 卡片（审批）命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Card } from '../../../protocol/entities'
import type { Input } from '../../../protocol/inputs'
import { deliveryRetryDelayMs } from '../../../protocol/channels'
import type { Decision, Environment, Id, Iso, View } from '../../core/types'
import type { FactDraft } from '../../core/types'
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
    const next: Card = {
      ...card,
      delivery: 'delivered',
      deliveryRef: patch.ref,
      // M41：送达也计一次尝试，并把重投排期清干净（放弃标记一并复位）
      deliveryAttempts: card.deliveryAttempts + 1,
      nextDeliveryAt: null,
      deliveryGivenUp: false,
      updatedAt: now,
    }
    return [
      {
        type: 'card.delivered',
        actor: HOST_CHANNEL,
        at: now,
        payload: { card: next, ref: patch.ref },
      },
    ]
  }
  // 已送达不再降级；已放弃的卡再来失败也不烧预算（宿主不该再投，内核这里兜住）
  if (card.delivery === 'delivered' || card.deliveryGivenUp) return []
  const attempt = card.deliveryAttempts + 1
  const delay = deliveryRetryDelayMs(attempt)
  const next: Card = {
    ...card,
    delivery: 'failed',
    deliveryRef: null,
    deliveryAttempts: attempt,
    // 曲线用尽后不再排期：`deliveryGivenUp` 是可查的「不投了」结论，不是静默超时
    nextDeliveryAt: delay === null ? null : new Date(Date.parse(now) + delay).toISOString(),
    deliveryGivenUp: delay === null,
    updatedAt: now,
  }
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
