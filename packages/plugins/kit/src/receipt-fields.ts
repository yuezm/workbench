/**
 * 回执字段校验（M24 从 `receipt-block.ts` 抽出）：**fence 文本块与 tool 通道共用**。
 *
 * 两条传输只是「怎么拿到那个 JSON 对象」不同：
 * - 文本通道（`receipt-block.ts`）：从输出里切最后一个 ```json 围栏块；
 * - 工具通道（`receipt-tool.ts`）：从 `tool_call` 帧的 `arguments` 里拿。
 *
 * 拿到对象之后一律走 `receiptFromObject`——字段口径、上限、丢键判据只有一份，
 * 不会出现「文本能过、工具过不了」这种双标准。
 *
 * 与 protocol 的分工（沿用 M4）：本文件是更严的前置过滤（空选项 `ask`、非 ISO `later`、
 * 重复小标的 `findings`、缺 `checkRef` 的 `fixed` …），宿主层 `protocol/validate` 只做
 * 形状兜底。上限常量共用，不在这里另定义一份。
 *
 * R1（2026-11-21）：**逐键容错**。旧口径「任一键不合格整块作废」会把同块的 `ask`
 * 一起丢掉（实测一次闸门卡死），现在坏键只丢它自己并留下原因。
 */
import type { GateCheck, GateVerdict } from '@workbench/protocol/entities'
import { ACCEPTANCE_LIMITS, GATE_VERDICTS } from '@workbench/protocol/entities'
import type { Ask, RawEvent, Receipt, SpawnTask } from '@workbench/protocol/inputs'
import type { FindingAddress, ReviewFindingInput } from '@workbench/protocol/review'
import { FINDING_DISPOSITIONS, REVIEW_LIMITS, REVIEW_SEVERITIES } from '@workbench/protocol/review'
import { RECEIPT_KEYS } from '@workbench/protocol/receipt-keys'
import { COMMAND_LIMITS } from '@workbench/protocol/validate'
import { THREAD_LIMITS } from '@workbench/protocol/thread'

/** 回执块可携带的十二个字段；解析结果只含这些键。 */
export interface ReceiptBlock {
  ask?: Ask[]
  notices?: string[]
  resolves?: string[]
  later?: string
  events?: RawEvent[]
  /** 派生子任务（M8）：每条 ≤2000 字描述；只作声明，落地由内核决定 */
  spawn?: SpawnTask[]
  /** 线程笔记（M6.5）：每条 ≤2000 字，只作资料 */
  notes?: string[]
  /** 闸门判定（M11）：只对闸门阶段有意义；缺省 = 没给结论 */
  verdict?: GateVerdict
  /** 判定证据（M11）：`{ cmd, exitCode }`；缺省 / 空数组 = 没给证据 */
  checks?: GateCheck[]
  /** 评审清单（M14）：`id` 由内核拼 `<reportId>#<key>`，小标重复整块忽略 */
  findings?: ReviewFindingInput[]
  /** 逐条回应（M14）：`fixed` 必带 `checkRef`，其余必带 `note` */
  addresses?: FindingAddress[]
  /** 验收自评（M21）：`no` 是验收段 1 基序号；越界条目由内核丢弃 */
}

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

const isEnum = (value: unknown, allowed: readonly string[]): boolean =>
  typeof value === 'string' && allowed.includes(value)

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

const parseNotes = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > COMMAND_LIMITS.receiptItems) return null
  for (const note of value) {
    if (!isText(note, THREAD_LIMITS.noteText)) return null
  }
  return value as string[]
}

const parseSpawnList = (value: unknown): SpawnTask[] | null => {
  if (!Array.isArray(value) || value.length > COMMAND_LIMITS.spawnItems) return null
  for (const entry of value) {
    if (!isRecord(entry)) return null
    if (!isText(entry.subject, COMMAND_LIMITS.title)) return null
    if (!isOptionalText(entry.summary, COMMAND_LIMITS.description)) return null
    if (!isOptionalText(entry.stageId, COMMAND_LIMITS.id)) return null
    const batch = entry.batch
    if (batch !== undefined && batch !== null) {
      if (
        typeof batch !== 'number' ||
        !Number.isInteger(batch) ||
        batch < 1 ||
        batch > COMMAND_LIMITS.spawnBatchMax
      ) {
        return null
      }
    }
    if (!isOptionalText(entry.key, COMMAND_LIMITS.id)) return null
  }
  return value as SpawnTask[]
}

const parseLater = (value: unknown): string | null => {
  if (!isText(value, COMMAND_LIMITS.iso)) return null
  // 内核会把 later 直接当 notBefore：非 ISO 时间整块忽略，不让无效时刻进调度
  return Number.isNaN(Date.parse(value)) ? null : value
}

/** 闸门判定：只认 `pass` / `fail`，其余（含大小写变体、中文）整块忽略。 */
const parseVerdict = (value: unknown): GateVerdict | null =>
  typeof value === 'string' && (GATE_VERDICTS as readonly string[]).includes(value)
    ? (value as GateVerdict)
    : null

/** 闸门证据：命令非空且不超长，退出码为 ±1000000 内的整数（同 validate 的 `checkGateCheck`）。 */
const parseChecks = (value: unknown): GateCheck[] | null => {
  if (!Array.isArray(value) || value.length > COMMAND_LIMITS.gateChecks) return null
  for (const entry of value) {
    if (!isRecord(entry)) return null
    if (!isText(entry.cmd, COMMAND_LIMITS.gateCmd)) return null
    if (typeof entry.exitCode !== 'number' || !Number.isInteger(entry.exitCode)) return null
    if (entry.exitCode < -1_000_000 || entry.exitCode > 1_000_000) return null
    // M34：指向第 n 条验收（1 基），可省略 = 与验收无关的环境检查
    if (entry.acceptance !== undefined && entry.acceptance !== null) {
      if (typeof entry.acceptance !== 'number' || !Number.isInteger(entry.acceptance)) return null
      if (entry.acceptance < 1 || entry.acceptance > ACCEPTANCE_LIMITS.maxItems) return null
    }
  }
  return value as GateCheck[]
}

/**
 * 评审清单（M14）：`key` / `severity` / `claim` / `requiredAction` 必填，小标不得重复
 * （重复会让 `<reportId>#<key>` 撞车，逐条闭环就断了）——任一条不合格整块忽略。
 */
const parseFindings = (value: unknown): ReviewFindingInput[] | null => {
  if (!Array.isArray(value) || value.length > REVIEW_LIMITS.maxFindings) return null
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry)) return null
    if (!isText(entry.key, REVIEW_LIMITS.key)) return null
    if (!isEnum(entry.severity, REVIEW_SEVERITIES)) return null
    if (!isOptionalText(entry.location, REVIEW_LIMITS.location)) return null
    if (!isText(entry.claim, REVIEW_LIMITS.claim)) return null
    if (!isOptionalText(entry.evidence, REVIEW_LIMITS.evidence)) return null
    if (!isText(entry.requiredAction, REVIEW_LIMITS.requiredAction)) return null
    const key = entry.key.trim()
    if (seen.has(key)) return null
    seen.add(key)
  }
  return value as ReviewFindingInput[]
}

/**
 * 逐条回应（M14）：`fixed` 必须带 `checkRef`（指向同块里退出码 0 的 `checks`，
 * 交叉核对在内核做），`rejected` / `deferred` 必须写理由——缺一个整块忽略。
 */
const parseAddresses = (value: unknown): FindingAddress[] | null => {
  if (!Array.isArray(value) || value.length > REVIEW_LIMITS.maxAddresses) return null
  for (const entry of value) {
    if (!isRecord(entry)) return null
    if (!isEnum(entry.disposition, FINDING_DISPOSITIONS)) return null
    if (!isText(entry.findingId, COMMAND_LIMITS.id)) return null
    if (!isOptionalText(entry.checkRef, COMMAND_LIMITS.gateCmd)) return null
    if (!isOptionalText(entry.note, REVIEW_LIMITS.note)) return null
    if (entry.disposition === 'fixed' && (entry.checkRef ?? '') === '') return null
    if (entry.disposition !== 'fixed' && (entry.note ?? '') === '') return null
  }
  return value as FindingAddress[]
}

/** 被丢掉的一个键：键名 + 一句可读的原因（R1：坏键只丢它自己）。 */
export interface ReceiptDrop {
  key: (typeof RECEIPT_KEYS)[number]
  reason: string
}

/** 逐键解析的结果：能用的块（一个键都没成时是 null）+ 被丢掉的键。 */
export interface ReceiptParse {
  block: ReceiptBlock | null
  dropped: ReceiptDrop[]
}

/**
 * 被丢键的说明：优先说该键自己的口径（模型照它改就能过），否则给一句通用的。
 *
 * 只用于诊断与人读，不参与校验判定。
 */
function dropReason(key: (typeof RECEIPT_KEYS)[number], value: unknown): string {
  switch (key) {
    case 'verdict':
      return `${key}: 只能是 pass / fail`
    case 'checks':
      return `${key}: 每条需要 cmd（非空）与 exitCode（整数；acceptance 1–12 可选）`
    case 'findings':
      return `${key}: severity 只能是 blocker / high / medium / low（Critical / Required / Optional / Nit 不认）`
    case 'addresses':
      return `${key}: disposition 只能是 fixed / rejected / deferred；fixed 带 checkRef，其余带 note`
    case 'ask':
      return `${key}: 需要 title 与非空 options（≤20 项，每项 ≤200 字）`
    case 'events':
      return `${key}: source / type / subject 必填`
    case 'spawn':
      return `${key}: subject 必填；batch 1–20 的整数`
    case 'later':
      return `${key}: 需要 ISO 8601 时刻`
    case 'deliverables':
      return `${key}: 需要对象（branch / base / commits / files / gates）`
    default:
      return `${key}: 形状或长度超出上限（${Array.isArray(value) ? '数组' : typeof value}）`
  }
}

/**
 * 回执对象 → 回执块（fence 与 tool 共用）。
 *
 * **逐键容错（R1）**：每个键独立校验，校验不过的键丢掉、其余照收——一个坏
 * `findings[].severity` 不能连坐同块的 `ask`（实测代价是一次闸门卡死）。
 * 未知键与 `null` 值一律忽略；空数组视为未提供。
 *
 * 一个合法键都没有时 `block` 为 `null`，但 `dropped` 仍带原因（工具通道据此回错误）。
 */
export function receiptFromObject(parsed: unknown): ReceiptParse {
  if (!isRecord(parsed)) return { block: null, dropped: [] }

  const block: ReceiptBlock = {}
  const dropped: ReceiptDrop[] = []
  let fields = 0

  /** 校验失败：丢掉这个键，记一句原因，继续下一个键。 */
  const drop = (key: (typeof RECEIPT_KEYS)[number], value: unknown): void => {
    dropped.push({ key, reason: dropReason(key, value) })
  }

  for (const key of RECEIPT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue
    const value = parsed[key]
    // 缺省 / null 视为未提供（同 protocol 回执校验口径）
    if (value === null || value === undefined) continue
    switch (key) {
      case 'ask': {
        const ask = parseAskList(value)
        if (!ask) drop(key, value)
        else if (ask.length > 0) {
          block.ask = ask
          fields += 1
        }
        break
      }
      case 'notices': {
        const notices = parseNotices(value)
        if (!notices) drop(key, value)
        else if (notices.length > 0) {
          block.notices = notices
          fields += 1
        }
        break
      }
      case 'resolves': {
        const resolves = parseResolves(value)
        if (!resolves) drop(key, value)
        else if (resolves.length > 0) {
          block.resolves = resolves
          fields += 1
        }
        break
      }
      case 'later': {
        const later = parseLater(value)
        if (!later) drop(key, value)
        else {
          block.later = later
          fields += 1
        }
        break
      }
      case 'events': {
        const events = parseEvents(value)
        if (!events) drop(key, value)
        else if (events.length > 0) {
          block.events = events
          fields += 1
        }
        break
      }
      case 'spawn': {
        const spawn = parseSpawnList(value)
        if (!spawn) drop(key, value)
        else if (spawn.length > 0) {
          block.spawn = spawn
          fields += 1
        }
        break
      }
      case 'notes': {
        const notes = parseNotes(value)
        if (!notes) drop(key, value)
        else if (notes.length > 0) {
          block.notes = notes
          fields += 1
        }
        break
      }
      case 'verdict': {
        const verdict = parseVerdict(value)
        if (!verdict) drop(key, value)
        else {
          block.verdict = verdict
          fields += 1
        }
        break
      }
      case 'checks': {
        const checks = parseChecks(value)
        if (!checks) drop(key, value)
        // 空数组 = 没给证据：不当作有效键，但也不连累同块的 verdict
        else if (checks.length > 0) {
          block.checks = checks
          fields += 1
        }
        break
      }
      case 'findings': {
        const findings = parseFindings(value)
        if (!findings) drop(key, value)
        else if (findings.length > 0) {
          block.findings = findings
          fields += 1
        }
        break
      }
      case 'addresses': {
        const addresses = parseAddresses(value)
        if (!addresses) drop(key, value)
        else if (addresses.length > 0) {
          block.addresses = addresses
          fields += 1
        }
        break
      }
    }
  }

  return { block: fields > 0 ? block : null, dropped }
}

/**
 * 把回执块写进回执：只补十二个字段（fence 与 tool 共用，工具通道优先由调用方决定）。
 *
 * 不改 `output`、不改终态、不抛错。
 */
export function applyReceiptFields(receipt: Receipt, block: ReceiptBlock): void {
  if (block.ask !== undefined) receipt.ask = block.ask
  if (block.notices !== undefined) receipt.notices = block.notices
  if (block.resolves !== undefined) receipt.resolves = block.resolves
  if (block.later !== undefined) receipt.later = block.later
  if (block.events !== undefined) receipt.events = block.events
  if (block.spawn !== undefined) receipt.spawn = block.spawn
  if (block.notes !== undefined) receipt.notes = block.notes
  if (block.verdict !== undefined) receipt.verdict = block.verdict
  if (block.checks !== undefined) receipt.checks = block.checks
  if (block.findings !== undefined) receipt.findings = block.findings
  if (block.addresses !== undefined) receipt.addresses = block.addresses
}
