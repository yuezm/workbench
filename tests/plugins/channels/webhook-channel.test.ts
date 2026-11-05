// @vitest-environment node
/**
 * webhook 通道插件（M7 T4）：onCard → POST → delivered 的正向路径、非 2xx / 超时 /
 * 未配置 / 无 net 能力的降级路径。全部用假 net：不发真实请求。
 *
 * 契约口径（任务裁决）：不生成 HMAC，`secret` 只作 `Authorization: Bearer`；
 * 非 2xx / 超时只记日志（不 answer、不抛给 hub）；未配置 url 时通道不投递。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChannelContext } from '../../../src/protocol/channels'
import {
  cardPayload,
  readWebhookChannelConfig,
  webhookChannel,
  webhookChannelManifest,
} from '../../../src/plugins/channels/webhook-channel'
import type { NetFetchOptions, NetResponse } from '../../../src/sdk/types'
import { fakeSdk } from '../support/fake-sdk'
import { fakeNet, type FakeNet } from '../sources/fake-net'
import { channelHarness, cardOf } from './harness'

const URL_CONFIG = 'https://example.com/hook'

interface StartedChannel {
  net: FakeNet
  logs: string[]
  delivered: Array<{ cardId: string; version: number; ref: string }>
  handlers: Array<(card: ReturnType<typeof cardOf>) => void>
  deliver: ReturnType<typeof channelHarness>['deliver']
  controller: AbortController
  ctx: ReturnType<typeof channelHarness>['ctx']
  dispose: () => void
}

/** 启动通道（默认配置齐全；`config` 覆盖单项即可模拟未配置）。 */
async function started(
  options: {
    config?: Record<string, unknown>
    net?: FakeNet
    fetch?: (url: string, fetchOptions?: NetFetchOptions) => Promise<NetResponse>
  } = {},
): Promise<StartedChannel> {
  const logs: string[] = []
  const net = options.net ?? fakeNet(options.fetch !== undefined ? { fetch: options.fetch } : {})
  const sdk = fakeSdk({
    config: <T = Record<string, unknown>>() => ({ url: URL_CONFIG, ...options.config }) as T,
    log: (line) => logs.push(line),
    net,
  })
  const harness = channelHarness({ sdk })
  const dispose = await webhookChannel.start(harness.ctx)
  return {
    net,
    logs,
    delivered: harness.delivered,
    handlers: harness.handlers,
    deliver: harness.deliver,
    controller: harness.controller,
    ctx: harness.ctx,
    dispose,
  }
}

describe('webhook 通道 manifest', () => {
  it('id/kind/capabilities 与 config 默认值符合 M7 契约', () => {
    expect(webhookChannelManifest.id).toBe('webhook-channel')
    expect(webhookChannelManifest.kind).toBe('channel')
    expect(webhookChannelManifest.capabilities).toEqual(['net'])

    const fields = new Map((webhookChannelManifest.config ?? []).map((field) => [field.key, field]))
    expect(fields.get('url')?.type).toBe('text')
    expect(fields.get('url')?.required).toBe(true)
    expect(fields.get('secret')?.type).toBe('secret')
    expect(fields.get('secret')?.required).toBeUndefined()
    expect(fields.get('timeoutMs')?.default).toBe(5000)
  })
})

describe('webhook 通道：投递', () => {
  it('onCard → POST 配置地址，2xx 后 delivered（ref=webhook-channel）', async () => {
    const channel = await started()

    channel.deliver(cardOf())

    await vi.waitFor(() => expect(channel.net.fetches).toHaveLength(1))
    await vi.waitFor(() =>
      expect(channel.delivered).toEqual([{ cardId: 'card-1', version: 1, ref: 'webhook-channel' }]),
    )

    const call = channel.net.fetches[0]
    expect(call.url).toBe(URL_CONFIG)
    expect(call.options?.method).toBe('POST')
    expect(call.options?.timeoutMs).toBe(5000)
    expect(call.options?.headers?.['content-type']).toBe('application/json')
    // 无 secret：不加 Authorization 头
    expect(call.options?.headers?.['authorization']).toBeUndefined()
    channel.dispose()
  })

  it('payload 只含八个契约字段（卡片正文只作 JSON 参数）', async () => {
    const channel = await started()

    channel.deliver(cardOf())
    await vi.waitFor(() => expect(channel.net.fetches).toHaveLength(1))

    const payload = JSON.parse(channel.net.fetches[0].options?.body ?? '{}')
    expect(payload).toEqual({
      id: 'card-1',
      title: '选一个',
      text: '用哪个方案？',
      options: ['A', 'B'],
      key: 'plan',
      version: 1,
      taskId: 'task-1',
      conversationId: null,
    })
    expect(Object.keys(payload).sort()).toEqual(
      ['id', 'title', 'text', 'options', 'key', 'version', 'taskId', 'conversationId'].sort(),
    )
    channel.dispose()
  })

  it('配置 secret 时只加 Authorization: Bearer（不生成签名头）', async () => {
    const channel = await started({ config: { secret: 'token-1' } })

    channel.deliver(cardOf())
    await vi.waitFor(() => expect(channel.net.fetches).toHaveLength(1))

    const headers = channel.net.fetches[0].options?.headers ?? {}
    expect(headers['authorization']).toBe('Bearer token-1')
    expect(headers['x-workbench-signature']).toBeUndefined()
    channel.dispose()
  })

  it('2xx 边界：204/299 记 delivered，300 不记', async () => {
    let status = 204
    const channel = await started({ fetch: async () => ({ status, headers: {}, body: '' }) })

    channel.deliver(cardOf({ id: 'card-204' }))
    await vi.waitFor(() => expect(channel.delivered).toHaveLength(1))

    status = 299
    channel.deliver(cardOf({ id: 'card-299' }))
    await vi.waitFor(() => expect(channel.delivered).toHaveLength(2))

    status = 300
    channel.deliver(cardOf({ id: 'card-300' }))
    await vi.waitFor(() => expect(channel.logs.join('\n')).toContain('HTTP 300'))
    expect(channel.delivered).toHaveLength(2)
    channel.dispose()
  })

  it('自定义 timeoutMs 传给 fetch', async () => {
    const channel = await started({ config: { timeoutMs: 1_500 } })

    channel.deliver(cardOf())
    await vi.waitFor(() => expect(channel.net.fetches).toHaveLength(1))

    expect(channel.net.fetches[0].options?.timeoutMs).toBe(1_500)
    channel.dispose()
  })
})

describe('webhook 通道：失败只记日志', () => {
  it('非 2xx → 不 delivered、日志带状态码（不记卡片正文）', async () => {
    const channel = await started({
      fetch: async () => ({ status: 502, headers: {}, body: 'bad gateway' }),
    })

    channel.deliver(cardOf())

    await vi.waitFor(() => expect(channel.logs.join('\n')).toContain('HTTP 502'))
    expect(channel.delivered).toEqual([])
    expect(channel.logs.join('\n')).not.toContain('用哪个方案？')
    channel.dispose()
  })

  it('fetch 抛错（超时/连接失败）→ 不 delivered、日志说明', async () => {
    const channel = await started({
      fetch: async () => {
        throw new Error('请求超时（>5000ms）')
      },
    })

    channel.deliver(cardOf())

    await vi.waitFor(() => expect(channel.logs.join('\n')).toContain('投递异常'))
    expect(channel.logs.join('\n')).toContain('请求超时')
    expect(channel.delivered).toEqual([])
    channel.dispose()
  })

  it('delivered 被拒 → 只记日志，不产生未处理拒绝', async () => {
    const channel = await started()
    channel.ctx.delivered = () => Promise.reject(new Error('写库失败'))

    channel.deliver(cardOf())

    await vi.waitFor(() => expect(channel.logs.join('\n')).toContain('写库失败'))
    channel.dispose()
  })
})

describe('webhook 通道：未配置不投递', () => {
  it('缺 url → 不订阅卡片、日志说明、dispose 可重复', async () => {
    const channel = await started({ config: { url: '   ' } })

    expect(channel.handlers).toEqual([])
    expect(channel.logs.join('\n')).toContain('未配置 url')
    expect(() => channel.dispose()).not.toThrow()
    expect(() => channel.dispose()).not.toThrow()
  })

  it('url 非 http(s) → 不订阅卡片', async () => {
    const channel = await started({ config: { url: 'ftp://example.com/hook' } })

    expect(channel.handlers).toEqual([])
    expect(channel.logs.join('\n')).toContain('url 非法')
  })

  it('宿主未注入 net 能力 → 跳过投递、不 delivered、不抛错', async () => {
    const logs: string[] = []
    const handlers: Array<(card: ReturnType<typeof cardOf>) => void> = []
    const delivered: Array<{ cardId: string; version: number; ref: string }> = []
    // ChannelSdk.net 可选：宿主没有网络原件时这里就是 undefined
    const ctx: ChannelContext = {
      sdk: {
        log: (line) => logs.push(line),
        now: () => 0,
        notify: () => undefined,
        config: <T = Record<string, unknown>>() => ({ url: URL_CONFIG }) as T,
      },
      onCard: (handler) => {
        handlers.push(handler)
        return () => {
          const index = handlers.indexOf(handler)
          if (index >= 0) handlers.splice(index, 1)
        }
      },
      delivered: (cardId, version, ref) => {
        delivered.push({ cardId, version, ref })
        return Promise.resolve()
      },
      answer: () => Promise.resolve(),
      signal: new AbortController().signal,
    }
    const dispose = await webhookChannel.start(ctx)

    handlers[0](cardOf())

    await vi.waitFor(() => expect(logs.join('\n')).toContain('未提供 net 能力'))
    expect(delivered).toEqual([])
    dispose()
  })

  it('宿主 net 不可用（fetch 拒绝 capability_unavailable）→ 只记日志、不 delivered', async () => {
    const logs: string[] = []
    const sdk = fakeSdk({
      config: <T = Record<string, unknown>>() => ({ url: URL_CONFIG }) as T,
      log: (line) => logs.push(line),
    })
    const harness = channelHarness({ sdk })
    const dispose = await webhookChannel.start(harness.ctx)

    harness.deliver(cardOf())

    await vi.waitFor(() => expect(logs.join('\n')).toContain('capability_unavailable: net'))
    expect(harness.delivered).toEqual([])
    dispose()
  })

  it('signal abort 后不再投递', async () => {
    const channel = await started()
    channel.controller.abort()

    channel.deliver(cardOf())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(channel.net.fetches).toEqual([])
    expect(channel.delivered).toEqual([])
  })

  it('dispose 可重复调用：第二次直接返回', async () => {
    const channel = await started()

    channel.dispose()
    expect(channel.handlers).toEqual([])
    expect(() => channel.dispose()).not.toThrow()
    expect(channel.handlers).toEqual([])
  })

  it('启动时 signal 已 abort → 不订阅卡片', async () => {
    const logs: string[] = []
    const controller = new AbortController()
    controller.abort()
    const handlers: Array<(card: ReturnType<typeof cardOf>) => void> = []
    const ctx: ChannelContext = {
      sdk: fakeSdk({
        config: <T = Record<string, unknown>>() => ({ url: URL_CONFIG }) as T,
        log: (line) => logs.push(line),
      }),
      onCard: (handler) => {
        handlers.push(handler)
        return () => {
          const index = handlers.indexOf(handler)
          if (index >= 0) handlers.splice(index, 1)
        }
      },
      delivered: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      signal: controller.signal,
    }

    const dispose = await webhookChannel.start(ctx)

    expect(handlers).toEqual([])
    expect(logs).toEqual([])
    expect(() => dispose()).not.toThrow()
  })

  it('非法 timeoutMs → 降级默认 5000 毫秒并给警告日志', async () => {
    const channel = await started({ config: { timeoutMs: 0 } })

    channel.deliver(cardOf())
    await vi.waitFor(() => expect(channel.net.fetches).toHaveLength(1))

    expect(channel.net.fetches[0].options?.timeoutMs).toBe(5000)
    expect(channel.logs.join('\n')).toContain('按默认 5000 毫秒处理')
    channel.dispose()
  })
})

describe('cardPayload / readWebhookChannelConfig', () => {
  it('cardPayload 只挑八个字段', () => {
    expect(cardPayload(cardOf())).toEqual({
      id: 'card-1',
      title: '选一个',
      text: '用哪个方案？',
      options: ['A', 'B'],
      key: 'plan',
      version: 1,
      taskId: 'task-1',
      conversationId: null,
    })
  })

  it('配置归一化：缺省值、空白 secret 视为未配置、非法值给原因', () => {
    expect(readWebhookChannelConfig({ url: URL_CONFIG })).toEqual({
      ok: true,
      config: { url: URL_CONFIG, secret: null, timeoutMs: 5000 },
      warnings: [],
    })
    expect(readWebhookChannelConfig({ url: URL_CONFIG, secret: '  ' })).toEqual({
      ok: true,
      config: { url: URL_CONFIG, secret: null, timeoutMs: 5000 },
      warnings: [],
    })
    expect(readWebhookChannelConfig({})).toEqual({ ok: false, reason: '未配置 url' })
    expect(readWebhookChannelConfig({ url: URL_CONFIG, secret: 1 }).ok).toBe(false)
    expect(readWebhookChannelConfig({ url: `https://e.com/${'x'.repeat(2_000)}` }).ok).toBe(false)
    const fallback = readWebhookChannelConfig({ url: URL_CONFIG, timeoutMs: 90_000 })
    expect(fallback.ok && fallback.config.timeoutMs).toBe(5000)
    expect(fallback.ok && fallback.warnings).toEqual([
      expect.stringContaining('按默认 5000 毫秒处理'),
    ])
  })
})
