// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Card } from '../../src/protocol/entities'
import {
  CHANNEL_PORT_VERSION,
  type ChannelContext,
  type ChannelPlugin,
  type ChannelSdk,
} from '../../src/protocol/channels'

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
  listeners: Set<(card: Card, ref: string | null) => void>
  delivered: Array<[string, number, string]>
  answers: Array<[string, number]>
} {
  const listeners = new Set<(card: Card, ref: string | null) => void>()
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
  it('通道端口版本固定为 5（M45：按连接指定智能体 + envPatch）', () => {
    expect(CHANNEL_PORT_VERSION).toBe(5)
  })

  it('start 收到上下文：onCard 收卡片与 ref、delivered / answer 回传参数、dispose 可重复调用', async () => {
    const controller = new AbortController()
    const hub = fakeHub(controller.signal)
    const received: Array<[Card, string | null]> = []
    let outcome: { changed: boolean } | null = null

    const plugin: ChannelPlugin = {
      start: async (ctx) => {
        const off = ctx.onCard((deliveredCard, ref) => {
          received.push([deliveredCard, ref])
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
    for (const listener of hub.listeners) listener(card, 'om_1')

    expect(received).toEqual([[card, 'om_1']])
    expect(hub.delivered).toEqual([['card-1', 1, 'fake']])
    expect(hub.answers).toEqual([['card-1', 1]])
    expect(outcome).toEqual({ changed: true, status: 'answered' })

    dispose()
    expect(hub.listeners.size).toBe(0)
  })
})
