/**
 * webhook 来源插件（M7 D9）：本机回环 HTTP + HMAC 验签，通过后产一条外部事件。
 *
 * 边界：
 * - 只经 `ctx.sdk.net` 监听与验签（ESLint 禁止插件 import node 内置）：`listen` 只绑
 *   `127.0.0.1` 由宿主保证，插件不指定地址；HMAC 计算留在宿主，插件只做时间窗与形状判定；
 * - 只接受 POST 且路径与配置一致；`x-webhook-timestamp` 在容差内、
 *   `x-webhook-signature: sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))>`
 *   验签通过才 `ctx.emit(event)`；
 * - 校验失败一律回 4xx 且**不产事件**，异常不抛给宿主（handler 内自捕获）；
 * - 未配置 secret / 端口非法 / 路径非法时 `start` 返回 no-op dispose 并记日志：
 *   「未配置 = 不监听」，不伪造成功、不影响其它来源；
 * - 事件正文只是资料：`source` 缺省 `webhook` 且必须是 slug，`type` 必须 kebab-case，
 *   `subject` / `summary` 等按 `RawEvent` 形状与内核对齐（超限 400）。
 */
import type { RawEvent } from '../../../protocol/inputs'
import type {
  NetCapability,
  NetListener,
  NetReply,
  NetRequest,
  SourceContext,
  SourcePlugin,
} from '../../../sdk/types'
export { webhookManifest } from './manifest'

/** 配置缺省值（与 `manifest.config` 的 default 同一口径；宿主未合并默认值时也照此兜底）。 */
export const WEBHOOK_DEFAULTS = {
  port: 47615,
  path: '/webhook',
  toleranceSeconds: 300,
} as const

/** 时间窗上限（秒）：再大就没有「时间窗」意义了。 */
const MAX_TOLERANCE_SECONDS = 86_400

/** 请求路径上限（与 `COMMAND_LIMITS.workdir` 同量级，防御超长头）。 */
const MAX_PATH_LENGTH = 200

/** 签名头格式：`sha256=<64 位十六进制>`（大小写不敏感）。 */
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i

/** 事件字段上限（与 `protocol/validate.ts` 对 `RawEvent` 的口径一致）。 */
const EVENT_LIMITS = {
  type: 100,
  subject: 200,
  summary: 200,
  detail: 20_000,
  link: 1_000,
  dedupeKey: 200,
} as const

/** `source` 形状：小写 slug（缺省 `webhook`）。 */
const SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** `type` 形状：kebab-case（允许点分段，如 `issues.opened`）。 */
const TYPE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

/** 事件缺省来源（与 SPEC-plugins 的 `source` 清单一致）。 */
export const DEFAULT_EVENT_SOURCE = 'webhook'

/** 未配置时的 dispose：来源本来就没监听，调用无副作用且可重复。 */
const noopDispose = (): void => undefined

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const reply = (status: number, error?: string): NetReply => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: error === undefined ? '{"ok":true}' : JSON.stringify({ error }),
})

/** webhook 来源的归一化配置（缺省值已填充、secret 已确认非空）。 */
export interface WebhookSourceConfig {
  port: number
  path: string
  secret: string
  toleranceSeconds: number
}

export type WebhookConfigResult =
  { ok: true; config: WebhookSourceConfig; warnings: string[] } | { ok: false; reason: string }

/**
 * 读取并归一化配置：缺 secret / 端口或路径非法时返回失败原因（调用方据此 no-op）；
 * `toleranceSeconds` 非法只降级为默认值并给一条警告（时间窗配置坏不该让来源不监听）。
 */
export function readWebhookConfig(raw: Record<string, unknown>): WebhookConfigResult {
  const secret = raw['secret']
  if (typeof secret !== 'string' || secret.trim() === '') {
    return { ok: false, reason: '未配置 secret' }
  }

  const portValue = raw['port']
  const port = portValue === undefined || portValue === null ? WEBHOOK_DEFAULTS.port : portValue
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: `port 非法（${String(portValue)}，需 1–65535 的整数）` }
  }

  const pathValue = raw['path']
  const path = pathValue === undefined || pathValue === null ? WEBHOOK_DEFAULTS.path : pathValue
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `path 非法（${String(pathValue)}，需以 / 开头且不超过 200 字）` }
  }

  const warnings: string[] = []
  let toleranceSeconds: number = WEBHOOK_DEFAULTS.toleranceSeconds
  const toleranceValue = raw['toleranceSeconds']
  if (toleranceValue !== undefined && toleranceValue !== null) {
    if (
      typeof toleranceValue === 'number' &&
      Number.isInteger(toleranceValue) &&
      toleranceValue >= 1 &&
      toleranceValue <= MAX_TOLERANCE_SECONDS
    ) {
      toleranceSeconds = toleranceValue
    } else {
      warnings.push(
        `toleranceSeconds 非法（${String(toleranceValue)}），按默认 ${WEBHOOK_DEFAULTS.toleranceSeconds} 秒处理`,
      )
    }
  }

  // secret 原样使用（HMAC 密钥是 opaque 字节序列，不做 trim 改写）
  return { ok: true, config: { port, path, secret, toleranceSeconds }, warnings }
}

export type RawEventResult = { ok: true; event: RawEvent } | { ok: false; reason: string }

/** 可选文本字段：缺省/null 视为未提供，给了就必须是字符串且在长度上限内。 */
function readOptional(
  record: Record<string, unknown>,
  key: 'summary' | 'detail' | 'link' | 'dedupeKey',
  max: number,
): { ok: true; value: string | undefined } | { ok: false } {
  const value = record[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string' || value.length > max) return { ok: false }
  return { ok: true, value }
}

/**
 * 把请求体（已 JSON.parse）收窄成 `RawEvent`：只保留契约字段，未知键丢弃；
 * 形状不合法返回原因（调用方回 400，不产事件）。
 */
export function parseRawEvent(value: unknown): RawEventResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'body 必须是 JSON 对象' }
  }
  const record = value as Record<string, unknown>

  const sourceValue = record['source']
  const source =
    sourceValue === undefined || sourceValue === null ? DEFAULT_EVENT_SOURCE : sourceValue
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    return { ok: false, reason: 'source 必须是 kebab-case slug（≤64）' }
  }

  const type = record['type']
  if (typeof type !== 'string' || type.length > EVENT_LIMITS.type || !TYPE_PATTERN.test(type)) {
    return { ok: false, reason: 'type 必须是 kebab-case（如 issues.opened，≤100）' }
  }

  const subject = record['subject']
  if (
    typeof subject !== 'string' ||
    subject.trim() === '' ||
    subject.length > EVENT_LIMITS.subject
  ) {
    return { ok: false, reason: 'subject 必填且不超过 200 字' }
  }

  const summary = readOptional(record, 'summary', EVENT_LIMITS.summary)
  if (!summary.ok) return { ok: false, reason: 'summary 必须是不超过 200 字的字符串' }
  const detail = readOptional(record, 'detail', EVENT_LIMITS.detail)
  if (!detail.ok) return { ok: false, reason: 'detail 必须是不超过 20000 字的字符串' }
  const link = readOptional(record, 'link', EVENT_LIMITS.link)
  if (!link.ok) return { ok: false, reason: 'link 必须是不超过 1000 字的字符串' }
  const dedupeKey = readOptional(record, 'dedupeKey', EVENT_LIMITS.dedupeKey)
  if (!dedupeKey.ok) return { ok: false, reason: 'dedupeKey 必须是不超过 200 字的字符串' }

  const event: RawEvent = { source, type, subject }
  if (summary.value !== undefined) event.summary = summary.value
  if (detail.value !== undefined) event.detail = detail.value
  if (link.value !== undefined) event.link = link.value
  if (dedupeKey.value !== undefined) event.dedupeKey = dedupeKey.value
  return { ok: true, event }
}

/** 头名大小写不敏感取值（宿主原样透传头，不保证统一小写）。 */
function headerOf(headers: Record<string, string>, name: string): string | null {
  const direct = headers[name]
  if (direct !== undefined) return direct
  const lowered = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) return headers[key] ?? null
  }
  return null
}

/** 时间戳：epoch 秒（纯数字）或 RFC3339；解析失败返回 null。 */
function parseTimestamp(raw: string): number | null {
  if (/^\d{1,12}$/.test(raw)) {
    const seconds = Number(raw)
    return seconds > 0 ? seconds * 1_000 : null
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

export interface WebhookHandlerDeps {
  config: WebhookSourceConfig
  net: NetCapability
  now: () => number
  emit: (event: RawEvent) => void
  log: (line: string) => void
}

/**
 * 请求处理：校验顺序 = 方法 → 路径 → 时间戳/签名头 → 时间窗 → 验签 → body 形状 → emit。
 * 验签在解析 body 之前（HMAC 覆盖原文，先拒绝再解析）；任何一步失败都回 4xx 且零事件。
 */
export function createWebhookHandler(
  deps: WebhookHandlerDeps,
): (request: NetRequest) => Promise<NetReply> {
  const { config, net, now, emit, log } = deps
  return async (request) => {
    try {
      if (request.method.toUpperCase() !== 'POST') return reply(405, '只接受 POST')
      if (request.path !== config.path) return reply(404, '路径不匹配')

      const timestamp = headerOf(request.headers, 'x-webhook-timestamp')
      const signature = headerOf(request.headers, 'x-webhook-signature')
      if (timestamp === null || signature === null) return reply(401, '缺少签名头')

      const signedAt = parseTimestamp(timestamp)
      if (signedAt === null) return reply(401, '时间戳非法')
      if (Math.abs(now() - signedAt) > config.toleranceSeconds * 1_000) {
        return reply(401, '时间戳超出容差')
      }

      const matched = SIGNATURE_PATTERN.exec(signature)
      if (matched === null) return reply(401, '签名格式非法')
      if (!net.verifyHmacSha256(config.secret, `${timestamp}.${request.body}`, matched[1])) {
        return reply(401, '签名校验失败')
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(request.body)
      } catch {
        return reply(400, 'body 不是合法 JSON')
      }
      const event = parseRawEvent(parsed)
      if (!event.ok) return reply(400, event.reason)

      emit(event.event)
      return reply(200)
    } catch (error) {
      // 插件不把异常抛给宿主：记日志并回 500（不产事件）
      log(`webhook 请求处理异常：${errMsg(error)}`)
      return reply(500, '处理失败')
    }
  }
}

export const webhookSource: SourcePlugin = {
  async start(ctx: SourceContext): Promise<() => void> {
    const raw = ctx.sdk.config<Record<string, unknown> | null>() ?? {}
    const parsed = readWebhookConfig(raw)
    if (!parsed.ok) {
      ctx.sdk.log(`${parsed.reason}：webhook 来源不监听（未配置即不接收事件）`)
      return noopDispose
    }
    for (const warning of parsed.warnings) ctx.sdk.log(warning)

    const handler = createWebhookHandler({
      config: parsed.config,
      net: ctx.sdk.net,
      now: () => ctx.sdk.now(),
      emit: (event) => ctx.emit(event),
      log: (line) => ctx.sdk.log(line),
    })

    // 端口占用等运行时失败：抛给 hub 隔离（本来源失败不影响其它来源），由 hub 记状态与日志
    const listener: NetListener = await ctx.sdk.net
      .listen(parsed.config.port, handler)
      .catch((error: unknown) => {
        throw new Error(`webhook 来源监听 127.0.0.1:${parsed.config.port} 失败：${errMsg(error)}`)
      })

    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      ctx.signal.removeEventListener('abort', dispose)
      void listener.close().catch((error: unknown) => {
        ctx.sdk.log(`webhook 来源关闭监听失败（已忽略）：${errMsg(error)}`)
      })
    }
    ctx.signal.addEventListener('abort', dispose, { once: true })
    if (ctx.signal.aborted) dispose()
    return dispose
  },
}
