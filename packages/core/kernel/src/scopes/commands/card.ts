/**
 * 卡片（审批）命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Card } from '@workbench/protocol/entities'
import type { Input } from '@workbench/protocol/inputs'
import { deliveryRetryDelayMs } from '@workbench/protocol/channels'
import type { Decision, Environment, Id, Iso, View } from '../../core/types'
import type { FactDraft } from '../../core/types'
import { answerFacts, resolveFacts } from '../cards'
import { done, HOST_CHANNEL } from './common'

/**
 * 通道投递回写（D2/D9；M43 按通道分别记账）：只对「当前仍存在的卡片 + 版本一致」生效。
 *
 * - `delivered`：把 `(channel, version, ref)` 记进 `deliveryRefs`，同一通道同一版本重复回报
 *   零事实；`deliveryRef` 仍记**本版本首个**成功通道的 ref（聚合列语义不变）。
 * - `failed`：只要这张卡已经送达过任何一个通道就不再降级（失败账是聚合口径，不按通道各算）。
 */
function deliveryFacts(
  view: View,
  input: { cardId: Id; version: number; channel: string },
  patch: { kind: 'delivered'; ref: string } | { kind: 'failed'; error: string },
  now: Iso,
): FactDraft[] {
  const card = view.cards.get(input.cardId)
  if (!card || card.version !== input.version) return []
  if (patch.kind === 'delivered') {
    const own = card.deliveryRefs?.[input.channel]
    if (
      own !== undefined &&
      own.version === input.version &&
      own.status === card.status &&
      own.ref === patch.ref
    ) {
      return []
    }
    // 本版本第一次成功：计一次尝试、记聚合 ref；后续通道（或终态回写）只补自己的条目
    const firstForVersion = card.delivery !== 'delivered'
    const next: Card = {
      ...card,
      delivery: 'delivered',
      deliveryRef: firstForVersion ? patch.ref : card.deliveryRef,
      deliveryRefs: {
        ...(card.deliveryRefs ?? {}),
        [input.channel]: {
          version: input.version,
          status: card.status,
          ref: patch.ref,
          at: now,
        },
      },
      deliveryAttempts: firstForVersion ? card.deliveryAttempts + 1 : card.deliveryAttempts,
      // M41：送达也把重投排期清干净（放弃标记一并复位）
      nextDeliveryAt: null,
      deliveryGivenUp: false,
      updatedAt: now,
    }
    return [
      {
        type: 'card.delivered',
        actor: HOST_CHANNEL,
        at: now,
        payload: { card: next, channel: input.channel, ref: patch.ref },
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
      payload: { card: next, channel: input.channel, error: patch.error },
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
  // 没带通道 = 「本轮所有通道都没投出去」的聚合失败（聚合账不按通道各算一份）
  return done(
    deliveryFacts(
      view,
      { ...input, channel: input.channel ?? 'all' },
      { kind: 'failed', error: input.error },
      now,
    ),
  )
}
