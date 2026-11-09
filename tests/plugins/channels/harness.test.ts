// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cardOf, channelHarness } from './harness'

/**
 * 通道夹具自检：`channelHarness` 的上下文契约（订阅 / 退订、delivered 记录、answer 回调、
 * abort 信号）是通道插件用例的前提；缺省坏掉时插件用例会「碰巧」通过。
 * 与 `tests/plugins/support/fake-sdk.test.ts` 同一口径：夹具缺省也是契约。
 */
describe('channelHarness：通道上下文夹具', () => {
  it('answer 走宿主回调：返回已兑现的 Promise（通道只依赖回调契约）', async () => {
    const harness = channelHarness()
    await expect(harness.ctx.answer('card-1', 1)).resolves.toBeUndefined()
  })

  it('deliver 分发给全部订阅者；退订后不再收到', () => {
    const harness = channelHarness()
    const received: string[] = []
    harness.ctx.onCard((card) => received.push(card.id))
    const unsubscribe = harness.ctx.onCard((card) => received.push(`second:${card.id}`))

    harness.deliver(cardOf())
    unsubscribe()
    harness.deliver(cardOf({ id: 'card-2' }))

    expect(received).toEqual(['card-1', 'second:card-1', 'card-2'])
  })

  it('退订是幂等的：处理器已移除时再退订一次不改动订阅列表', () => {
    const harness = channelHarness()
    const unsubscribe = harness.ctx.onCard(() => undefined)
    expect(harness.handlers).toHaveLength(1)

    unsubscribe()
    expect(harness.handlers).toHaveLength(0)
    // 处理器已经不在列表里：再退订一次不抛错、也不误删别的处理器
    expect(() => unsubscribe()).not.toThrow()
    expect(harness.handlers).toHaveLength(0)
  })

  it('delivered / notify 只记录参数，signal 可 abort', () => {
    const harness = channelHarness()
    void harness.ctx.delivered('card-1', 2, 'in-app')
    harness.ctx.sdk.notify('待审批', '任务已挂起')
    harness.controller.abort()

    expect(harness.delivered).toEqual([{ cardId: 'card-1', version: 2, ref: 'in-app' }])
    expect(harness.sdk.notifyCalls).toEqual([{ title: '待审批', body: '任务已挂起' }])
    expect(harness.ctx.signal.aborted).toBe(true)
  })
})
