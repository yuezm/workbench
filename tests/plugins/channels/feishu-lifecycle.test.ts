// @vitest-environment node
/**
 * 飞书通道的编排边界（覆盖率补口）：监听中断后的重连排期与「回报送达失败」。
 *
 * 这一层不关心 `lark-cli` 怎么拼 argv（那是 `lark.ts`，由 `feishu.test.ts` 用假进程覆盖），
 * 只关心 `index.ts` 对契约的处理：同一个连接的重连只排一次、dispose 之后不再重连、
 * 回报失败要记日志但不重复发。所以这里把 `createLark` 换成可控替身，
 * 直接按契约触发 `onExit` / `delivered` 的异常分支。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Card } from '@workbench/protocol/entities'
import type { Lark, LarkTarget } from '@workbench/channel-feishu/lark'
import { feishuChannel, WATCH_RESTART_MS } from '@workbench/channel-feishu/index'
import { fakeSdk } from '../support/fake-sdk'
import { cardOf, channelHarness, type ChannelHarness } from './harness'

/** 替身连接：测试按需触发长连接的入口 / 退出回调 */
interface FakeLark extends Lark {
  events: Array<(event: Record<string, unknown>) => void>
  exits: Array<(reason: string) => void>
  /** 被停过几次（`stop()` 的调用次数） */
  stops: number
}

const { created, makeLark } = vi.hoisted(() => {
  const created: FakeLark[] = []
  const makeLark = (): FakeLark => {
    const lark: FakeLark = {
      events: [],
      exits: [],
      stops: 0,
      send: async () => 'om_fixture',
      patch: async () => undefined,
      owner: async () => 'ou_owner',
      watchClicks: (onEvent, onExit) => {
        lark.events.push(onEvent)
        lark.exits.push(onExit)
        return () => {
          lark.stops += 1
        }
      },
    }
    return lark
  }
  return { created, makeLark }
})

vi.mock('@workbench/channel-feishu/lark', () => ({
  createLark: (): Lark => {
    const lark = makeLark()
    created.push(lark)
    return lark
  },
}))

const inst = (over: Partial<Card> = {}): Card => cardOf(over)

interface Started {
  harness: ChannelHarness
  lark: FakeLark
  logs: string[]
  dispose: () => void
}

async function start(
  options: {
    config?: Record<string, unknown>
    delivered?: (call: { cardId: string; version: number; ref: string }) => Promise<void>
  } = {},
): Promise<Started> {
  created.length = 0
  const logs: string[] = []
  const sdk = fakeSdk({
    config: <T = Record<string, unknown>>() => ({ user: 'ou_me', ...(options.config ?? {}) }) as T,
    log: (line) => logs.push(line),
  })
  const harness = channelHarness({ sdk, delivered: options.delivered })
  const dispose = await feishuChannel.start(harness.ctx)
  const lark = created[0]
  if (lark === undefined) throw new Error('替身连接没被创建：createLark 的桩没生效')
  return { harness, lark, logs, dispose }
}

/** 让异步投递链走完 */
const flushDeliver = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

describe('飞书通道：重连排期与回报失败', () => {
  it('监听中断：排一次重连；再次中断不再重复排期，到点重新起监听', async () => {
    vi.useFakeTimers()
    try {
      const { lark, logs, dispose } = await start()
      expect(lark.exits).toHaveLength(1)

      lark.exits[0]('退出码 1')
      expect(logs.join('\n')).toContain('的点击监听中断（退出码 1）')
      expect(logs.join('\n')).toContain('秒后重连')
      // 定时器已在排队：第二次中断不再排（否则会同时拉两个长连接）
      lark.exits[0]('退出码 1')
      expect(lark.exits).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(WATCH_RESTART_MS)
      expect(lark.exits).toHaveLength(2)
      dispose()
      expect(lark.stops).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 之后迟到的监听中断不再重连（停用的通道不该自己爬起来）', async () => {
    vi.useFakeTimers()
    try {
      const { lark, dispose } = await start()
      const lateExit = lark.exits[0]
      dispose()
      expect(lark.stops).toBe(1)

      lateExit('退出码 1')
      await vi.advanceTimersByTimeAsync(WATCH_RESTART_MS)
      // 既没有排新的定时器，也没有再起监听
      expect(lark.exits).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('回报送达失败：只记一条日志，不重发（消息已经发出去了）', async () => {
    const { harness, logs } = await start({
      delivered: () => Promise.reject(new Error('宿主忙')),
    })

    harness.deliver(inst())
    await flushDeliver()

    expect(logs.join('\n')).toContain('飞书投递回报失败')
    expect(logs.join('\n')).toContain('宿主忙')
    expect(harness.delivered).toHaveLength(1)
  })

  it('没有任何可用连接：不投递，dispose 是空操作且可重复调用', async () => {
    const { harness, logs, dispose } = await start({
      config: { user: '', connections: JSON.stringify([{ id: 'only', chat: 'oc_1' }]) },
    })
    expect(harness.handlers).toHaveLength(0)
    expect(logs.join('\n')).toContain('没有可用的连接')
    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })
})

describe('飞书通道：替身连接上的投递契约', () => {
  it('卡片交给 send（目标是配置的接收人），投递成功后回报聚合 ref', async () => {
    const sent: Array<{ target: LarkTarget; json: string; key: string }> = []
    const { harness, lark } = await start()
    lark.send = async (target, json, key) => {
      sent.push({ target, json, key })
      return 'om_1'
    }

    harness.deliver(inst())
    await flushDeliver()

    expect(sent).toHaveLength(1)
    expect(sent[0].target).toEqual({ kind: 'user', id: 'ou_me' })
    expect(JSON.parse(sent[0].json)).toMatchObject({ schema: '2.0' })
    expect(sent[0].key).toBe('wb-card-1-v1')
    expect(harness.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: JSON.stringify({ default: 'om_1' }) },
    ])
  })
})
