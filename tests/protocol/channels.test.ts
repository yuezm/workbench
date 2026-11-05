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
  options: ['甲', '乙'],
  key: 'pick',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
}

/** 假通道 hub：保存订阅者，记录 delivered / answer 的参数。 */
function fakeHub(signal: AbortSignal): {
  ctx: ChannelContext
  listeners: Set<(card: Card) => void>
  delivered: Array<[string, number, string]>
  answers: Array<[string, number]>
} {
  const listeners = new Set<(card: Card) => void>()
  const delivered: Array<[string, number, string]> = []
  const answers: Array<[string, number]> = []
  const sdk: ChannelSdk = {
    log: () => undefined,
    now: () => 0,
    notify: () => undefined,
    config: <T = Record<string, unknown>>() => ({}) as T,
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
      },
      signal,
    },
  }
}

describe('protocol/channels', () => {
  it('通道端口版本固定为 1', () => {
    expect(CHANNEL_PORT_VERSION).toBe(1)
  })

  it('start 收到上下文：onCard 收卡片、delivered / answer 回传参数、dispose 可重复调用', async () => {
    const controller = new AbortController()
    const hub = fakeHub(controller.signal)
    const received: Card[] = []

    const plugin: ChannelPlugin = {
      start: async (ctx) => {
        const off = ctx.onCard((deliveredCard) => {
          received.push(deliveredCard)
        })
        await ctx.delivered(card.id, card.version, 'fake')
        await ctx.answer(card.id, 1)
        return () => {
          off()
        }
      },
    }

    const dispose = await plugin.start(hub.ctx)
    expect(hub.listeners.size).toBe(1)
    for (const listener of hub.listeners) listener(card)

    expect(received).toEqual([card])
    expect(hub.delivered).toEqual([['card-1', 1, 'fake']])
    expect(hub.answers).toEqual([['card-1', 1]])

    dispose()
    expect(hub.listeners.size).toBe(0)
  })
})
