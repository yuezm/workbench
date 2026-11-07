/**
 * ACP `session/update` 通知 → 运行事件映射，以及终态/用量归一（hermes 专属）。
 *
 * 协议词表（`sessionUpdate` 取值、`content.type`、`toolCall.status`）以本机
 * `acp/schema.py` 为准；未知取值一律忽略（协议升级兼容）。通用切行/解析在
 * `plugins/shared/jsonl.ts`。
 */
import type { PermissionMode, RunEvent, RunUsage } from '../../../protocol/entities'
import type { NormalizedRunStatus } from '../../shared/status'
import { isRecord } from './acp'

/** 一个 run 的累计状态（通知流式写入，收尾时归一成回执） */
export interface HermesRunState {
  /** 本轮会话 id；通知里的 `sessionId` 必须与它一致才处理 */
  sessionId: string | null
  /** agent_message_chunk 累计的最终文本（回执 output） */
  text: string
  usage: RunUsage
  /** 已发过终态 tool_result 的调用键（同一 toolCallId 多次 update 只发一次） */
  toolResults: Set<string>
  /** `session/prompt` 的终态（拿到它才算有终态结果） */
  result: { stopReason: string } | null
  /** 续接的会话已失效（宿主据此换新会话重试一次） */
  resumeRejected: boolean
}

/** `result.usage`（ACP `Usage`）里本仓库关心的四个计数 */
export interface AcpPromptUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * `stopReason` → 执行器内部终态。
 *
 * - `end_turn` / `max_tokens` / `max_turn_requests`：正常收尾（后两个是截断，终态仍算成功）；
 * - `refusal`：agent 拒答，按失败；
 * - `cancelled`：取消；
 * - 其它（未知取值）：失败（宁可报错也不把陌生终态当成功）。
 */
export function mapStopReason(stopReason: string): NormalizedRunStatus {
  switch (stopReason.trim()) {
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
      return 'succeeded'
    case 'cancelled':
      return 'cancelled'
    default:
      // refusal 与未知取值同归失败
      return 'failed'
  }
}

/** 成功但不是自然收尾时的说明文案（回执 error 字段只作备注，不改终态） */
export const STOP_REASON_NOTES: Record<string, string> = {
  max_tokens: '输出达到 token 上限被截断（stopReason=max_tokens）',
  max_turn_requests: '达到单轮请求上限（stopReason=max_turn_requests）',
}

/** 非负整数计数（脏数据一律归 0，不猜） */
const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/** 读 `session/prompt` 的 `result.usage`（ACP `Usage`：input/output/cachedRead/cachedWrite） */
export function readPromptUsage(value: unknown): AcpPromptUsage {
  const usage = isRecord(value) ? value : {}
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cachedReadTokens),
    cacheWriteTokens: tokenCount(usage.cachedWriteTokens),
  }
}

/**
 * 把 prompt 结果里的用量并入累计值。
 *
 * `usage_update` 的 `used` 是「当前上下文占用」的累计读数（gauge），已经先记进
 * `inputTokens`；这里的 input 是精确拆分，取较大值而不是再叠加，避免同一批 token 记两遍。
 */
export function applyPromptUsage(state: HermesRunState, value: unknown): void {
  const usage = readPromptUsage(value)
  state.usage.outputTokens += usage.outputTokens
  state.usage.cacheReadTokens += usage.cacheReadTokens
  state.usage.cacheWriteTokens += usage.cacheWriteTokens
  state.usage.inputTokens = Math.max(state.usage.inputTokens, usage.inputTokens)
}

/**
 * `usage_update` 并入用量。
 *
 * 按 schema，`UsageUpdate` 只有上下文窗口读数（`size` / `used`）与累计花费（`cost`），
 * 没有 input/output/cache 拆分：只把 `used`（当前上下文占用 tokens）当 input 的
 * 下界记进去，其余字段读不到就不写，不猜。
 */
export function applyUsageUpdate(state: HermesRunState, update: Record<string, unknown>): void {
  const used = tokenCount(update.used)
  if (used > state.usage.inputTokens) state.usage.inputTokens = used
}

/** 取 `content` 块里的文本（只认 `{type:'text',text}`；其它块类型不算输出） */
const contentText = (value: unknown): string => {
  if (!isRecord(value) || value.type !== 'text') return ''
  return typeof value.text === 'string' ? value.text : ''
}

/** 工具名：`title` 优先，兜底 `kind` */
const toolNameOf = (update: Record<string, unknown>): string => {
  const title = typeof update.title === 'string' ? update.title.trim() : ''
  if (title) return title
  return typeof update.kind === 'string' ? update.kind : ''
}

/** 任意结构化值文本化（字符串原样，其它 JSON 化；缺省为空串） */
export function jsonText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * 处理一条 `session/update` 通知的 `params`。
 *
 * 只翻译会进界面的增量：消息块 / 思考块 / 工具调用 / 工具终态 / 用量。
 * `plan`、`available_commands_update`、`current_mode_update`、`config_option_update`、
 * `user_message_chunk` 与未来新增的取值都不翻译。
 */
export function handleSessionUpdate(
  params: Record<string, unknown>,
  state: HermesRunState,
  emit: (event: Omit<RunEvent, 'seq'>) => void,
): void {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  // 不是本轮的会话更新：忽略（协议允许多会话并存）
  if (sessionId !== state.sessionId) return
  const update = isRecord(params.update) ? params.update : {}
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''

  switch (kind) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)
      if (!text) return
      state.text += text
      emit({ type: 'text', text })
      return
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)
      // 思考不进 output：只作过程展示
      if (text) emit({ type: 'thinking', text })
      return
    }
    case 'tool_call': {
      emit({
        type: 'tool_call',
        tool: toolNameOf(update),
        callId: typeof update.toolCallId === 'string' ? update.toolCallId : '',
        input: jsonText(update.rawInput),
      })
      return
    }
    case 'tool_call_update': {
      const status = typeof update.status === 'string' ? update.status : ''
      // 只有终态才发卡片；pending / in_progress 是中间态
      if (status !== 'completed' && status !== 'failed') return
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      const name = toolNameOf(update)
      // 同一调用可能多次 update：按调用键去重（缺 id 时用工具名兜底键）
      const key = callId || `tool:${name}`
      if (state.toolResults.has(key)) return
      state.toolResults.add(key)
      emit({
        type: 'tool_result',
        tool: name,
        callId,
        output: jsonText(update.rawOutput),
        isError: status === 'failed',
      })
      return
    }
    case 'usage_update':
      applyUsageUpdate(state, update)
      return
    default:
      return
  }
}

/** 一次审批请求的判定结果 */
export interface PermissionDecision {
  /** 回给对端的 `RequestPermissionResponse`（`{outcome:{...}}`，判别字段按 schema） */
  result: Record<string, unknown>
  /** 是否放行（供日志与事件用） */
  allowed: boolean
  /** 工具名（`toolCall.title` 优先，兜底 `kind`） */
  tool: string
  callId: string
  /** 选项展示名列表（进 tool_call 事件的 input，便于界面回看选了什么） */
  options: string[]
}

/**
 * 决定审批请求怎么回。
 *
 * 规则：选项里**第一个** `kind` 以 `allow` 开头的就选它（`allow_once` / `allow_always`）；
 * 没有 allow 选项，或运行时是 `read-only`（这类请求本不该出现），一律回拒绝。
 * 拒绝的准确形状按 `acp/schema.py`：`DeniedOutcome{outcome:"cancelled"}`，
 * 即 `{"outcome":{"outcome":"cancelled"}}`；放行是
 * `{"outcome":{"outcome":"selected","optionId":"..."}}`。
 */
export function decidePermission(
  params: Record<string, unknown>,
  permissionMode: PermissionMode,
): PermissionDecision {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
  const rawOptions = Array.isArray(params.options) ? params.options : []
  const names: string[] = []
  let allowOptionId: string | null = null

  for (const entry of rawOptions) {
    if (!isRecord(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name) names.push(name)
    const kind = typeof entry.kind === 'string' ? entry.kind : ''
    const optionId = typeof entry.optionId === 'string' ? entry.optionId : ''
    if (allowOptionId === null && optionId !== '' && kind.startsWith('allow')) {
      allowOptionId = optionId
    }
  }

  const allowed = permissionMode !== 'read-only' && allowOptionId !== null
  return {
    result: allowed
      ? { outcome: { outcome: 'selected', optionId: allowOptionId } }
      : { outcome: { outcome: 'cancelled' } },
    allowed,
    tool: toolNameOf(toolCall),
    callId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '',
    options: names,
  }
}
