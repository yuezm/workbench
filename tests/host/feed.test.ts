// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_WINDOW_MS, createFactFeed, MAX_FACTS_PER_BATCH } from '../../src/host/feed'
import type { Fact } from '../../src/kernel/core/types'

const fact = (seq: number, type: Fact['type'] = 'task.created'): Fact => ({
  seq,
  type,
  actor: { kind: 'owner', via: 'ui' },
  at: '2026-01-01T00:00:00.000Z',
  payload: {} as Fact['payload'],
})

describe('host/feed：事实批次与流旁路', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('窗口内多次 publish 合并成一个批次：seq 取最后一条、types 去重', () => {
    const feed = createFactFeed()
    const events: unknown[] = []
    feed.subscribe((event) => events.push(event))

    feed.publish([fact(1, 'task.created')])
    feed.publish([fact(2, 'task.created'), fact(3, 'task.moved')])
    expect(events).toEqual([])

    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    expect(events).toEqual([{ kind: 'facts', seq: 3, types: ['task.created', 'task.moved'] }])
    feed.stop()
  })

  it('达到单批上限立即 flush，不等窗口到期', () => {
    const feed = createFactFeed()
    const events: unknown[] = []
    feed.subscribe((event) => events.push(event))

    const facts = Array.from({ length: MAX_FACTS_PER_BATCH }, (_, index) =>
      fact(index + 1, 'task.created'),
    )
    feed.publish(facts)
    expect(events).toEqual([{ kind: 'facts', seq: MAX_FACTS_PER_BATCH, types: ['task.created'] }])
    // 已 flush 的批次不会再在窗口到期时重复推送
    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    expect(events).toHaveLength(1)
    feed.stop()
  })

  it('流事件即时送达、不进批次，也不重置未发送的事实', () => {
    const feed = createFactFeed()
    const events: Array<{ kind: string }> = []
    feed.subscribe((event) => events.push(event))

    feed.publish([fact(1)])
    feed.stream({ kind: 'stream-end', runId: 'run-1', conversationId: 'cv-1' })
    expect(events).toEqual([{ kind: 'stream-end', runId: 'run-1', conversationId: 'cv-1' }])

    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    expect(events.map((event) => event.kind)).toEqual(['stream-end', 'facts'])
    feed.stop()
  })

  it('订阅者抛错互相隔离：一个窗口崩了不影响其它订阅者', () => {
    const feed = createFactFeed()
    const received: string[] = []
    feed.subscribe(() => {
      throw new Error('窗口已销毁')
    })
    feed.subscribe((event) => received.push(event.kind))

    feed.stream({ kind: 'stream-end', runId: 'run-1', conversationId: null })
    feed.publish([fact(1)])
    vi.advanceTimersByTime(BATCH_WINDOW_MS)

    expect(received).toEqual(['stream-end', 'facts'])
    feed.stop()
  })

  it('flush 手动立即发送；无待发送批次时为空操作', () => {
    const feed = createFactFeed()
    const events: unknown[] = []
    feed.subscribe((event) => events.push(event))

    feed.flush()
    expect(events).toEqual([])

    feed.publish([fact(1)])
    feed.flush()
    expect(events).toHaveLength(1)
    feed.stop()
  })

  it('退订后不再收到推送；stop 停表', () => {
    const feed = createFactFeed()
    const received: unknown[] = []
    const off = feed.subscribe((event) => received.push(event))
    off()
    feed.stream({ kind: 'stream-end', runId: 'run-1', conversationId: null })
    expect(received).toEqual([])

    const events: unknown[] = []
    feed.subscribe((event) => events.push(event))
    feed.publish([fact(1)])
    feed.stop()
    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    expect(events).toEqual([])
  })
})

describe('host/feed：空输入', () => {
  it('publish([]) 不排批次、不推送', () => {
    vi.useFakeTimers()
    const feed = createFactFeed()
    const events: unknown[] = []
    feed.subscribe((event) => events.push(event))
    feed.publish([])
    vi.advanceTimersByTime(BATCH_WINDOW_MS)
    expect(events).toEqual([])
    feed.stop()
    vi.useRealTimers()
  })
})
