// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  desktopChannel,
  desktopManifest,
  NOTIFICATION_BODY,
} from '../../../src/plugins/channels/desktop'
import { channelById, channels } from '../../../src/plugins/registry'
import { cardOf, channelHarness } from './harness'
import { fakeSdk } from '../support/fake-sdk'

describe('desktop 通道 manifest 与注册', () => {
  it('manifest：id/kind/capabilities 符合通道契约', () => {
    expect(desktopManifest.id).toBe('desktop')
    expect(desktopManifest.kind).toBe('channel')
    expect(desktopManifest.name).toBe('桌面通知')
    expect(desktopManifest.version).toBe('1.0.0')
    // 桌面通道只声明 notify：通知文案只作参数，不落日志
    expect(desktopManifest.capabilities).toEqual(['notify'])
  })

  it('注册表按投递顺序收录 desktop，key 等于 manifest.id', () => {
    expect(channels.map((entry) => entry.key)).toEqual(['in-app', 'desktop', 'webhook-channel'])
    expect(channelById('desktop')).toMatchObject({ key: 'desktop', plugin: desktopChannel })
    expect(channels[1].manifest).toBe(desktopManifest)
  })
})

describe('desktop 通道通知文案', () => {
  it('正文是固定一句指引：卡片正文与选项不进系统通知', () => {
    // 通知只做提醒，正文与候选留在任务详情里看/选
    expect(NOTIFICATION_BODY).toBe('点开工作台查看并处理')
    expect(NOTIFICATION_BODY).not.toContain('用哪个方案')
    expect(NOTIFICATION_BODY).not.toContain('A')
  })
})

describe('desktop 通道 start', () => {
  it('收到卡片调 sdk.notify(title, body) 成功后回报 delivered(..., "desktop")', async () => {
    const h = channelHarness()
    const dispose = await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-9', version: 2, title: '选一个' }))

    expect(h.sdk.notifyCalls).toEqual([{ title: '选一个', body: NOTIFICATION_BODY }])
    expect(h.delivered).toEqual([{ cardId: 'card-9', version: 2, ref: 'desktop' }])
    dispose()
  })

  it('通知只带标题：卡片正文与选项不外泄到系统通知', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)
    const card = cardOf({
      title: '部署确认',
      text: '继续发布吗？',
      options: ['发布', '取消'],
    })

    h.deliver(card)

    // 唯一一次 notify：标题来自卡片，正文是固定指引（不含卡片正文与选项）
    expect(h.sdk.notifyCalls).toHaveLength(1)
    expect(h.sdk.notifyCalls[0]).toEqual({ title: '部署确认', body: NOTIFICATION_BODY })
    expect(JSON.stringify(h.sdk.notifyCalls[0])).not.toContain('继续发布吗')
    expect(JSON.stringify(h.sdk.notifyCalls[0])).not.toContain('发布,取消')
    // delivered 只带回 id/version/通道键，不带任何卡片文案
    expect(h.delivered).toEqual([{ cardId: card.id, version: card.version, ref: 'desktop' }])
  })

  it('notify 抛错：不吞、不回报 delivered（交给 hub 按通道失败处理）', async () => {
    const h = channelHarness({
      sdk: fakeSdk({
        notify: () => {
          throw new Error('通知服务不可用')
        },
      }),
    })
    await desktopChannel.start(h.ctx)

    expect(() => h.deliver(cardOf())).toThrow(/通知服务不可用/)
    expect(h.delivered).toEqual([])
  })

  it('dispose 退订且幂等：重复调用后不再通知、不再 ack', async () => {
    const h = channelHarness()
    const dispose = await desktopChannel.start(h.ctx)

    dispose()
    expect(h.handlers).toHaveLength(0)
    dispose()
    h.deliver(cardOf())
    expect(h.sdk.notifyCalls).toEqual([])
    expect(h.delivered).toEqual([])
  })

  it('signal abort 自动退订（宿主停用/退出）', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)

    h.controller.abort()
    expect(h.handlers).toHaveLength(0)
    h.deliver(cardOf())
    expect(h.sdk.notifyCalls).toEqual([])
  })

  it('启动前 signal 已 abort：不留下订阅者，dispose 仍可安全调用', async () => {
    const h = channelHarness()
    h.controller.abort()
    const dispose = await desktopChannel.start(h.ctx)

    expect(h.handlers).toHaveLength(0)
    h.deliver(cardOf())
    expect(h.sdk.notifyCalls).toEqual([])
    dispose()
  })
})
