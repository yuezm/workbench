/**
 * 回执字段校验（M24 从 `receipt-block.ts` 抽出）：**fence 文本块与 tool 通道共用**。
 *
 * 两条传输只是「怎么拿到那个 JSON 对象」不同：
 * - 文本通道（`receipt-block.ts`）：从输出里切最后一个 ```json 围栏块；
 * - 工具通道（`receipt-tool.ts`）：从 `tool_call` 帧的 `arguments` 里拿。
 *
 * 拿到对象之后一律走 `receiptFromObject`——字段口径、上限、整块忽略的判据只有一份，
 * 不会出现「文本能过、工具过不了」这种双标准。
 *
 * 与 protocol 的分工（沿用 M4）：本文件是更严的前置过滤（空选项 `ask`、非 ISO `later`、
 * 重复小标的 `findings`、缺 `checkRef` 的 `fixed` …），宿主层 `protocol/validate` 只做
 * 形状兜底。上限常量共用，不在这里另定义一份。
 */
import type { GateCheck, GateVerdict } from '../../protocol/entities'
import { ACCEPTANCE_LIMITS, GATE_VERDICTS } from '../../protocol/entities'
import type { AcceptanceCheck, Ask, RawEvent, Receipt, SpawnTask } from '../../protocol/inputs'
import type { FindingAddress, ReviewFindingInput } from '../../protocol/review'
import { FINDING_DISPOSITIONS, REVIEW_LIMITS, REVIEW_SEVERITIES } from '../../protocol/review'
import { RECEIPT_KEYS } from '../../protocol/receipt-keys'
import { COMMAND_LIMITS } from '../../protocol/validate'
import { THREAD_LIMITS } from '../../protocol/thread'

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
  acceptance?: AcceptanceCheck[]
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

/** 验收自评（M21）：`no` 是 1 基序号，`met` 必须是布尔；越界序号由内核丢弃。 */
const parseAcceptance = (value: unknown): AcceptanceCheck[] | null => {
  if (!Array.isArray(value) || value.length > ACCEPTANCE_LIMITS.maxItems) return null
  for (const entry of value) {
    if (!isRecord(entry)) return null
    if (
      typeof entry.no !== 'number' ||
      !Number.isInteger(entry.no) ||
      entry.no < 1 ||
      entry.no > ACCEPTANCE_LIMITS.maxItems
    ) {
      return null
    }
    if (typeof entry.met !== 'boolean') return null
    if (!isOptionalText(entry.evidence, COMMAND_LIMITS.description)) return null
  }
  return value as AcceptanceCheck[]
}

/**
 * 回执对象 → 回执块（fence 与 tool 共用）。
 *
 * 十二键全无、或任一字段校验不过 → `null`（整块忽略，不做部分采纳）。
 * 空数组 / `null` 视为未提供（`checks: []` 不连累同块 `verdict`）。
 */
export function receiptFromObject(parsed: unknown): ReceiptBlock | null {
  if (!isRecord(parsed)) return null

  const block: ReceiptBlock = {}
  let fields = 0

  for (const key of RECEIPT_KEYS) {
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
      case 'spawn': {
        const spawn = parseSpawnList(value)
        if (!spawn) return null
        if (spawn.length > 0) {
          block.spawn = spawn
          fields += 1
        }
        break
      }
      case 'notes': {
        const notes = parseNotes(value)
        if (!notes) return null
        if (notes.length > 0) {
          block.notes = notes
          fields += 1
        }
        break
      }
      case 'verdict': {
        const verdict = parseVerdict(value)
        if (!verdict) return null
        block.verdict = verdict
        fields += 1
        break
      }
      case 'checks': {
        const checks = parseChecks(value)
        if (!checks) return null
        // 空数组 = 没给证据：不当作有效键，但也不连累同块的 verdict
        if (checks.length > 0) {
          block.checks = checks
          fields += 1
        }
        break
      }
      case 'findings': {
        const findings = parseFindings(value)
        if (!findings) return null
        if (findings.length > 0) {
          block.findings = findings
          fields += 1
        }
        break
      }
      case 'addresses': {
        const addresses = parseAddresses(value)
        if (!addresses) return null
        if (addresses.length > 0) {
          block.addresses = addresses
          fields += 1
        }
        break
      }
      case 'acceptance': {
        const acceptance = parseAcceptance(value)
        if (!acceptance) return null
        if (acceptance.length > 0) {
          block.acceptance = acceptance
          fields += 1
        }
        break
      }
    }
  }

  return fields > 0 ? block : null
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
  if (block.acceptance !== undefined) receipt.acceptance = block.acceptance
}
