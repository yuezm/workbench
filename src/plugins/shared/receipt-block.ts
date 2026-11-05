/**
 * 回执块解析（M4，唯一口径见 SPEC-plugins「回执与执行约定」）：
 *
 * 执行器的最终输出里可以带一个 ```json 围栏块，对象只要含
 * `ask / notices / resolves / later / events` 任一键就算回执块，其余键忽略。
 * **只看最后一个 ```json 围栏块**：该块非法 JSON / 非对象 / 不含五键任一 /
 * 字段校验不过 → 直接返回 null，不回退到更早的块（回退可能沿用上一轮或正文里的
 * 陈旧回执，宁可这次不产卡片）。解析不修改输出原文、不改终态、不抛错。
 *
 * 与 protocol 的分工是**两层校验**，不是等价的重复：
 * - 回执块层（本文件）：更严的前置过滤——空选项 `ask`、非 ISO `later`、畸形块一律
 *   忽略，宁可这次不产卡片，也不把可疑回执送进内核；
 * - 宿主层（`protocol/validate` 的 `checkReceipt`）：形状兜底——只校验必填/类型/
 *   长度/枚举，保证任意来源的 `run.receipt` 输入不破坏事实 schema。
 * 两层判据并不相同（宿主层放行的空选项 ask / 非 ISO later 到不了内核），
 * 上限常量共用 `COMMAND_LIMITS`，本文件不另定义一份。
 */
import type { Ask, RawEvent, Receipt } from '../../protocol/inputs'
import { COMMAND_LIMITS } from '../../protocol/validate'

/** 回执块可携带的五个字段；解析结果只含这些键。 */
export interface ReceiptBlock {
  ask?: Ask[]
  notices?: string[]
  resolves?: string[]
  later?: string
  events?: RawEvent[]
}

const RECEIPT_BLOCK_KEYS = ['ask', 'notices', 'resolves', 'later', 'events'] as const

/** 开围栏：```json（标签大小写不敏感）单独成行 */
const FENCE_OPEN_RE = /^```json\s*$/i
/** 闭围栏：``` 单独成行 */
const FENCE_CLOSE_RE = /^```\s*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 必填文本：非空、不超长（同 validate 的 `text`）。 */
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max

/** 可选文本：缺省 / null 视为未提供，空串允许（同 validate 的 `optionalText`）。 */
const isOptionalText = (value: unknown, max: number): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.length <= max)

/** 可选字符串：不设上限（同 validate 的 `optionalString`，用于 `events.detail`）。 */
const isOptionalString = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === 'string'

/** 逐行切出 ```json 围栏块；未闭合的块丢弃，其它语言的围栏不识别。 */
function jsonBlocks(text: string): string[] {
  const blocks: string[] = []
  let current: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (current === null) {
      if (FENCE_OPEN_RE.test(trimmed)) current = []
      continue
    }
    if (FENCE_CLOSE_RE.test(trimmed)) {
      blocks.push(current.join('\n'))
      current = null
      continue
    }
    current.push(line)
  }
  return blocks
}

/**
 * 最后一个 ```json 围栏块（没有则 null）。
 * 只认最后一块：解析失败由调用方直接判 null，不回退到更早的块。
 */
function lastJsonBlock(text: string): string | null {
  // 快速放弃：绝大多数输出没有围栏块，避免无谓切行
  if (!text.includes('```')) return null
  return jsonBlocks(text).at(-1) ?? null
}

const parseAskList = (value: unknown): Ask[] | null => {
  if (!Array.isArray(value) || value.length > COMMAND_LIMITS.receiptItems) return null
  for (const entry of value) {
    if (!isRecord(entry)) return null
    if (!isText(entry.title, COMMAND_LIMITS.title)) return null
    if (!isOptionalText(entry.text, COMMAND_LIMITS.description)) return null
    if (!Array.isArray(entry.options)) return null
    // 空选项的 ask 无法拍板：整块忽略（协议层允许空数组，比分回执块口径更严）
    if (entry.options.length === 0 || entry.options.length > COMMAND_LIMITS.askOptions) return null
    for (const option of entry.options) {
      if (!isText(option, COMMAND_LIMITS.title)) return null
    }
    if (!isOptionalText(entry.key, COMMAND_LIMITS.id)) return null
  }
  return value as Ask[]
}

const parseNotices = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > COMMAND_LIMITS.receiptItems) return null
  for (const notice of value) {
    if (!isText(notice, COMMAND_LIMITS.description)) return null
  }
  return value as string[]
}

const parseResolves = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > COMMAND_LIMITS.receiptItems) return null
  for (const id of value) {
    if (!isText(id, COMMAND_LIMITS.id)) return null
  }
  return value as string[]
}

const parseEvents = (value: unknown): RawEvent[] | null => {
  if (!Array.isArray(value) || value.length > COMMAND_LIMITS.receiptItems) return null
  for (const entry of value) {
    if (!isRecord(entry)) return null
    if (!isText(entry.source, COMMAND_LIMITS.name)) return null
    if (!isText(entry.type, COMMAND_LIMITS.name)) return null
    if (!isText(entry.subject, COMMAND_LIMITS.title)) return null
    if (!isOptionalText(entry.summary, COMMAND_LIMITS.summary)) return null
    if (!isOptionalString(entry.detail)) return null
    if (!isOptionalText(entry.link, COMMAND_LIMITS.workdir)) return null
    if (!isOptionalText(entry.dedupeKey, COMMAND_LIMITS.id)) return null
  }
  return value as RawEvent[]
}

const parseLater = (value: unknown): string | null => {
  if (!isText(value, COMMAND_LIMITS.iso)) return null
  // 内核会把 later 直接当 notBefore：非 ISO 时间整块忽略，不让无效时刻进调度
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * 解析执行器输出里的回执块。
 *
 * 只看最后一个 ```json 围栏块：没有块、非法 JSON、不是对象、五键全无、
 * 或任一字段校验不过，都返回 `null`（不回退到更早的块）。不抛异常。
 */
export function parseReceiptBlock(output: string): ReceiptBlock | null {
  const blockText = lastJsonBlock(output)
  if (blockText === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(blockText)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const block: ReceiptBlock = {}
  let fields = 0

  for (const key of RECEIPT_BLOCK_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue
    const value = parsed[key]
    // 缺省 / null 视为未提供（同 protocol 回执校验口径）
    if (value === null || value === undefined) continue
    switch (key) {
      case 'ask': {
        const ask = parseAskList(value)
        if (!ask) return null
        if (ask.length > 0) {
          block.ask = ask
          fields += 1
        }
        break
      }
      case 'notices': {
        const notices = parseNotices(value)
        if (!notices) return null
        if (notices.length > 0) {
          block.notices = notices
          fields += 1
        }
        break
      }
      case 'resolves': {
        const resolves = parseResolves(value)
        if (!resolves) return null
        if (resolves.length > 0) {
          block.resolves = resolves
          fields += 1
        }
        break
      }
      case 'later': {
        const later = parseLater(value)
        if (!later) return null
        block.later = later
        fields += 1
        break
      }
      case 'events': {
        const events = parseEvents(value)
        if (!events) return null
        if (events.length > 0) {
          block.events = events
          fields += 1
        }
        break
      }
    }
  }

  return fields > 0 ? block : null
}

/**
 * 把输出里的回执块写进回执：只补五个字段，解析失败保持原样。
 *
 * 执行器接线只调这一处——不改 `output`、不改终态、不抛错。
 */
export function applyReceiptBlock(receipt: Receipt, output: string): void {
  const block = parseReceiptBlock(output)
  if (!block) return
  if (block.ask !== undefined) receipt.ask = block.ask
  if (block.notices !== undefined) receipt.notices = block.notices
  if (block.resolves !== undefined) receipt.resolves = block.resolves
  if (block.later !== undefined) receipt.later = block.later
  if (block.events !== undefined) receipt.events = block.events
}
