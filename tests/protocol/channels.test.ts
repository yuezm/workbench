// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Card } from '@workbench/protocol/entities'
import {
  CHANNEL_PORT_VERSION,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_DELAYS_MS,
  STALL_REMIND_DELAYS_MS,
  deliveryRetryDelayMs,
  type CardContext,
  type ChannelContext,
  type ChannelPlugin,
  type ChannelSdk,
} from '@workbench/protocol/channels'

/**
 * 通道契约（M4）：`ChannelPlugin.start(ctx)` 拿到能力面与四个回调；
 * `onCard` 收到完整 `Card` 行，`delivered` / `answer` 是通道 → 宿主的回报口。
 * 这里用内存假 hub 验证契约形状与生命周期，不接触 Electron / 真实通道。
 */
const card: Card = {
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '选一个',
  text: '做哪个？',
  kind: 'ask',
  options: ['甲', '乙'],
  key: 'pick',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  deliveryRefs: {},
  deliveryAttempts: 0,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredByRef: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
}

/** 假通道 hub：保存订阅者，记录 delivered / answer 的参数。 */
function fakeHub(signal: AbortSignal): {
  ctx: ChannelContext
  listeners: Set<(card: Card, ref: string | null, context: CardContext | null) => void>
  delivered: Array<[string, number, string]>
  answers: Array<[string, number]>
} {
  const listeners = new Set<(card: Card, ref: string | null, context: CardContext | null) => void>()
  const delivered: Array<[string, number, string]> = []
  const answers: Array<[string, number]> = []
  const sdk: ChannelSdk = {
    log: () => undefined,
    now: () => 0,
    notify: () => undefined,
    config: <T = Record<string, unknown>>() => ({}) as T,
    // 通道契约不启动子进程：声明了 `spawn` 的通道用真实实现，这里只保证能力面形状齐全
    process: {
      spawn: () => {
        throw new Error('契约测试不启动子进程')
      },
      resolve: (command) => ({ path: null, error: `契约测试不解析命令：${command}` }),
      killTree: () => false,
    },
  }
  return {
    listeners,
    delivered,
    answers,
    ctx: {
      sdk,
      onCard: (handler) => {
        listeners.add(handler)
        return () => {
          listeners.delete(handler)
        }
      },
      delivered: async (cardId, version, ref) => {
        delivered.push([cardId, version, ref])
      },
      answer: async (cardId, optionIndex) => {
        answers.push([cardId, optionIndex])
        return { changed: true, status: 'answered' }
      },
      submit: async () => ({ accepted: false, conversationId: null, receipt: '契约测试不派活' }),
      onProgress: () => () => undefined,
      signal,
    },
  }
}

describe('protocol/channels', () => {
  it('通道端口版本固定为 7（M54：onCard 多一个归属上下文）', () => {
    expect(CHANNEL_PORT_VERSION).toBe(7)
  })

  it('投递重投曲线：attempt 1..4 给对应延迟，预算用尽给 null，越界下标也给 null', () => {
    // 总尝试次数 = 首次 + 曲线长度
    expect(DELIVERY_MAX_ATTEMPTS).toBe(DELIVERY_RETRY_DELAYS_MS.length + 1)
    expect(DELIVERY_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000, 1_800_000])
    expect(deliveryRetryDelayMs(1)).toBe(30_000)
    expect(deliveryRetryDelayMs(2)).toBe(120_000)
    expect(deliveryRetryDelayMs(3)).toBe(600_000)
    expect(deliveryRetryDelayMs(4)).toBe(1_800_000)
    // 第 5 次失败：预算用尽，不再排期
    expect(deliveryRetryDelayMs(DELIVERY_MAX_ATTEMPTS)).toBeNull()
    // 「第 0 次」这类越界输入：下标取不到值，行为等价「不排期」
    expect(deliveryRetryDelayMs(0)).toBeNull()
  })

  it('停机提醒梯度是协议常量：三档固定间隔', () => {
    expect(STALL_REMIND_DELAYS_MS).toEqual([15 * 60_000, 60 * 60_000, 4 * 60 * 60_000])
  })

  it('start 收到上下文：onCard 收卡片、ref 与归属上下文；delivered / answer 回传参数、dispose 可重复调用', async () => {
    const controller = new AbortController()
    const hub = fakeHub(controller.signal)
    const received: Array<[Card, string | null, CardContext | null]> = []
    let outcome: { changed: boolean } | null = null
    const context: CardContext = {
      projectName: 'workbench',
      taskTitle: '地空协议配置',
      conversationTitle: null,
      stageName: '验收',
      agentName: '评审员',
    }

    const plugin: ChannelPlugin = {
      start: async (ctx) => {
        const off = ctx.onCard((deliveredCard, ref, cardContext) => {
          received.push([deliveredCard, ref, cardContext])
        })
        await ctx.delivered(card.id, card.version, 'fake')
        outcome = await ctx.answer(card.id, 1)
        return () => {
          off()
        }
      },
    }

    const dispose = await plugin.start(hub.ctx)
    expect(hub.listeners.size).toBe(1)
    for (const listener of hub.listeners) listener(card, 'om_1', context)

    expect(received).toEqual([[card, 'om_1', context]])
    expect(hub.delivered).toEqual([['card-1', 1, 'fake']])
    expect(hub.answers).toEqual([['card-1', 1]])
    expect(outcome).toEqual({ changed: true, status: 'answered' })

    dispose()
    expect(hub.listeners.size).toBe(0)
  })

  it('上下文可以缺席（老宿主 / 读不到投影）：null 也是合法值，通道照常投递', async () => {
    const controller = new AbortController()
    const hub = fakeHub(controller.signal)
    const received: Array<CardContext | null> = []

    const plugin: ChannelPlugin = {
      start: async (ctx) => ctx.onCard((_card, _ref, context) => received.push(context)),
    }

    const dispose = await plugin.start(hub.ctx)
    for (const listener of hub.listeners) listener(card, null, null)
    expect(received).toEqual([null])
    dispose()
  })
})
