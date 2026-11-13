/**
 * 回执的工具通道（M24）：把「回执」从文本约定升级成一次工具调用。
 *
 * 文本通道（`receipt-block.ts`）靠模型照文案写 JSON、执行器在输出里找最后一个围栏块；
 * 这条通道靠模型调用 `workbench.receipt` 工具，参数就是结构化回执。两者最终走同一份
 * 字段校验（`receipt-fields.ts` 的 `receiptFromObject`），差别只在「怎么拿到对象」：
 *
 * - 歧义更少：不再有「多个块取最后一块」的问题；
 * - 不会再被输出长度截断吃掉半块 JSON；
 * - 调用本身带 `call_id`，能和 `tool_result` 对上账（帧照常落 `run.frames`，审计面不丢）。
 *
 * 由谁提供这个工具：宿主注入一个只暴露单个工具的 stdio MCP server
 * （`receipt-mcp-server.cjs`）。工具在各协议层的公开名不同：
 * - ACP / MCP：`mcp__<server>__<tool>`（本仓 server 名 `workbench`、工具名 `receipt`）；
 * - dsh 执行器的 emit 侧由 CLI 自行决定，常见形态是 `<server>.<tool>`。
 * 两种都认，其余名字一律忽略——不能因为模型调了别的工具就把它的输出当回执。
 */
import type { ReceiptBlock } from './receipt-fields'
import { receiptFromObject } from './receipt-fields'
import { RECEIPT_KEYS, RECEIPT_KEY_DOCS } from '../../protocol/receipt-keys'

/** 注入给 CLI 的 MCP server 名（公开工具名的前缀） */
export const RECEIPT_TOOL_SERVER = 'workbench'
/** 工具原始名 */
export const RECEIPT_TOOL_NAME = 'receipt'

/**
 * 认得出的工具名。顺序即展示优先级；匹配是精确比较，不做模糊/后缀匹配
 * （`receipt` 这种裸名太容易撞上别的工具）。
 */
export const RECEIPT_TOOL_NAMES = [
  `${RECEIPT_TOOL_SERVER}.${RECEIPT_TOOL_NAME}`,
  `mcp__${RECEIPT_TOOL_SERVER}__${RECEIPT_TOOL_NAME}`,
] as const

/** 工具定义（MCP `tools/list` 的一条）：名字、说明、JSON Schema。 */
export interface ReceiptToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 每个键的 JSON Schema 片段（只给类型与一句话，细节留给人读的提示词）。 */
const SCHEMA_OF: Record<(typeof RECEIPT_KEYS)[number], Record<string, unknown>> = {
  ask: { type: 'array', items: { type: 'object' } },
  notices: { type: 'array', items: { type: 'string' } },
  resolves: { type: 'array', items: { type: 'string' } },
  later: { type: 'string' },
  events: { type: 'array', items: { type: 'object' } },
  spawn: { type: 'array', items: { type: 'object' } },
  notes: { type: 'array', items: { type: 'string' } },
  verdict: { type: 'string', enum: ['pass', 'fail'] },
  checks: { type: 'array', items: { type: 'object' } },
  deliverables: { type: 'object' },
  findings: { type: 'array', items: { type: 'object' } },
  addresses: { type: 'array', items: { type: 'object' } },
}

/**
 * 工具定义：schema 的键与 `RECEIPT_KEYS` 同源，描述取单键文案（不另写一份）。
 *
 * `additionalProperties: true` 是有意的：模型多写键不该让整次调用失败，
 * 校验层本来就会忽略未知键。
 */
export const receiptToolDefinition = (): ReceiptToolDefinition => ({
  name: RECEIPT_TOOL_NAME,
  description:
    '向工作台提交本轮回执：要人拍板（ask）、知会（notices）、闸门判定（verdict/checks，闸门阶段用它逐条覆盖验收）、评审清单（findings/addresses）等。与在回复末尾写 ```json 回执块等价；用哪个键写哪个。',
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: Object.fromEntries(
      RECEIPT_KEYS.map((key) => [
        key,
        { ...SCHEMA_OF[key], description: RECEIPT_KEY_DOCS[key].text },
      ]),
    ),
  },
})

/**
 * 工具调用 → 回执块。
 *
 * - 工具名不在 `RECEIPT_TOOL_NAMES` 里 → `null`（不猜、不认前缀）；
 * - 参数缺失 / 非 JSON / 非对象 / 任一字段校验不过 → `null`（整块忽略，交给文本通道兜底）。
 */
export function parseReceiptToolInput(
  name: string | undefined,
  input: string | undefined,
): ReceiptBlock | null {
  if (name === undefined || !(RECEIPT_TOOL_NAMES as readonly string[]).includes(name)) return null
  if (input === undefined || input.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return null
  }
  return receiptFromObject(parsed)
}
