/**
 * claude `--print --output-format stream-json` 帧类型与帧 → 运行事件映射（claude 专属）。
 *
 * 协议词表（帧 type/subtype、内容块、modelUsage）只在这里出现；通用切行/解析
 * 在 `plugins/shared/jsonl.ts`。实测事实：
 * - `system/init` 是就绪信号（带 `session_id`），`system/hook_started` 等是诊断帧；
 * - `assistant` / `user` 帧的正文是 `message.content` 内容块数组；
 * - `result` 是终态帧，`usage` 里的 input/output 实测常为 0，`modelUsage` 才准；
 * - 帧里没有版本字段（`v`），也没有 request_id，因此不做版本比对与请求过滤。
 */
import type { RunEvent, RunUsage } from '../../../protocol/entities'

/** assistant / user 帧里的内容块（只声明本插件读的字段） */
export interface ClaudeBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ClaudeBlock[]
  is_error?: boolean
}

/** `result.usage` 的四个计数（input/output 实测常为 0，只作 modelUsage 缺失时的兜底） */
export interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** `result.modelUsage` 的一项：按模型给出准确计数 */
export interface ClaudeModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

/** stream-json 一帧（只声明本插件读的字段，其余忽略） */
export interface ClaudeFrame {
  type?: string
  subtype?: string
  session_id?: string
  claude_code_version?: string
  is_error?: boolean
  result?: string
  message?: { content?: ClaudeBlock[]; usage?: ClaudeUsage } | null
  usage?: ClaudeUsage | null
  modelUsage?: Record<string, ClaudeModelUsage> | null
}

/** 一个 run 的累计状态（帧流式写入，收尾时归一成回执） */
export interface ClaudeRunState {
  /** 收到 `system/init` 才算就绪 */
  ready: boolean
  sessionId: string | null
  /** init 帧的 `claude_code_version`（只进诊断文案，不参与判定） */
  cliVersion: string | null
  /** assistant text 块的累计（result 帧没有 result 文本时兜底） */
  text: string
  usage: RunUsage
  /** tool_use id → 工具名：tool_result 帧只带 tool_use_id，用它回填名字 */
  toolNames: Record<string, string>
  result: {
    subtype: string | null
    isError: boolean
    output: string
    sessionId: string | null
  } | null
}

/** 空用量 */
export const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const num = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * 工具入参 → JSON 文本（缺省给空串，前端按「无参数」处理）。
 *
 * 导出到模块级：不可序列化的值（函数 / Symbol）这条兜底分支在正常运行时不可达，
 * 导出后由单测直接构造输入覆盖（逻辑与调用点均不变）。
 */
export const jsonText = (value: unknown): string =>
  value === undefined ? '' : (JSON.stringify(value) ?? '')

/**
 * 工具结果 content 兼容两种形态：纯字符串，或 `[{type:'text',text}]` 内容块数组。
 * 非文本块（图片等）只留 `[type]` 标记，避免把二进制塞进事件流。
 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    const record = block as ClaudeBlock
    if (typeof record.text === 'string') {
      parts.push(record.text)
      continue
    }
    if (typeof record.type === 'string') parts.push(`[${record.type}]`)
  }
  return parts.join('\n')
}

/** result 帧的用量：modelUsage 各项求和优先，缺失时回落到 usage 的四个计数 */
function resultUsage(frame: ClaudeFrame): RunUsage {
  const modelUsage = frame.modelUsage
  const entries = modelUsage ? Object.values(modelUsage) : []
  if (entries.length > 0) {
    const usage = emptyUsage()
    for (const entry of entries) {
      usage.inputTokens += num(entry.inputTokens)
      usage.outputTokens += num(entry.outputTokens)
      usage.cacheReadTokens += num(entry.cacheReadInputTokens)
      usage.cacheWriteTokens += num(entry.cacheCreationInputTokens)
    }
    return usage
  }
  return {
    inputTokens: num(frame.usage?.input_tokens),
    outputTokens: num(frame.usage?.output_tokens),
    cacheReadTokens: num(frame.usage?.cache_read_input_tokens),
    cacheWriteTokens: num(frame.usage?.cache_creation_input_tokens),
  }
}

const blocksOf = (frame: ClaudeFrame): ClaudeBlock[] =>
  Array.isArray(frame.message?.content) ? frame.message.content : []

/** assistant 帧的内容块：text 发文本并累计，thinking 发思考，tool_use 发工具调用 */
function handleAssistantBlock(
  block: ClaudeBlock,
  state: ClaudeRunState,
  emit: (event: Omit<RunEvent, 'seq'>) => void,
): void {
  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string' || block.text === '') return
      state.text += block.text
      emit({ type: 'text', text: block.text })
      return
    case 'thinking':
      if (typeof block.thinking !== 'string' || block.thinking === '') return
      emit({ type: 'thinking', text: block.thinking })
      return
    case 'tool_use': {
      const callId = block.id ?? ''
      const name = block.name ?? ''
      state.toolNames[callId] = name
      emit({ type: 'tool_call', tool: name, callId, input: jsonText(block.input) })
      return
    }
    default:
      return
  }
}

/** user 帧里的 tool_result 块：发工具结果事件（名字按 tool_use_id 回填） */
function handleToolResult(
  block: ClaudeBlock,
  state: ClaudeRunState,
  emit: (event: Omit<RunEvent, 'seq'>) => void,
): void {
  if (block.type !== 'tool_result') return
  const callId = block.tool_use_id ?? ''
  emit({
    type: 'tool_result',
    tool: state.toolNames[callId] ?? '',
    callId,
    output: contentText(block.content),
    isError: block.is_error === true,
  })
}

/** 处理单帧：只翻译已知类型，未知类型与非 JSON 行由调用方丢弃 */
export function handleFrame(
  frame: ClaudeFrame,
  state: ClaudeRunState,
  emit: (event: Omit<RunEvent, 'seq'>) => void,
): void {
  switch (frame.type) {
    case 'system':
      // subtype=init 是就绪信号；hook_started / hook_response 等诊断帧忽略
      if (frame.subtype !== 'init') return
      state.ready = true
      if (frame.session_id) state.sessionId = frame.session_id
      if (frame.claude_code_version) state.cliVersion = frame.claude_code_version
      emit({ type: 'status', status: 'running' })
      return
    case 'assistant':
      for (const block of blocksOf(frame)) handleAssistantBlock(block, state, emit)
      return
    case 'user':
      for (const block of blocksOf(frame)) handleToolResult(block, state, emit)
      return
    case 'result':
      state.usage = resultUsage(frame)
      state.result = {
        subtype: frame.subtype ?? null,
        isError: frame.is_error === true,
        output: frame.result ?? '',
        sessionId: frame.session_id ?? null,
      }
      return
    default:
      return
  }
}
