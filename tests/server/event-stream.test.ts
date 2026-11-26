// @vitest-environment node
/**
 * SSE 事件流：推给每个在线客户端，写失败的那个只踢掉自己。
 *
 * 用假 sink 断言协议字节（`retry:` / `data:` / `: ping`），不需要真 socket；
 * 心跳定时器注入假实现，避免用例挂住进程。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  HEARTBEAT_MS,
  RETRY_MS,
  createEventStream,
  formatSse,
  type StreamSink,
} from '@workbench/api-http/event-stream'

interface FakeSink extends StreamSink {
  chunks: string[]
  closed: boolean
  fail: boolean
  onClose?: () => void
}

function sink(): FakeSink {
  const state: FakeSink = {
    chunks: [],
    closed: false,
    fail: false,
    write(chunk: string) {
      if (state.fail) throw new Error('socket closed')
      state.chunks.push(chunk)
      return true
    },
    end() {
      state.closed = true
    },
    on(event, handler) {
      if (event === 'close') state.onClose = handler
    },
    onClose: () => undefined,
  }
  return state
}

const facts = { kind: 'facts' as const, seq: 3, types: ['task.created' as const] }

describe('formatSse', () => {
  it('一条消息一个 data: 段，JSON 里带 kind', () => {
    expect(formatSse(facts)).toBe(`data: ${JSON.stringify(facts)}\n\n`)
  })
})

describe('createEventStream', () => {
  it('接上就写 retry，广播写给每个客户端', () => {
    const stream = createEventStream({ setInterval: () => 0, clearInterval: () => undefined })
    const a = sink()
    const b = sink()
    stream.attach(a)
    stream.attach(b)
    expect(stream.size).toBe(2)
    expect(a.chunks[0]).toBe(`retry: ${RETRY_MS}\n\n`)

    stream.publish(facts)
    expect(a.chunks[1]).toBe(formatSse(facts))
    expect(b.chunks[1]).toBe(formatSse(facts))
    stream.close()
  })

  it('没有客户端时 publish 不做事；close 关掉全部连接', () => {
    const stream = createEventStream({ setInterval: () => 0, clearInterval: () => undefined })
    expect(() => stream.publish(facts)).not.toThrow()
    const a = sink()
    stream.attach(a)
    stream.close()
    expect(a.closed).toBe(true)
    expect(stream.size).toBe(0)
  })

  it('首帧写失败：直接摘掉这个客户端', () => {
    const stream = createEventStream({ setInterval: () => 0, clearInterval: () => undefined })
    const bad = sink()
    bad.fail = true
    const detach = stream.attach(bad)
    expect(stream.size).toBe(0)
    detach()
    stream.close()
  })

  it('广播时写失败：只踢掉它，其它客户端照收', () => {
    const stream = createEventStream({ setInterval: () => 0, clearInterval: () => undefined })
    const good = sink()
    const bad = sink()
    stream.attach(good)
    stream.attach(bad)
    bad.fail = true
    stream.publish(facts)
    expect(good.chunks.at(-1)).toBe(formatSse(facts))
    expect(stream.size).toBe(1)
    stream.close()
  })

  it('心跳：按间隔给在线客户端写注释行；写失败也踢掉', () => {
    let tick: (() => void) | null = null
    const stream = createEventStream({
      setInterval: (callback) => {
        tick = callback
        return 1
      },
      clearInterval: () => undefined,
    })
    const a = sink()
    const b = sink()
    stream.attach(a)
    stream.attach(b)
    expect(tick).not.toBeNull()
    ;(tick as unknown as () => void)()
    expect(a.chunks.at(-1)).toBe(': ping\n\n')
    b.fail = true
    ;(tick as unknown as () => void)()
    expect(stream.size).toBe(1)
    stream.close()
  })

  it('默认心跳间隔与清除：最后一个客户端离开时停表', () => {
    const clear = vi.fn()
    const stream = createEventStream({ setInterval: () => 7, clearInterval: clear })
    const detach = stream.attach(sink())
    detach()
    expect(clear).toHaveBeenCalledWith(7)
    expect(stream.size).toBe(0)
    expect(HEARTBEAT_MS).toBe(15_000)
    stream.close()
  })

  it('close 之后仍有 sink 被 end：end 抛错也被吞掉', () => {
    const stream = createEventStream({ setInterval: () => 0, clearInterval: () => undefined })
    const bad = sink()
    bad.end = () => {
      throw new Error('already closed')
    }
    stream.attach(bad)
    expect(() => stream.close()).not.toThrow()
  })

  it('默认调度器（生产口径）：按 HEARTBEAT_MS 起表、unref 定时器，close 时清掉', () => {
    const unref = vi.fn()
    const handle = { unref }
    const scheduled: Array<[unknown, number]> = []
    const cleared: unknown[] = []
    const setIntervalStub = vi.fn((callback: () => void, ms: number) => {
      scheduled.push([callback, ms])
      return handle
    })
    vi.stubGlobal('setInterval', setIntervalStub)
    vi.stubGlobal('clearInterval', (h: unknown) => cleared.push(h))
    try {
      const stream = createEventStream()
      const a = sink()
      stream.attach(a)
      expect(setIntervalStub).toHaveBeenCalledTimes(1)
      expect(scheduled[0]?.[1]).toBe(HEARTBEAT_MS)
      expect(unref).toHaveBeenCalledTimes(1)

      // 心跳回调真的被交给定时器：触发一次，在线客户端收到注释行
      ;(scheduled[0]?.[0] as () => void)()
      expect(a.chunks.at(-1)).toBe(': ping\n\n')

      stream.close()
      expect(cleared).toEqual([handle])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('默认调度器：unref:false 时不碰 unref；句柄没有 unref 也照常工作', () => {
    let tick: (() => void) | null = null
    // 宿主注入的假定时器不保证带 unref（部分测试/跨平台实现只给一个 id）
    vi.stubGlobal('setInterval', (callback: () => void) => {
      tick = callback
      return 0
    })
    vi.stubGlobal('clearInterval', () => undefined)
    try {
      // unref:false：整个 unref 分支不执行
      const plain = createEventStream({ unref: false })
      const a = sink()
      plain.attach(a)
      ;(tick as unknown as () => void)()
      expect(a.chunks.at(-1)).toBe(': ping\n\n')
      plain.close()
      expect(plain.size).toBe(0)

      // 缺省 unref:true，但句柄是数字（没有 unref 方法）：可选调用直接跳过
      const numeric = createEventStream()
      const b = sink()
      numeric.attach(b)
      expect(b.chunks[0]).toBe(`retry: ${RETRY_MS}\n\n`)
      numeric.close()
      expect(numeric.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
