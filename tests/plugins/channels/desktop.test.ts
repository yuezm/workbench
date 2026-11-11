// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { NotifyTarget } from '../../../src/protocol/ipc'
import {
  desktopChannel,
  desktopManifest,
  NOTIFICATION_BODY,
  notifyTargetOf,
} from '../../../src/plugins/channels/desktop'
import { channelById, channels } from '../../../src/plugins/registry'
import { cardOf, channelHarness } from './harness'
import { fakeSdk } from '../support/fake-sdk'

/** 通知调用记录（含落点）：落点只有 `sdk.notify` 第三参能看到，缺省 fakeSdk 不记它。 */
interface NotifyCall {
  title: string
  body: string
  target?: NotifyTarget
}

function recordingHarness(): { calls: NotifyCall[]; h: ReturnType<typeof channelHarness> } {
  const calls: NotifyCall[] = []
  const h = channelHarness({
    sdk: fakeSdk({
      notify: (title, body, target) => {
        calls.push({ title, body, target })
      },
    }),
  })
  return { calls, h }
}

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

describe('desktop 通道打扰口径（M12）', () => {
  it('信息卡（kind=notice）不弹系统通知，但照样 ack delivered', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ kind: 'notice', options: [], title: '顺带说一句' }))

    expect(h.sdk.notifyCalls).toEqual([])
    expect(h.delivered).toEqual([{ cardId: 'card-1', version: 1, ref: 'desktop' }])
  })

  it('同一 run 的两张 ask 卡各自弹一次（ask 不按 run 合并）', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-1', title: '第一问' }))
    h.deliver(cardOf({ id: 'card-2', title: '第二问', version: 1 }))

    expect(h.sdk.notifyCalls.map((call) => call.title)).toEqual(['第一问', '第二问'])
    expect(h.delivered).toEqual([
      { cardId: 'card-1', version: 1, ref: 'desktop' },
      { cardId: 'card-2', version: 1, ref: 'desktop' },
    ])
  })

  it('同一张卡的同一版本重投不重复弹（补投 / 重放不打扰）', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)
    const card = cardOf({ id: 'card-1', title: '要你选' })

    h.deliver(card)
    h.deliver(card)

    expect(h.sdk.notifyCalls).toHaveLength(1)
    expect(h.delivered).toHaveLength(2)
  })

  it('同一张卡原地更新（version + 1，问题变了）再弹一次', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-1', title: '第一问', version: 1 }))
    h.deliver(cardOf({ id: 'card-1', title: '第一问（补充了事实）', version: 2 }))

    expect(h.sdk.notifyCalls.map((call) => call.title)).toEqual(['第一问', '第一问（补充了事实）'])
  })

  it('不同 run 各自弹，互不影响', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-1', runId: 'run-1', title: '甲任务' }))
    h.deliver(cardOf({ id: 'card-2', runId: 'run-2', title: '乙任务' }))

    expect(h.sdk.notifyCalls.map((call) => call.title)).toEqual(['甲任务', '乙任务'])
  })

  it('信息卡不占用后续提醒：它之后的 ask 卡照常弹', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-1', kind: 'notice', options: [], title: '知会' }))
    h.deliver(cardOf({ id: 'card-2', title: '要你选', version: 1 }))

    expect(h.sdk.notifyCalls.map((call) => call.title)).toEqual(['要你选'])
  })

  it('缺 kind 的老数据：无选项按信息卡处理（不弹），有选项照弹', async () => {
    const h = channelHarness()
    await desktopChannel.start(h.ctx)

    const legacyNotice = cardOf({ id: 'card-1', options: [], title: '旧的知会' }) as {
      kind?: string
    }
    delete legacyNotice.kind
    const legacyAsk = cardOf({ id: 'card-2', title: '旧的提问' }) as { kind?: string }
    delete legacyAsk.kind

    h.deliver(legacyNotice as unknown as Parameters<typeof h.deliver>[0])
    h.deliver(legacyAsk as unknown as Parameters<typeof h.deliver>[0])

    expect(h.sdk.notifyCalls.map((call) => call.title)).toEqual(['旧的提问'])
  })
})

describe('desktop 通道通知落点（点通知去哪儿）', () => {
  it('notifyTargetOf：cardId 必带，任务 / 会话缺值不占位', () => {
    expect(notifyTargetOf(cardOf({ id: 'card-7', taskId: 't-1', conversationId: null }))).toEqual({
      cardId: 'card-7',
      taskId: 't-1',
    })
    expect(
      notifyTargetOf(cardOf({ id: 'card-8', taskId: 't-1', conversationId: null })).conversationId,
    ).toBeUndefined()

    expect(notifyTargetOf(cardOf({ id: 'card-8', taskId: null, conversationId: 'c-1' }))).toEqual({
      cardId: 'card-8',
      conversationId: 'c-1',
    })
    expect(
      notifyTargetOf(cardOf({ id: 'card-8', taskId: null, conversationId: 'c-1' })).taskId,
    ).toBeUndefined()
  })

  it('ask 卡弹通知：第三参是这张卡的落点（任务卡带 taskId）', async () => {
    const { calls, h } = recordingHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-9', taskId: 't-9', title: '选一个' }))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      title: '选一个',
      body: NOTIFICATION_BODY,
      target: { cardId: 'card-9', taskId: 't-9' },
    })
    expect(calls[0]?.target?.conversationId).toBeUndefined()
    // 落点不影响投递语义：照样 ack delivered
    expect(h.delivered).toEqual([{ cardId: 'card-9', version: 1, ref: 'desktop' }])
  })

  it('聊天卡（taskId 为 null）：落点只带会话，不带空任务', async () => {
    const { calls, h } = recordingHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-5', taskId: null, conversationId: 'conv-5', title: '聊聊' }))

    expect(calls[0]?.target).toEqual({ cardId: 'card-5', conversationId: 'conv-5' })
    expect(calls[0]?.target?.taskId).toBeUndefined()
  })

  it('信息卡（kind=notice）：不弹通知（连落点都不产生），但照样 ack delivered', async () => {
    const { calls, h } = recordingHarness()
    await desktopChannel.start(h.ctx)

    h.deliver(cardOf({ id: 'card-3', kind: 'notice', options: [], title: '顺带说一句' }))

    expect(calls).toEqual([])
    expect(h.delivered).toEqual([{ cardId: 'card-3', version: 1, ref: 'desktop' }])
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
