/**
 * dsh `--stdio` JSONL 协议帧类型与帧 → 运行事件映射（dsh 专属）。
 *
 * 协议词表（帧 type、字段名、v=1、runtime='dsh'）只在这里出现；通用切行/解析
 * 在 `plugins/shared/jsonl.ts`。
 */
import type { RunEvent, RunUsage } from '../../../protocol/entities'
import { frameErrorText } from '../../shared/jsonl'
import { DSH_PROTOCOL_VERSION, DSH_RUNTIME_ID } from './constants'

export interface DshThinkingLevel {
  value?: unknown
}

export interface DshModelFrame {
  id?: unknown
  label?: unknown
  provider?: unknown
  default?: unknown
  thinking?: { supported_levels?: unknown; default_level?: unknown } | null
}

export interface DshFrame {
  v?: number
  type?: string
  runtime?: string
  protocol_version?: number
  plugin_version?: string
  request_id?: string
  session_id?: string
  content?: string
  call_id?: string
  name?: string
  arguments?: string
  output?: string
  is_error?: boolean
  provider?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  status?: string
  stop_reason?: string
  resume_rejected?: boolean
  error?: { code?: string; message?: string } | null
  code?: string
  message?: string
  models?: DshModelFrame[]
}

/** 一个 run 的累计状态（帧流式写入，收尾时归一成回执） */
export interface DshRunState {
  ready: boolean
  sessionId: string | null
  protocolError: string
  text: string
  usage: RunUsage
  result: {
    status: string | undefined
    output: string
    error: string
    sessionId: string | null
    resumeRejected: boolean
  } | null
}

/** 处理单帧：只翻译已知类型，未知类型忽略 */
export function handleFrame(
  frame: DshFrame,
  requestId: string,
  state: DshRunState,
  emit: (event: Omit<RunEvent, 'seq'>) => void,
): void {
  if (frame.v !== DSH_PROTOCOL_VERSION) {
    state.protocolError = `不支持的协议版本：${String(frame.v)}`
    return
  }
  if (frame.request_id && frame.request_id !== requestId) return

  switch (frame.type) {
    case 'ready':
      if (frame.runtime !== DSH_RUNTIME_ID) {
        state.protocolError = `协议运行时不是 dsh：${String(frame.runtime)}`
        return
      }
      state.ready = true
      return
    case 'session':
      state.sessionId = frame.session_id ?? null
      emit({ type: 'status', status: 'running' })
      return
    case 'text':
      if (frame.content) {
        state.text += frame.content
        emit({ type: 'text', text: frame.content })
      }
      return
    case 'thinking':
      if (frame.content) emit({ type: 'thinking', text: frame.content })
      return
    case 'tool_call':
      emit({
        type: 'tool_call',
        tool: frame.name ?? '',
        callId: frame.call_id ?? '',
        input: frame.arguments ?? '',
      })
      return
    case 'tool_result':
      emit({
        type: 'tool_result',
        tool: frame.name ?? '',
        callId: frame.call_id ?? '',
        output: frame.output ?? '',
        isError: frame.is_error === true,
      })
      return
    case 'usage':
      state.usage.inputTokens += frame.input_tokens ?? 0
      state.usage.outputTokens += frame.output_tokens ?? 0
      state.usage.cacheReadTokens += frame.cache_read_tokens ?? 0
      state.usage.cacheWriteTokens += frame.cache_write_tokens ?? 0
      return
    case 'protocol_error': {
      const parts = [frame.code, frame.message].filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      )
      if (parts.length > 0) state.protocolError = parts.join(': ')
      return
    }
    case 'result':
      state.result = {
        status: frame.status,
        output: frame.output ?? '',
        error: frameErrorText(frame),
        sessionId: frame.session_id ?? null,
        resumeRejected: frame.resume_rejected === true,
      }
      return
    default:
      return
  }
}
