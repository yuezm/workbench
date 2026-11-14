/**
 * 通道插件测试夹具：按 `ChannelContext` 形状构造可控上下文（不启动 hub、不读写库）。
 *
 * - `onCard` 记录订阅者并返回退订函数，`deliver(card)` 模拟 hub 分发；
 * - `delivered` / `answer` 只是记录回调参数并返回已兑现的 Promise（hub 的真实实现更复杂，
 *   通道插件只依赖回调契约）；
 * - `sdk` 用 `fakeSdk`（notify 调用记进 `sdk.notifyCalls`，文案只作参数）。
 */
import type { ChannelContext } from '../../../src/protocol/channels'
import type { Card } from '../../../src/protocol/entities'
import { fakeSdk, type FakeSdk } from '../support/fake-sdk'

/** 合法卡片夹具（open / pending，字段齐全） */
export const cardOf = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 'task-1',
  conversationId: null,
  title: '选一个',
  text: '用哪个方案？',
  kind: 'ask',
  options: ['A', 'B'],
  key: 'plan',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  deliveryAttempts: 0,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
  ...over,
})

export interface ChannelHarness {
  ctx: ChannelContext
  sdk: FakeSdk
  controller: AbortController
  /** 已订阅的 onCard 处理器（模拟 hub 的分发列表） */
  handlers: Array<(card: Card) => void>
  /** 通道回报的 delivered 参数 */
  delivered: Array<{ cardId: string; version: number; ref: string }>
  /** 模拟 hub 把一张卡片分发给所有订阅者（与 hub 的同步调用口径一致） */
  deliver(card: Card): void
}

export function channelHarness(options: { sdk?: FakeSdk } = {}): ChannelHarness {
  const sdk = options.sdk ?? fakeSdk()
  const controller = new AbortController()
  const handlers: ChannelHarness['handlers'] = []
  const delivered: ChannelHarness['delivered'] = []

  const ctx: ChannelContext = {
    sdk,
    onCard: (handler) => {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    delivered: (cardId, version, ref) => {
      delivered.push({ cardId, version, ref })
      return Promise.resolve()
    },
    answer: () => Promise.resolve(),
    signal: controller.signal,
  }

  return {
    ctx,
    sdk,
    controller,
    handlers,
    delivered,
    deliver: (card) => {
      // 复制一份：处理器可能在分发过程中退订（与 hub 递归分发时的表现一致）
      for (const handler of [...handlers]) handler(card)
    },
  }
}
