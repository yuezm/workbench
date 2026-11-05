/**
 * 外部插件宿主契约（M7）：用户目录 manifest 的校验与 stdio JSONL 帧。
 *
 * 目录约定：`<userData>/plugins/<kind>/<id>/manifest.json` + `plugin.mjs`（固定入口名）。
 * 本文件只做**纯函数**形状判定（不读盘、不 spawn），装载器 `host/plugins/discover`
 * 负责目录扫描、入口文件检查与内置合并；子进程与帧收发在 `host/plugins/process`。
 *
 * 帧协议 v1（`PLUGIN_HOST_PROTOCOL_VERSION`）：
 * - host → plugin：`welcome`（授权后的能力 + config + secret）、`card`（channel）、`shutdown`；
 * - plugin → host：`hello`（自报 manifest 身份）、`log`、`event`（source）、
 *   `delivered` / `answer`（channel）。
 *
 * 约束：插件自报的 `hello.id/kind/version/capabilities` 必须与磁盘 manifest 逐字段一致，
 * 不一致按宿主侧的 manifest 为准并终止该插件（防止运行期改写授权面）。
 */
import type { Card } from './entities'
import type { RawEvent } from './inputs'
import {
  CAPABILITIES,
  PLUGIN_KINDS,
  type Capability,
  type ConfigField,
  type PluginKind,
  type PluginManifest,
} from './manifest'

/** 帧协议版本：形状变化时递增，宿主与插件都按它做兼容判断。 */
export const PLUGIN_HOST_PROTOCOL_VERSION = 1

/** 外部插件固定文件名（安装在用户目录时只拷贝这两个文件）。 */
export const EXTERNAL_PLUGIN_MANIFEST = 'manifest.json'
export const EXTERNAL_PLUGIN_ENTRY = 'plugin.mjs'

/** M7 开放给外部插件的类别：executor 需要 probe/models/领取往返，另立协议面。 */
export const EXTERNAL_PLUGIN_KINDS = ['source', 'channel'] as const

export type ExternalPluginKind = (typeof EXTERNAL_PLUGIN_KINDS)[number]

/** 外部插件运行上限：单帧、日志行、hello 超时、重启次数与间隔。 */
export const PLUGIN_HOST_LIMITS = {
  frameBytes: 64 * 1024,
  logLine: 2_000,
  helloTimeoutMs: 5_000,
  restartMax: 3,
  restartDelayMs: 1_000,
  /** `welcome` 下发的 config / secret 条数上限 */
  configEntries: 32,
  configValue: 2_000,
  /** `event` 帧的 subject / summary 上限（与内核对 RawEvent 的口径一致） */
  eventSubject: 400,
  eventSummary: 200,
} as const

/** manifest 被拒绝的原因（宿主视图 `plugins.all` 直接展示 `detail`）。 */
export const MANIFEST_REJECT_REASONS = [
  'manifest_invalid',
  'kind_unsupported',
  'entry_missing',
  'duplicate_id',
] as const

export type ManifestRejectReason = (typeof MANIFEST_REJECT_REASONS)[number]

export interface ManifestParseFailure {
  ok: false
  reason: Extract<ManifestRejectReason, 'manifest_invalid' | 'kind_unsupported'>
  detail: string
}

export type ManifestParseResult = { ok: true; manifest: PluginManifest } | ManifestParseFailure

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 插件 id 形状：kebab-case slug（与运行时 `executorKey` 同一正则）。 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID_PATTERN.test(value)
}

const isKind = (value: unknown): value is PluginKind =>
  typeof value === 'string' && (PLUGIN_KINDS as readonly string[]).includes(value)

const isCapability = (value: unknown): value is Capability =>
  typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)

const nonEmptyString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max

const CONFIG_FIELD_TYPES = ['text', 'secret', 'select', 'number', 'boolean'] as const

/** `ConfigField` 的形状校验（与 SPEC-plugins 的 manifest 一致）。 */
function parseConfigField(value: unknown, index: number): ConfigField | string {
  if (typeof value !== 'object' || value === null) return `config[${index}] 不是对象`
  const record = value as Record<string, unknown>
  const key = record['key']
  const label = record['label']
  const type = record['type']
  if (!nonEmptyString(key, 64)) return `config[${index}].key 非法`
  if (!nonEmptyString(label, 80)) return `config[${index}].label 非法`
  if (typeof type !== 'string' || !(CONFIG_FIELD_TYPES as readonly string[]).includes(type)) {
    return `config[${index}].type 非法`
  }
  const help = record['help']
  if (help !== undefined && typeof help !== 'string') return `config[${index}].help 非法`
  if (record['required'] !== undefined && typeof record['required'] !== 'boolean') {
    return `config[${index}].required 非法`
  }
  if (type === 'text' || type === 'secret' || type === 'select') {
    const options = record['options']
    if (type === 'select') {
      if (!Array.isArray(options) || options.length === 0 || options.length > 50) {
        return `config[${index}].options 非法`
      }
      for (const option of options) {
        if (typeof option !== 'string' || option.length === 0 || option.length > 80) {
          return `config[${index}].options 非法`
        }
      }
    } else if (options !== undefined) {
      return `config[${index}].options 仅 select 可用`
    }
    const defaultValue = record['default']
    if (defaultValue !== undefined && typeof defaultValue !== 'string') {
      return `config[${index}].default 非法`
    }
    const field: ConfigField = { key, label, type, ...(help === undefined ? {} : { help }) }
    if (record['required'] !== undefined) field.required = record['required'] === true
    if (defaultValue !== undefined) field.default = defaultValue
    if (type === 'select') field.options = options as string[]
    return field
  }
  if (record['options'] !== undefined) return `config[${index}].options 仅 select 可用`
  const defaultValue = record['default']
  if (type === 'number') {
    if (defaultValue !== undefined && typeof defaultValue !== 'number') {
      return `config[${index}].default 非法`
    }
  } else if (defaultValue !== undefined && typeof defaultValue !== 'boolean') {
    return `config[${index}].default 非法`
  }
  const numeric = type === 'number'
  const field: ConfigField = {
    key,
    label,
    type: numeric ? 'number' : 'boolean',
    ...(help === undefined ? {} : { help }),
  }
  if (record['required'] !== undefined) field.required = record['required'] === true
  if (defaultValue !== undefined) field.default = defaultValue as number | boolean
  return field
}

/**
 * 解析用户目录里的 `manifest.json`（已是 JSON.parse 后的值）。
 *
 * 只判定形状与「kind 是否在 M7 开放范围内」；入口文件是否存在由装载器查盘。
 * 任一项非法都返回具体原因：调用方不得静默降级，必须把 `detail` 展示给用户。
 */
export function parseExternalManifest(value: unknown): ManifestParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'manifest_invalid', detail: 'manifest 不是对象' }
  }
  const record = value as Record<string, unknown>
  const id = record['id']
  if (!isPluginId(id))
    return { ok: false, reason: 'manifest_invalid', detail: 'id 不是 kebab-case' }
  const kind = record['kind']
  if (!isKind(kind)) return { ok: false, reason: 'manifest_invalid', detail: 'kind 非法' }
  if (!(EXTERNAL_PLUGIN_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'kind_unsupported', detail: `M7 不开放外部 ${kind} 插件` }
  }
  if (!nonEmptyString(record['name'], 80)) {
    return { ok: false, reason: 'manifest_invalid', detail: 'name 缺失或过长' }
  }
  if (!nonEmptyString(record['version'], 32)) {
    return { ok: false, reason: 'manifest_invalid', detail: 'version 缺失或过长' }
  }
  const description = record['description']
  if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
    return { ok: false, reason: 'manifest_invalid', detail: 'description 非法' }
  }
  const capabilities = record['capabilities']
  if (!Array.isArray(capabilities) || capabilities.length > CAPABILITIES.length) {
    return { ok: false, reason: 'manifest_invalid', detail: 'capabilities 非法' }
  }
  const parsedCapabilities: Capability[] = []
  for (const capability of capabilities) {
    if (!isCapability(capability)) {
      return { ok: false, reason: 'manifest_invalid', detail: `未知能力: ${String(capability)}` }
    }
    if (!parsedCapabilities.includes(capability)) parsedCapabilities.push(capability)
  }
  const rawConfig = record['config']
  const config: ConfigField[] = []
  if (rawConfig !== undefined) {
    if (!Array.isArray(rawConfig) || rawConfig.length > PLUGIN_HOST_LIMITS.configEntries) {
      return { ok: false, reason: 'manifest_invalid', detail: 'config 非法' }
    }
    const keys = new Set<string>()
    for (const [index, item] of rawConfig.entries()) {
      const field = parseConfigField(item, index)
      if (typeof field === 'string') return { ok: false, reason: 'manifest_invalid', detail: field }
      if (keys.has(field.key)) {
        return { ok: false, reason: 'manifest_invalid', detail: `config 键重复: ${field.key}` }
      }
      keys.add(field.key)
      config.push(field)
    }
  }
  const manifest: PluginManifest = {
    id,
    kind,
    name: record['name'] as string,
    version: record['version'] as string,
    capabilities: parsedCapabilities,
    ...(description === undefined ? {} : { description }),
    ...(rawConfig === undefined ? {} : { config }),
  }
  return { ok: true, manifest }
}

// ---------- stdio JSONL 帧 ----------

export interface HelloFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'hello'
  id: string
  kind: PluginKind
  version: string
  capabilities: Capability[]
}

export interface LogFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'log'
  line: string
}

/** source 插件产生的外部事件（形状与 `RawEvent` 一致）。 */
export interface EventFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'event'
  event: RawEvent
}

export interface DeliveredFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'delivered'
  cardId: string
  version: number
  ref: string
}

export interface AnswerFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'answer'
  cardId: string
  optionIndex: number
}

export type PluginToHostFrame = HelloFrame | LogFrame | EventFrame | DeliveredFrame | AnswerFrame

export interface WelcomeFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'welcome'
  pluginId: string
  /** 授权后的能力（⊆ manifest 声明） */
  granted: Capability[]
  /** 非 secret 配置 + 已授权的 secret（明文只经管道下发，不落日志） */
  config: Record<string, string | number | boolean>
}

export interface CardFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'card'
  card: Card
}

export interface ShutdownFrame {
  v: typeof PLUGIN_HOST_PROTOCOL_VERSION
  type: 'shutdown'
}

export type HostToPluginFrame = WelcomeFrame | CardFrame | ShutdownFrame

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkRawEventShape = (value: unknown): string | null => {
  if (!isRecord(value)) return 'event 不是对象'
  if (!nonEmptyString(value['source'], 64)) return 'event.source 非法'
  if (!nonEmptyString(value['type'], 100)) return 'event.type 非法'
  if (!nonEmptyString(value['subject'], PLUGIN_HOST_LIMITS.eventSubject)) {
    return 'event.subject 非法'
  }
  if (
    value['summary'] !== undefined &&
    !nonEmptyString(value['summary'], PLUGIN_HOST_LIMITS.eventSummary)
  ) {
    return 'event.summary 非法'
  }
  for (const key of ['detail', 'link', 'dedupeKey'] as const) {
    const field = value[key]
    if (
      field !== undefined &&
      (typeof field !== 'string' || field.length > PLUGIN_HOST_LIMITS.configValue)
    ) {
      return `event.${key} 非法`
    }
  }
  return null
}

/**
 * 解析一行插件输出。非 JSON、形状不合法、非本版本帧一律返回 `null`
 * （调用方计一条警告后丢弃；**不猜测**未知帧的语义）。
 */
export function parsePluginFrame(line: string): PluginToHostFrame | null {
  if (line.length === 0 || line.length > PLUGIN_HOST_LIMITS.frameBytes) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value['v'] !== PLUGIN_HOST_PROTOCOL_VERSION) return null
  const type = value['type']
  switch (type) {
    case 'hello': {
      if (!isPluginId(value['id'])) return null
      if (!isKind(value['kind'])) return null
      if (!nonEmptyString(value['version'], 32)) return null
      const capabilities = value['capabilities']
      if (!Array.isArray(capabilities)) return null
      const parsed: Capability[] = []
      for (const capability of capabilities) {
        if (!isCapability(capability)) return null
        if (!parsed.includes(capability)) parsed.push(capability)
      }
      return {
        v: PLUGIN_HOST_PROTOCOL_VERSION,
        type: 'hello',
        id: value['id'],
        kind: value['kind'],
        version: value['version'],
        capabilities: parsed,
      }
    }
    case 'log': {
      const line = value['line']
      if (typeof line !== 'string' || line.length > PLUGIN_HOST_LIMITS.logLine) return null
      return { v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'log', line }
    }
    case 'event': {
      if (checkRawEventShape(value['event']) !== null) return null
      return {
        v: PLUGIN_HOST_PROTOCOL_VERSION,
        type: 'event',
        event: value['event'] as RawEvent,
      }
    }
    case 'delivered': {
      if (!nonEmptyString(value['cardId'], 128)) return null
      if (typeof value['version'] !== 'number' || !Number.isInteger(value['version'])) return null
      if (!nonEmptyString(value['ref'], 128)) return null
      return {
        v: PLUGIN_HOST_PROTOCOL_VERSION,
        type: 'delivered',
        cardId: value['cardId'],
        version: value['version'],
        ref: value['ref'],
      }
    }
    case 'answer': {
      if (!nonEmptyString(value['cardId'], 128)) return null
      if (typeof value['optionIndex'] !== 'number' || !Number.isInteger(value['optionIndex'])) {
        return null
      }
      return {
        v: PLUGIN_HOST_PROTOCOL_VERSION,
        type: 'answer',
        cardId: value['cardId'],
        optionIndex: value['optionIndex'],
      }
    }
    default:
      return null
  }
}

/** 编码一条宿主 → 插件帧（JSONL：单行 + `\n`）。 */
export function encodePluginFrame(frame: HostToPluginFrame): string {
  return JSON.stringify(frame) + '\n'
}

/** 把 manifest 的 secret 字段名挑出来（`welcome` 只下发非 secret；secret 单独合并）。 */
export function secretFieldKeys(manifest: PluginManifest): string[] {
  return (manifest.config ?? [])
    .filter((field) => field.type === 'secret')
    .map((field) => field.key)
}

/** 帧解析失败时的诊断文字（不含帧内容，避免把插件输出写进日志）。 */
export function frameErrorLine(error: unknown): string {
  return `插件帧处理失败：${errMsg(error)}`
}
