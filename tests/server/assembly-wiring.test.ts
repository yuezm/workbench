// @vitest-environment node
/**
 * 时序接线件（`packages/bundle/base/src/wiring.ts`）：惰性通道 hub、聊天流旁路、
 * 结局知会、对账日志判定。
 *
 * 它们原先都是 `createWorkbench` 里的箭头函数：hub 未装配的防御分支、聊天流的两种事件、
 * 空事实批次这些只有在特定时序下才走，留在装配里等于永远测不到。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Channels } from '@workbench/host/channels'
import type { Scheduler } from '@workbench/host/scheduler'
import type { Fact } from '@workbench/kernel/core/types'
import type { RunEvent } from '@workbench/protocol/entities'
import {
  announceNoticesOf,
  chatStreamHooksOf,
  clockTickHook,
  lazyChannelHub,
  passthroughDispatch,
  prefixedLog,
  reconcileLogLines,
  schedulerRef,
} from '@workbench/bundle-base/wiring'

const factOf = (type: string, payload: unknown, actorKind: 'owner' | 'agent' | 'host'): Fact =>
  ({ type, payload, actor: { kind: actorKind } }) as unknown as Fact

const summary = (patch: Partial<Parameters<typeof reconcileLogLines>[0]> = {}) => ({
  killed: 0,
  cleared: 0,
  facts: 0,
  settledChats: 0,
  settledWaitings: 0,
  ...patch,
})

describe('lazyChannelHub', () => {
  it('hub 已装配：每次返回同一个实例', () => {
    const hub = { startAll: vi.fn() } as unknown as Channels
    const get = lazyChannelHub({ current: hub })
    expect(get()).toBe(hub)
    expect(get()).toBe(hub)
  })

  it('hub 未装配：抛可读错误（不是对着 null 继续）', () => {
    const get = lazyChannelHub({ current: null })
    expect(() => get()).toThrow('通道 hub 尚未装配')
  })

  it('装配顺序补上后同一个 getter 立刻可用（holder 是可变引用）', () => {
    const holder: { current: Channels | null } = { current: null }
    const get = lazyChannelHub(holder)
    expect(() => get()).toThrow()
    const hub = {} as Channels
    holder.current = hub
    expect(get()).toBe(hub)
  })
})

describe('chatStreamHooksOf', () => {
  it('流式帧：原样转成 stream 事件', () => {
    const stream = vi.fn()
    const hooks = chatStreamHooksOf({ stream })
    const event = { type: 'text', text: '你好' } as unknown as RunEvent

    hooks.onChatStream('run-1', 'conv-1', event)
    expect(stream).toHaveBeenCalledWith({
      kind: 'stream',
      runId: 'run-1',
      conversationId: 'conv-1',
      event,
    })
  })

  it('一轮结束：发一次 stream-end', () => {
    const stream = vi.fn()
    chatStreamHooksOf({ stream }).onChatStreamEnd('run-2', 'conv-2')
    expect(stream).toHaveBeenCalledWith({
      kind: 'stream-end',
      runId: 'run-2',
      conversationId: 'conv-2',
    })
  })
})

describe('announceNoticesOf', () => {
  it('空批次不发通知', () => {
    const notifier = vi.fn()
    announceNoticesOf(notifier)([])
    expect(notifier).not.toHaveBeenCalled()
  })

  it('完成 / 失败：逐条推给知会入口（标题、正文、落点）', () => {
    const notifier = vi.fn()
    announceNoticesOf(notifier)([
      factOf('task.finished', { task: { id: 't1', title: '写测试' }, outcome: 'done' }, 'agent'),
      factOf('run.failed', { run: { taskId: 't2' } }, 'host'),
    ])

    expect(notifier).toHaveBeenCalledTimes(2)
    expect(notifier).toHaveBeenNthCalledWith(
      1,
      '任务完成：写测试',
      expect.stringContaining('点开工作台'),
      { taskId: 't1' },
    )
    expect(notifier).toHaveBeenNthCalledWith(2, '任务运行失败', expect.any(String), {
      taskId: 't2',
    })
  })

  it('人自己点的完成、聊天失败都不打扰（noticesFromFacts 的口径原样透传）', () => {
    const notifier = vi.fn()
    announceNoticesOf(notifier)([
      factOf('task.finished', { task: { id: 't1', title: '自己拖的' }, outcome: 'done' }, 'owner'),
      factOf('run.failed', { run: { taskId: null } }, 'host'),
    ])
    expect(notifier).not.toHaveBeenCalled()
  })
})

describe('passthroughDispatch / clockTickHook / schedulerRef', () => {
  it('写入口转发：原样交给 effects.dispatch', () => {
    const dispatch = vi.fn(() => ({ facts: [], value: null }))
    const forward = passthroughDispatch({ dispatch })

    expect(forward({ type: 'clock.tick' })).toEqual({ facts: [], value: null })
    expect(dispatch).toHaveBeenCalledWith({ type: 'clock.tick' })
  })

  it('时钟 tick 钩子：调度器就位后唤醒它；还没就位时静默跳过（启动期 tick 不崩）', () => {
    const holder: { current: { wake: () => void } | null } = { current: null }
    const hook = clockTickHook(holder)
    expect(() => hook()).not.toThrow()

    const wake = vi.fn()
    holder.current = { wake }
    hook()
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('调度器引用：装配完成后返回实例；未装配时抛可读错误', () => {
    const holder: { current: Scheduler | null } = { current: null }
    const get = schedulerRef(holder)
    expect(() => get()).toThrow('调度器尚未装配')

    const scheduler = { wake: vi.fn() } as unknown as Scheduler
    holder.current = scheduler
    expect(get()).toBe(scheduler)
  })
})

describe('prefixedLog', () => {
  it('前缀只拼在行首，内容原样', () => {
    const lines: string[] = []
    prefixedLog((line) => lines.push(line), '[scheduler] ')('写回执失败：lease_mismatch')
    expect(lines).toEqual(['[scheduler] 写回执失败：lease_mismatch'])
  })
})

describe('reconcileLogLines', () => {
  it('什么都没回收：不给日志（装配正常时不产生噪音）', () => {
    expect(reconcileLogLines(summary())).toEqual([])
    // 只清了登记行也算「无事可记」：那是 run 早就终态的正常清理
    expect(reconcileLogLines(summary({ cleared: 3 }))).toEqual([])
  })

  it('终止残留进程 / 回收事实 / 兜底聊天 / 兜底 waiting：任一非零都给一行', () => {
    expect(reconcileLogLines(summary({ killed: 2, cleared: 2 }))[0]).toContain('终止残留进程 2 个')
    expect(reconcileLogLines(summary({ facts: 1 }))[0]).toContain('回收事实 1 条')
    expect(reconcileLogLines(summary({ settledChats: 1 }))).toHaveLength(1)
    expect(reconcileLogLines(summary({ settledWaitings: 1 }))).toHaveLength(1)
    expect(reconcileLogLines(summary({ killed: 1, cleared: 5, facts: 3 }))).toEqual([
      '[reconcile] 终止残留进程 1 个、清理登记 5 行、回收事实 3 条',
    ])
  })
})
