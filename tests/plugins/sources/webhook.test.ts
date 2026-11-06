// @vitest-environment node
/**
 * webhook 来源插件（M7 T4）：签名 / 时间窗 / 方法 / 路径 / body 形状判定与未配置不监听。
 *
 * 全部用假 net：不监听真实端口、不发真实请求；验签用确定性摘要冒充 HMAC
 * （真 HMAC 由 `host/net.ts` 的实现与其用例覆盖，这里只验证插件把 secret 与
 * `${timestamp}.${body}` 原样交给宿主、以及签名头格式判定）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { NetRequest } from '../../../src/sdk/types'
import {
  DEFAULT_EVENT_SOURCE,
  createWebhookHandler,
  parseRawEvent,
  readWebhookConfig,
  webhookManifest,
  webhookSource,
} from '../../../src/plugins/sources/webhook'
import { fakeNet, fakeSignatureHeader, type FakeNet } from './fake-net'
import { sourceHarness } from './harness'

const SECRET = 's3cret'
const AT = Date.parse('2026-11-05T00:00:00.000Z')
const TIMESTAMP = String(AT / 1000)

/** 合法事件体（可覆盖字段）。 */
const eventBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'issues.opened', subject: 'issue-1', summary: '新问题', ...over })

/** 合法签名头（时间戳与签名覆盖同一份原文）。 */
const headersFor = (
  rawBody: string,
  timestamp: string = TIMESTAMP,
  secret: string = SECRET,
): Record<string, string> => ({
  'x-webhook-timestamp': timestamp,
  'x-webhook-signature': fakeSignatureHeader(secret, timestamp, rawBody),
})

const postRequest = (
  rawBody: string,
  headers: Record<string, string> = headersFor(rawBody),
  path = '/webhook',
): NetRequest => ({ method: 'POST', path, headers, body: rawBody })

/** 启动来源（默认配置齐全；`config` 覆盖单项即可模拟未配置）。 */
async function start(options: { config?: Record<string, unknown>; net?: FakeNet } = {}): Promise<{
  net: FakeNet
  emitted: ReturnType<typeof sourceHarness>['emitted']
  logs: string[]
  controller: AbortController
  dispose: () => void
}> {
  const harness = sourceHarness({
    config: {
      secret: SECRET,
      port: 47615,
      path: '/webhook',
      toleranceSeconds: 300,
      ...options.config,
    },
    ...(options.net !== undefined ? { net: options.net } : {}),
    now: () => AT,
  })
  const dispose = await webhookSource.start(harness.ctx)
  return {
    net: harness.net,
    emitted: harness.emitted,
    logs: harness.logs,
    controller: harness.controller,
    dispose,
  }
}

describe('webhook 来源 manifest', () => {
  it('id/kind/capabilities 与 config 默认值符合 M7 契约', () => {
    expect(webhookManifest.id).toBe('webhook')
    expect(webhookManifest.kind).toBe('source')
    expect(webhookManifest.capabilities).toEqual(['net'])

    const fields = new Map((webhookManifest.config ?? []).map((field) => [field.key, field]))
    expect(fields.get('port')?.default).toBe(47615)
    expect(fields.get('path')?.default).toBe('/webhook')
    expect(fields.get('toleranceSeconds')?.default).toBe(300)
    expect(fields.get('secret')?.type).toBe('secret')
    expect(fields.get('secret')?.required).toBe(true)
  })
})

describe('webhook 来源：合法请求', () => {
  it('合法签名 → 200 且 emit 一次（source 缺省 webhook、时间戳为 epoch 秒）', async () => {
    const { net, emitted, dispose } = await start()

    expect(net.listeners).toHaveLength(1)
    expect(net.listeners[0].port).toBe(47615)

    const rawBody = eventBody()
    const reply = await net.request(postRequest(rawBody))

    expect(reply.status).toBe(200)
    expect(emitted).toEqual([
      {
        source: DEFAULT_EVENT_SOURCE,
        type: 'issues.opened',
        subject: 'issue-1',
        summary: '新问题',
      },
    ])
    dispose()
  })

  it('时间戳支持 RFC3339；可选字段为 null 时视为未提供', async () => {
    const { net, emitted } = await start()

    const timestamp = new Date(AT).toISOString()
    const rawBody = JSON.stringify({
      type: 'issues.opened',
      subject: 'issue-1',
      summary: null,
      detail: '全文',
    })
    const reply = await net.request(postRequest(rawBody, headersFor(rawBody, timestamp)))

    expect(reply.status).toBe(200)
    expect(emitted).toEqual([
      { source: 'webhook', type: 'issues.opened', subject: 'issue-1', detail: '全文' },
    ])
  })

  it('显式 source 与可选字段透传，未知键丢弃', async () => {
    const { net, emitted } = await start()

    const rawBody = JSON.stringify({
      source: 'jira',
      type: 'issues.opened',
      subject: 'ISSUE-1',
      detail: '全文',
      link: 'https://example.com/i/1',
      dedupeKey: 'k1',
      extra: 'ignored',
    })
    const reply = await net.request(postRequest(rawBody))

    expect(reply.status).toBe(200)
    expect(emitted).toEqual([
      {
        source: 'jira',
        type: 'issues.opened',
        subject: 'ISSUE-1',
        detail: '全文',
        link: 'https://example.com/i/1',
        dedupeKey: 'k1',
      },
    ])
  })

  it('签名头大小写不敏感', async () => {
    const { net } = await start()

    const rawBody = eventBody()
    const upper = {
      'X-Webhook-Timestamp': TIMESTAMP,
      'X-Webhook-Signature': fakeSignatureHeader(SECRET, TIMESTAMP, rawBody),
    }
    expect((await net.request(postRequest(rawBody, upper))).status).toBe(200)
  })

  it('时间窗边界：正好 300 秒通过，超出 1 秒拒绝且零事件', async () => {
    const { net, emitted } = await start()

    const edge = String(AT / 1000 - 300)
    const edgeBody = eventBody()
    expect((await net.request(postRequest(edgeBody, headersFor(edgeBody, edge)))).status).toBe(200)

    const stale = String(AT / 1000 - 301)
    const staleBody = eventBody()
    expect((await net.request(postRequest(staleBody, headersFor(staleBody, stale)))).status).toBe(
      401,
    )

    expect(emitted).toHaveLength(1)
  })
})

describe('webhook 来源：拒绝路径（4xx 且零事件）', () => {
  it('坏签名 → 401', async () => {
    const { net, emitted } = await start()

    const rawBody = eventBody()
    const reply = await net.request(
      postRequest(rawBody, headersFor(rawBody, TIMESTAMP, '另一个密钥')),
    )

    expect(reply.status).toBe(401)
    expect(emitted).toEqual([])
  })

  it('缺签名头 / 签名格式非法 → 401', async () => {
    const { net, emitted } = await start()

    const rawBody = eventBody()
    expect((await net.request(postRequest(rawBody, {}))).status).toBe(401)
    expect(
      (
        await net.request(
          postRequest(rawBody, {
            'x-webhook-timestamp': TIMESTAMP,
            'x-webhook-signature': 'sha256=not-hex',
          }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await net.request(
          postRequest(rawBody, {
            'x-webhook-timestamp': TIMESTAMP,
            'x-webhook-signature': fakeSignatureHeader(SECRET, TIMESTAMP, rawBody),
          }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await net.request(
          postRequest(rawBody, {
            'x-webhook-timestamp': TIMESTAMP,
            'x-webhook-signature': fakeSignatureHeader(SECRET, TIMESTAMP, rawBody).slice(7),
          }),
        )
      ).status,
    ).toBe(401)

    expect(emitted).toHaveLength(1)
  })

  it('时间戳非法 → 401', async () => {
    const { net, emitted } = await start()

    const rawBody = eventBody()
    for (const timestamp of ['yesterday', '0']) {
      const reply = await net.request(
        postRequest(rawBody, {
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': fakeSignatureHeader(SECRET, timestamp, rawBody),
        }),
      )
      expect(reply.status, timestamp).toBe(401)
    }
    expect(emitted).toEqual([])
  })

  it('方法不是 POST → 405', async () => {
    const { net, emitted } = await start()

    const rawBody = eventBody()
    const reply = await net.request({
      method: 'GET',
      path: '/webhook',
      headers: headersFor(rawBody),
      body: rawBody,
    })

    expect(reply.status).toBe(405)
    expect(emitted).toEqual([])
  })

  it('路径不匹配 → 404', async () => {
    const { net, emitted } = await start()

    const rawBody = eventBody()
    expect((await net.request(postRequest(rawBody, headersFor(rawBody), '/other'))).status).toBe(
      404,
    )
    expect(emitted).toEqual([])
  })

  it('body 非 JSON → 400', async () => {
    const { net, emitted } = await start()

    const rawBody = 'not-json'
    expect((await net.request(postRequest(rawBody))).status).toBe(400)
    expect(emitted).toEqual([])
  })

  it('事件形状非法 → 400', async () => {
    const { net, emitted } = await start()

    const invalid: Array<[string, string]> = [
      ['body 不是对象', JSON.stringify(['x'])],
      ['缺 type', JSON.stringify({ subject: 's' })],
      ['type 非 kebab-case', JSON.stringify({ type: 'Issues Opened', subject: 's' })],
      ['type 超长', JSON.stringify({ type: `a${'b'.repeat(100)}`, subject: 's' })],
      ['subject 为空', JSON.stringify({ type: 'issues.opened', subject: '  ' })],
      ['subject 超长', JSON.stringify({ type: 'issues.opened', subject: 'x'.repeat(201) })],
      [
        'summary 超长',
        JSON.stringify({ type: 'issues.opened', subject: 's', summary: 'x'.repeat(201) }),
      ],
      ['source 非 slug', JSON.stringify({ source: 'Jira', type: 'issues.opened', subject: 's' })],
      [
        'detail 超长',
        JSON.stringify({ type: 'issues.opened', subject: 's', detail: 'x'.repeat(20_001) }),
      ],
      [
        'link 超长',
        JSON.stringify({
          type: 'issues.opened',
          subject: 's',
          link: `https://e.com/${'x'.repeat(1_000)}`,
        }),
      ],
      [
        'dedupeKey 超长',
        JSON.stringify({ type: 'issues.opened', subject: 's', dedupeKey: 'x'.repeat(201) }),
      ],
    ]

    for (const [label, rawBody] of invalid) {
      const reply = await net.request(postRequest(rawBody))
      expect(reply.status, label).toBe(400)
    }
    expect(emitted).toEqual([])
  })
})

describe('webhook 来源：未配置不监听', () => {
  it('缺 secret → 不监听、日志说明原因、dispose 可调用', async () => {
    const { net, logs, dispose } = await start({ config: { secret: '   ' } })

    expect(net.listeners).toEqual([])
    expect(logs.join('\n')).toContain('未配置 secret')
    expect(() => dispose()).not.toThrow()
  })

  it('port 非法 → 不监听', async () => {
    const { net, logs } = await start({ config: { port: 0 } })

    expect(net.listeners).toEqual([])
    expect(logs.join('\n')).toContain('port 非法')
  })

  it('path 非法 → 不监听', async () => {
    const { net, logs } = await start({ config: { path: 'webhook' } })

    expect(net.listeners).toEqual([])
    expect(logs.join('\n')).toContain('path 非法')
  })

  it('toleranceSeconds 非法 → 降级默认 300 秒仍监听', async () => {
    const { net, logs } = await start({ config: { toleranceSeconds: 0 } })

    expect(net.listeners).toHaveLength(1)
    expect(logs.join('\n')).toContain('按默认 300 秒处理')
  })
})

describe('webhook 来源：失败与关闭', () => {
  it('监听失败 → start reject（由 hub 隔离并记状态）', async () => {
    const net = fakeNet()
    net.listen = async () => {
      throw new Error('EADDRINUSE')
    }

    await expect(start({ net })).rejects.toThrow(/监听 127\.0\.0\.1:47615 失败/)
  })

  it('emit 抛错 → 500 且不把异常抛给宿主', async () => {
    const harness = sourceHarness({
      config: { secret: SECRET, port: 47615, path: '/webhook' },
      now: () => AT,
    })
    harness.ctx.emit = () => {
      throw new Error('入账炸了')
    }
    const dispose = await webhookSource.start(harness.ctx)

    const rawBody = eventBody()
    const reply = await harness.net.request(postRequest(rawBody))

    expect(reply.status).toBe(500)
    expect(harness.logs.join('\n')).toContain('请求处理异常')
    expect(harness.logs.join('\n')).toContain('入账炸了')
    dispose()
  })

  it('dispose 关闭监听且可重复调用', async () => {
    const { net, dispose } = await start()

    dispose()
    dispose()

    expect(net.listeners[0].closes).toBe(1)
  })

  it('signal abort 立即关闭监听', async () => {
    const { net, controller } = await start()

    controller.abort()

    expect(net.listeners[0].closes).toBe(1)
  })

  it('启动时 signal 已 abort → 立刻关闭刚建立的监听', async () => {
    const harness = sourceHarness({
      config: { secret: SECRET, port: 47615, path: '/webhook' },
      now: () => AT,
    })
    harness.controller.abort()

    const dispose = await webhookSource.start(harness.ctx)

    expect(harness.net.listeners[0].closes).toBe(1)
    expect(() => dispose()).not.toThrow()
    expect(harness.net.listeners[0].closes).toBe(1)
  })

  it('关闭监听失败只记日志，不阻塞退出', async () => {
    const net = fakeNet()
    net.listen = async (port) => ({
      port,
      close: async () => {
        throw new Error('close 炸了')
      },
    })
    const { logs, dispose } = await start({ net })

    dispose()
    await vi.waitFor(() => expect(logs.join('\n')).toContain('关闭监听失败'))
    expect(logs.join('\n')).toContain('close 炸了')
  })
})

describe('readWebhookConfig', () => {
  it('缺省值填充、secret 原样保留', () => {
    expect(readWebhookConfig({ secret: SECRET })).toEqual({
      ok: true,
      config: { port: 47615, path: '/webhook', secret: SECRET, toleranceSeconds: 300 },
      warnings: [],
    })
  })

  it('缺 secret / port 越界 / path 不以 / 开头都返回失败原因', () => {
    expect(readWebhookConfig({})).toEqual({ ok: false, reason: '未配置 secret' })
    expect(readWebhookConfig({ secret: SECRET, port: 65_536 }).ok).toBe(false)
    expect(readWebhookConfig({ secret: SECRET, port: '47615' }).ok).toBe(false)
    expect(readWebhookConfig({ secret: SECRET, path: '' }).ok).toBe(false)
    expect(readWebhookConfig({ secret: SECRET, path: `/${'x'.repeat(200)}` }).ok).toBe(false)
  })

  it('toleranceSeconds 超上限降级为默认并给警告', () => {
    const result = readWebhookConfig({ secret: SECRET, toleranceSeconds: 90_000 })

    expect(result.ok).toBe(true)
    expect(result.ok && result.config.toleranceSeconds).toBe(300)
    expect(result.ok && result.warnings).toEqual([expect.stringContaining('按默认 300 秒处理')])
  })
})

describe('parseRawEvent', () => {
  it('source 缺省 webhook、可选字段按出现顺序收窄', () => {
    expect(parseRawEvent({ type: 'issues.opened', subject: 's' })).toEqual({
      ok: true,
      event: { source: 'webhook', type: 'issues.opened', subject: 's' },
    })
  })

  it('非对象、缺字段与超限返回原因', () => {
    expect(parseRawEvent(null).ok).toBe(false)
    expect(parseRawEvent('x').ok).toBe(false)
    expect(parseRawEvent({ type: 'issues.opened' }).ok).toBe(false)
    expect(parseRawEvent({ type: 'issues.opened', subject: 's', summary: 1 }).ok).toBe(false)
    expect(parseRawEvent({ type: 'issues.opened', subject: 's', detail: 1 }).ok).toBe(false)
    expect(parseRawEvent({ type: 'issues.opened', subject: 's', link: 1 }).ok).toBe(false)
    expect(parseRawEvent({ type: 'issues.opened', subject: 's', dedupeKey: 1 }).ok).toBe(false)
  })
})

describe('M7 覆盖补充：未配置/非 Error/头大小写', () => {
  it('sdk.config 返回 null：按未配置处理，不监听', async () => {
    const harness = sourceHarness({ config: null as never, net: fakeNet(), now: () => AT })
    const dispose = await webhookSource.start(harness.ctx)
    expect(harness.net.listeners).toEqual([])
    expect(harness.logs.join('\n')).toContain('未配置 secret')
    expect(harness.logs.join('\n')).toContain('不监听')
    dispose()
    dispose()
  })

  it('handler 内非 Error 抛出：日志用 String 兜底、回 500 且零事件', async () => {
    const logs: string[] = []
    const emitted: unknown[] = []
    const net = fakeNet({
      verify: () => {
        throw 'boom'
      },
    })
    const handler = createWebhookHandler({
      config: { secret: SECRET, port: 47615, path: '/webhook', toleranceSeconds: 300 },
      net,
      now: () => AT,
      emit: (event) => emitted.push(event),
      log: (line) => logs.push(line),
    })
    const reply = await handler(
      postRequest(JSON.stringify({ type: 'issues.opened', subject: 's' })),
    )
    expect(reply.status).toBe(500)
    expect(emitted).toEqual([])
    expect(logs.join('\n')).toContain('boom')
  })

  it('头名大小写不敏感且忽略无关头', async () => {
    const body = JSON.stringify({ type: 'issues.opened', subject: 's' })
    const headers = {
      'x-unrelated': '1',
      ...headersFor(body),
    }
    const h = await start()
    const reply = await h.net.handler!({ method: 'POST', path: '/webhook', headers, body })
    expect(reply.status).toBe(200)
    expect(h.emitted).toHaveLength(1)
  })
})
