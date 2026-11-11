/**
 * 回执块解析（M4，唯一口径见 SPEC-plugins「回执与执行约定」；M24 抽出字段校验）：
 *
 * 执行器的最终输出里可以带一个 ```json 围栏块，对象只要含
 * `ask / notices / resolves / later / events / spawn / notes / verdict / checks /
 * findings / addresses / acceptance` 任一键就算回执块，其余键忽略。
 * **只看最后一个 ```json 围栏块**：该块非法 JSON / 非对象 / 十二键全无 /
 * 字段校验不过 → 直接返回 null，不回退到更早的块（回退可能沿用上一轮或正文里的
 * 陈旧回执，宁可这次不产卡片）。解析不修改输出原文、不改终态、不抛错。
 *
 * 字段口径与 tool 通道（`receipt-tool.ts`）共用 `receipt-fields.ts` 的
 * `receiptFromObject` / `applyReceiptFields`——两条传输只有「怎么拿到那个 JSON
 * 对象」不同，校验不能有两套。
 *
 * 与 protocol 的分工是**两层校验**，不是等价的重复：
 * - 回执块层：更严的前置过滤——空选项 `ask`、非 ISO `later`、畸形块、
 *   重复小标的 `findings`、缺 `checkRef` 的 `fixed` 一律忽略，宁可这次不产卡片，
 *   也不把可疑回执送进内核；
 * - 宿主层（`protocol/validate` 的 `checkReceipt`）：形状兜底——只校验必填/类型/
 *   长度/枚举，保证任意来源的 `run.receipt` 输入不破坏事实 schema。
 * 两层判据并不相同（宿主层放行的空选项 ask / 非 ISO later 到不了内核），
 * 上限常量共用 `COMMAND_LIMITS` / `REVIEW_LIMITS` / `ACCEPTANCE_LIMITS`，本文件不另定义一份。
 */
import type { Receipt } from '../../protocol/inputs'
import { RECEIPT_KEYS } from '../../protocol/receipt-keys'
import type { ReceiptBlock } from './receipt-fields'
import { applyReceiptFields, receiptFromObject } from './receipt-fields'

export type { ReceiptBlock } from './receipt-fields'

/** 解析白名单：与提示词、协议校验同源（`protocol/receipt-keys` 的 `RECEIPT_KEYS`）。 */
export const RECEIPT_BLOCK_KEYS = RECEIPT_KEYS

/** 开围栏：```json（标签大小写不敏感）单独成行 */
const FENCE_OPEN_RE = /^```json\s*$/i
/** 闭围栏：``` 单独成行 */
const FENCE_CLOSE_RE = /^```\s*$/

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

/**
 * 解析执行器输出里的回执块。
 *
 * 只看最后一个 ```json 围栏块：没有块、非法 JSON、不是对象、十二键全无、
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
  return receiptFromObject(parsed)
}

/**
 * 把输出里的回执块写进回执：只补十二个字段，解析失败保持原样。
 *
 * 执行器接线只调这一处——不改 `output`、不改终态、不抛错。
 */
export function applyReceiptBlock(receipt: Receipt, output: string): void {
  const block = parseReceiptBlock(output)
  if (!block) return
  applyReceiptFields(receipt, block)
}
