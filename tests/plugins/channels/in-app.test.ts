// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { inAppChannel, inAppManifest } from '../../../src/plugins/channels/in-app'
import { channelById, channels } from '../../../src/plugins/registry'
import { cardOf, channelHarness } from './harness'

describe('in-app 通道 manifest 与注册', () => {
  it('manifest：id/kind/capabilities 符合通道契约', () => {
    expect(inAppManifest.id).toBe('in-app')
    expect(inAppManifest.kind).toBe('channel')
    expect(inAppManifest.name).toBe('应用内')
    expect(inAppManifest.version).toBe('1.0.0')
    // 应用内通道不碰任何副作用能力：投影即送达
    expect(inAppManifest.capabilities).toEqual([])
  })

  it('注册表按投递顺序收录 in-app，key 等于 manifest.id', () => {
    expect(channels[0].key).toBe('in-app')
    expect(channelById('in-app')).toMatchObject({ key: 'in-app', plugin: inAppChannel })
    expect(channels[0].manifest).toBe(inAppManifest)
  })
})

describe('in-app 通道 start', () => {
  it('收到卡片立即回报 delivered(path.id, version, "in-app")', async () => {
    const h = channelHarness()
    const dispose = await inAppChannel.start(h.ctx)

    expect(h.handlers).toHaveLength(1)
    h.deliver(cardOf({ id: 'card-7', version: 3 }))

    expect(h.delivered).toEqual([{ cardId: 'card-7', version: 3, ref: 'in-app' }])
    dispose()
  })

  it('多张卡片逐张 ack，版本原样带回', async () => {
    const h = channelHarness()
    await inAppChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-1', version: 1 }))
    h.deliver(cardOf({ id: 'card-2', version: 2 }))

    expect(h.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: 'in-app' },
      { cardId: 'card-2', version: 2, ref: 'in-app' },
    ])
  })

  it('dispose 退订且幂等：重复调用不重复退订，之后不再 ack', async () => {
    const h = channelHarness()
    const dispose = await inAppChannel.start(h.ctx)

    dispose()
    expect(h.handlers).toHaveLength(0)
    dispose()
    h.deliver(cardOf())
    expect(h.delivered).toEqual([])
  })

  it('signal abort 自动退订（宿主退出/停用通道）', async () => {
    const h = channelHarness()
    await inAppChannel.start(h.ctx)

    h.controller.abort()
    expect(h.handlers).toHaveLength(0)
    h.deliver(cardOf())
    expect(h.delivered).toEqual([])
  })

  it('启动前 signal 已 abort：不留下订阅者，dispose 仍可安全调用', async () => {
    const h = channelHarness()
    h.controller.abort()
    const dispose = await inAppChannel.start(h.ctx)

    expect(h.handlers).toHaveLength(0)
    h.deliver(cardOf())
    expect(h.delivered).toEqual([])
    dispose()
  })
})
