/**
 * webhook 通道插件（M7 D10）：把卡片 POST 到配置的 HTTP 地址，2xx 才算送达。
 *
 * 边界：
 * - 只经 `ctx.sdk.net.fetch` 出站（ESLint 禁止插件 import node 内置；超时与响应体上限
 *   由宿主原件保证），**不自己起监听、不算签名**；
 * - 卡片正文只作 JSON 参数：payload 只含 `id/title/text/options/key/version/taskId/
 *   conversationId` 八个字段，不拼 URL、不拼头、不拼命令行；
 * - 可选 `secret` 只作 `Authorization: Bearer <secret>`（任务裁决：不生成 HMAC 签名）；
 * - 2xx → `delivered(card.id, card.version, 'webhook-channel')`；非 2xx / 超时 / 网络
 *   不可用只记日志（`sdk.log`），**不 answer、不抛给 hub**；
 * - 未配置 url（或 url 非 http(s)）时 `start` 返回 no-op dispose：通道不投递，
 *   不伪造成功；
 * - 单向：答案仍走 in-app / desktop，本通道不回收。
 */
import type { ChannelContext, ChannelPlugin } from '../../../protocol/channels'
import type { Card } from '../../../protocol/entities'
import { webhookChannelManifest } from './manifest'

export { webhookChannelManifest } from './manifest'

/** 配置缺省值（与 `manifest.config` 的 default 同一口径）。 */
export const WEBHOOK_CHANNEL_DEFAULTS = { timeoutMs: 5_000 } as const

/** 超时上限（毫秒）：再长也没有「单次投递」意义。 */
const MAX_TIMEOUT_MS = 60_000

/** URL 长度上限（防御超长配置）。 */
const MAX_URL_LENGTH = 2_000

/** 只允许 http(s)：其它协议交给 `net.fetch` 只会失败，配置阶段就拒绝更清楚。 */
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i

/** 未配置时的 dispose：通道本来就不投递，调用无副作用且可重复。 */
const noopDispose = (): void => undefined

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** webhook 通道的归一化配置（url 已确认是 http(s)、secret 缺省为 null）。 */
export interface WebhookChannelConfig {
  url: string
  secret: string | null
  timeoutMs: number
}

export type WebhookChannelConfigResult =
  { ok: true; config: WebhookChannelConfig; warnings: string[] } | { ok: false; reason: string }

/**
 * 读取并归一化配置：缺 url / url 非 http(s) 时返回失败原因（调用方 no-op）；
 * `timeoutMs` 非法只降级为默认值并给一条警告（超时配置坏不该让通道不投递）。
 */
export function readWebhookChannelConfig(raw: Record<string, unknown>): WebhookChannelConfigResult {
  const urlValue = raw['url']
  if (typeof urlValue !== 'string' || urlValue.trim() === '') {
    return { ok: false, reason: '未配置 url' }
  }
  const url = urlValue.trim()
  if (url.length > MAX_URL_LENGTH || !HTTP_URL_PATTERN.test(url)) {
    return { ok: false, reason: `url 非法（${url.slice(0, 80)}，需 http(s) 地址且不超过 2000 字）` }
  }

  const secretValue = raw['secret']
  let secret: string | null = null
  if (secretValue !== undefined && secretValue !== null) {
    if (typeof secretValue !== 'string') {
      return { ok: false, reason: 'secret 必须是字符串' }
    }
    const trimmed = secretValue.trim()
    secret = trimmed === '' ? null : trimmed
  }

  const warnings: string[] = []
  let timeoutMs: number = WEBHOOK_CHANNEL_DEFAULTS.timeoutMs
  const timeoutValue = raw['timeoutMs']
  if (timeoutValue !== undefined && timeoutValue !== null) {
    if (
      typeof timeoutValue === 'number' &&
      Number.isInteger(timeoutValue) &&
      timeoutValue >= 1 &&
      timeoutValue <= MAX_TIMEOUT_MS
    ) {
      timeoutMs = timeoutValue
    } else {
      warnings.push(
        `timeoutMs 非法（${String(timeoutValue)}），按默认 ${WEBHOOK_CHANNEL_DEFAULTS.timeoutMs} 毫秒处理`,
      )
    }
  }

  return { ok: true, config: { url, secret, timeoutMs }, warnings }
}

/** 卡片 → POST 的 JSON 参数：只带投递需要的字段，正文只作参数。 */
export interface WebhookCardPayload {
  id: string
  title: string
  text: string
  options: readonly string[]
  key: string | null
  version: number
  taskId: string | null
  conversationId: string | null
}

export function cardPayload(card: Card): WebhookCardPayload {
  return {
    id: card.id,
    title: card.title,
    text: card.text,
    options: card.options,
    key: card.key,
    version: card.version,
    taskId: card.taskId,
    conversationId: card.conversationId,
  }
}

export const webhookChannel: ChannelPlugin = {
  async start(ctx: ChannelContext): Promise<() => void> {
    const raw = ctx.sdk.config<Record<string, unknown> | null>() ?? {}
    const parsed = readWebhookChannelConfig(raw)
    if (!parsed.ok) {
      ctx.sdk.log(`${parsed.reason}：webhook 通道不投递（未配置即不发送）`)
      return noopDispose
    }
    for (const warning of parsed.warnings) ctx.sdk.log(warning)
    const config = parsed.config

    const deliver = async (card: Card): Promise<void> => {
      if (ctx.sdk.net === undefined) {
        // 宿主没注入网络原件（测试/无头）：按「网络不可用」跳过，不 delivered、不抛错
        ctx.sdk.log(`webhook 通道：宿主未提供 net 能力，跳过卡片 ${card.id} v${card.version}`)
        return
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (config.secret !== null) headers['authorization'] = `Bearer ${config.secret}`
      try {
        const response = await ctx.sdk.net.fetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(cardPayload(card)),
          timeoutMs: config.timeoutMs,
        })
        if (response.status >= 200 && response.status < 300) {
          await ctx.delivered(card.id, card.version, webhookChannelManifest.id)
          return
        }
        ctx.sdk.log(
          `webhook 通道投递失败（HTTP ${response.status}，卡片 ${card.id} v${card.version}）`,
        )
      } catch (error) {
        // 超时 / 连接失败 / delivered 被拒：只记日志（不记卡片正文），不影响其它通道与内核
        ctx.sdk.log(`webhook 通道投递异常（卡片 ${card.id} v${card.version}）：${errMsg(error)}`)
      }
    }

    const off = ctx.onCard((card) => {
      void deliver(card)
    })

    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      off()
      ctx.signal.removeEventListener('abort', dispose)
    }
    ctx.signal.addEventListener('abort', dispose, { once: true })
    if (ctx.signal.aborted) dispose()
    return dispose
  },
}
