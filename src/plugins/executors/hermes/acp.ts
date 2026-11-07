/**
 * ACP（Agent Client Protocol）JSON-RPC 2.0 客户端（hermes 专属最小实现）。
 *
 * ACP 是逐行 JSON 的 stdio 协议，规则只有三条：
 * - 带 `id` 且有 `result`/`error` = 我方请求的应答 → 派发给等待方；
 * - 带 `method` + `id` = **服务端 → 客户端请求**（目前只有 `session/request_permission`），
 *   必须回帧，否则对端会一直等（认不出的方法回 `-32601`）；
 * - 带 `method` 无 `id` = 通知（`session/update` 等），不占用请求表。
 *
 * 请求一律带超时：到期 reject，绝不让调用方悬挂。协议词表与判别字段以本机
 * `acp/schema.py` 为准（`DeniedOutcome.outcome="cancelled"`、
 * `SelectedPermissionOutcome.outcome="selected"` + `optionId`）。
 */
import { parseFrame } from '../../shared/jsonl'

/** 帧形状（请求 / 应答 / 服务端请求 / 通知共用；未列字段一律忽略） */
export interface AcpFrame {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown } | null
}

/** 请求失败：带上方法名、JSON-RPC 错误码与「本地超时」标记（调用方据此分档） */
export interface AcpRequestError extends Error {
  /** 出错的 JSON-RPC 方法（本地失败时同样记录，便于诊断） */
  method: string
  /** JSON-RPC 错误码；本地失败（超时 / 写不出 / 已终止）为 null */
  rpcCode: number | null
  /** 本地等待回帧超时（对端没回帧） */
  timedOut: boolean
}

/** 记录是否是普通对象（数组与 null 不算） */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requestError = (
  method: string,
  message: string,
  rpcCode: number | null,
  timedOut = false,
): AcpRequestError => Object.assign(new Error(message), { method, rpcCode, timedOut })

export interface AcpHandlers {
  /** 写一行 JSON 帧；子进程已退出返回 false */
  write: (frame: Record<string, unknown>) => boolean
  /** 服务端 → 客户端请求：返回要回的 `result`；返回 null 时回 `-32601` */
  onRequest?: (method: string, params: Record<string, unknown>) => Record<string, unknown> | null
  /** 通知（无 id）：`session/update` 等 */
  onNotify?: (method: string, params: Record<string, unknown>) => void
}

export interface AcpClient {
  /** 发请求并等应答；`timeoutMs` 到期 reject（不悬挂） */
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>
  /** 发通知（无 id，不期待应答） */
  notify(method: string, params: Record<string, unknown>): boolean
  /** 喂一行解析好的帧 */
  feed(frame: AcpFrame): void
  /** 终止：拒绝所有等待中的请求，之后的新请求立即失败（取消/超时/进程退出时调） */
  dispose(reason: string): void
}

/** JSON-RPC 方法名（与 `acp/meta.py` 的 AGENT_METHODS / CLIENT_METHODS 逐字一致） */
export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetModel: 'session/set_model',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
} as const

interface Pending {
  method: string
  resolve: (result: Record<string, unknown>) => void
  reject: (error: AcpRequestError) => void
  timer: ReturnType<typeof setTimeout>
}

/** 建一个最小 JSON-RPC 客户端；不引依赖、不做 IO（写帧由 `handlers.write` 提供） */
export function createAcpClient(handlers: AcpHandlers): AcpClient {
  const pending = new Map<number, Pending>()
  let nextId = 1
  let disposed: string | null = null

  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> => {
    if (disposed !== null) return Promise.reject(requestError(method, disposed, null))
    const id = nextId
    nextId += 1
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(requestError(method, `等待 ${method} 回帧超时（${timeoutMs}ms）`, null, true))
      }, timeoutMs)
      pending.set(id, { method, resolve, reject, timer })
      if (!handlers.write({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer)
        pending.delete(id)
        reject(requestError(method, `无法写入 ${method} 帧（子进程已退出）`, null))
      }
    })
  }

  const notify = (method: string, params: Record<string, unknown>): boolean =>
    handlers.write({ jsonrpc: '2.0', method, params })

  const feed = (frame: AcpFrame): void => {
    const id = frame.id
    const isResponse = 'result' in frame || 'error' in frame

    if (typeof id === 'number' && isResponse) {
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      clearTimeout(entry.timer)
      if (frame.error) {
        const code = typeof frame.error.code === 'number' ? frame.error.code : null
        const message = typeof frame.error.message === 'string' ? frame.error.message.trim() : ''
        const detail = message || 'JSON-RPC 错误'
        entry.reject(
          requestError(entry.method, code === null ? detail : `${code}: ${detail}`, code),
        )
        return
      }
      entry.resolve(isRecord(frame.result) ? frame.result : {})
      return
    }

    if (typeof frame.method !== 'string') return
    const params = isRecord(frame.params) ? frame.params : {}

    if (id === undefined || id === null) {
      handlers.onNotify?.(frame.method, params)
      return
    }

    // 服务端 → 客户端请求：认不出的方法也必须回帧（-32601），不能挂死对方
    const result = handlers.onRequest?.(frame.method, params) ?? null
    if (result === null) {
      handlers.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
      return
    }
    handlers.write({ jsonrpc: '2.0', id, result })
  }

  const dispose = (reason: string): void => {
    if (disposed === null) disposed = reason
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(requestError(entry.method, reason, null))
    }
  }

  return { request, notify, feed, dispose }
}

/** 喂一行原始文本（非 JSON / 非对象行按诊断文本丢弃） */
export function feedLine(client: AcpClient, line: string): void {
  const frame = parseFrame<AcpFrame>(line)
  if (frame) client.feed(frame)
}
