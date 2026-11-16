/**
 * 浏览器桥接：把 Web API 契约（`shared/workbench-api.ts`）实现成 HTTP + SSE。
 *
 * 与旧 preload 桥接一一对应：
 * - `dispatch` / `query` / `lark` / `listDirs` / `info` → 同源 `fetch`，应答是 `IpcResponse` 信封；
 * - `subscribe` → 一条 `EventSource`（断线自动重连），事实批次与聊天流都从它进来；
 * - `onNotice` → 同一条 SSE 上的 `notice` 消息（服务端知会），页面自己弹轻提示；
 * - `notify` → 发完就忘：知会失败不该打断 app。
 *
 * 为什么不用 `window.workbench` 之外的入口：app 只认契约，传输细节（信封解包、SSE 解析、
 * 错误文案）全部收在这一个文件里；换传输时 app 一行不用改。
 */
import {
  API_PATHS,
  type DirListing,
  type LarkRequest,
  type NoticeEvent,
  type NotifyRequest,
  type QueryRequest,
  type ServerInfo,
  type SessionRequest,
} from '../../../protocol/http'
import type {
  CommandDispatchResult,
  IpcResponse,
  KernelEvent,
  LarkAdminAction,
  LarkAdminResult,
} from '../../../protocol/ipc'
import type { Command } from '../../../protocol/commands'
import type { ViewId, ViewParams, ViewResult } from '../../../protocol/views'
import type { WorkbenchApi } from '../../../shared/workbench-api'

/** `fetch` 的最小面（测试注入假实现，不需要真网络） */
export interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers?: Record<string, string>
    body?: string
    credentials?: 'same-origin' | 'include' | 'omit'
  },
) => Promise<FetchResponseLike>

/** `EventSource` 的最小面（只用到 `message` 与 `close`） */
export interface EventSourceLike {
  addEventListener(type: 'message', handler: (event: { data: string }) => void): void
  close(): void
  onerror: ((event: unknown) => void) | null
}

export interface BridgeOptions {
  /** 服务地址前缀；缺省空串（同源） */
  baseUrl?: string
  fetch?: FetchLike
  /** 注入 EventSource 实现（测试）；缺省用浏览器全局 */
  createEventSource?: (url: string) => EventSourceLike
}

/** 应答信封解包：失败抛出可读 Error（app 的 catch 直接展示文案，与旧 IPC 一致）。 */
async function unwrap<T>(response: Promise<FetchResponseLike>): Promise<T> {
  const result = await response
  let payload: unknown
  try {
    payload = await result.json()
  } catch {
    throw new Error(`服务返回了无法解析的响应（HTTP ${result.status}）`)
  }
  const envelope = payload as IpcResponse<T> | null
  if (envelope !== null && typeof envelope === 'object' && 'ok' in envelope) {
    if (envelope.ok) return envelope.value
    throw new Error(envelope.error.message)
  }
  throw new Error(`服务返回了意外响应（HTTP ${result.status}）`)
}

export function createWebBridge(options: BridgeOptions = {}): WorkbenchApi {
  const base = options.baseUrl ?? ''
  const doFetch: FetchLike =
    options.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>)

  const post = <T>(path: string, body: unknown): Promise<T> =>
    unwrap<T>(
      doFetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      }),
    )

  const get = <T>(path: string): Promise<T> =>
    unwrap<T>(doFetch(base + path, { method: 'GET', credentials: 'same-origin' }))

  const kernelHandlers = new Set<(event: KernelEvent) => void>()
  const noticeHandlers = new Set<(notice: NoticeEvent) => void>()
  let source: EventSourceLike | null = null

  /** 懒开 SSE：第一次有人订阅时才连（页面什么都没订阅就不该占一条长连接）。 */
  const ensureSource = (): void => {
    if (source !== null) return
    const factory =
      options.createEventSource ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike)
    source = factory(base + API_PATHS.events)
    source.addEventListener('message', (event) => {
      let parsed: KernelEvent | NoticeEvent
      try {
        parsed = JSON.parse(event.data) as KernelEvent | NoticeEvent
      } catch {
        return
      }
      if (parsed.kind === 'notice') {
        for (const handler of noticeHandlers) handler(parsed)
        return
      }
      for (const handler of kernelHandlers) handler(parsed)
    })
    // 断线由 EventSource 自己重连：这里只留一个空处理器，避免浏览器把错误打成未捕获异常
    source.onerror = () => undefined
  }

  return {
    dispatch: <C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      post<CommandDispatchResult<C>>(API_PATHS.dispatch, { command }),
    query: <T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>> => {
      const body: QueryRequest = { view, ...(params === undefined ? {} : { params }) }
      return post<ViewResult<T>>(API_PATHS.query, body)
    },
    subscribe: (handler) => {
      kernelHandlers.add(handler)
      ensureSource()
      return () => {
        kernelHandlers.delete(handler)
      }
    },
    onNotice: (handler) => {
      noticeHandlers.add(handler)
      ensureSource()
      return () => {
        noticeHandlers.delete(handler)
      }
    },
    listDirs: (path) =>
      get<DirListing>(
        path === undefined ? API_PATHS.dirs : `${API_PATHS.dirs}?path=${encodeURIComponent(path)}`,
      ),
    info: () => get<ServerInfo>(API_PATHS.info),
    lark: <A extends LarkAdminAction>(action: A): Promise<LarkAdminResult<A>> => {
      const body: LarkRequest = { action }
      return post<LarkAdminResult<A>>(API_PATHS.lark, body)
    },
    notify: (title, body) => {
      const payload: NotifyRequest = { title, ...(body === undefined ? {} : { body }) }
      // 发完就忘：知会失败不该让调用方（番茄钟）中断
      void post<unknown>(API_PATHS.notify, payload).catch(() => undefined)
    },
  }
}

/**
 * 建立会话（浏览器第一次打开页面时由入口调用）。
 *
 * 未配置 token 的服务端（仅回环）也走一次：让它回一个「不需要登录」的成功，入口据此
 * 不再弹登录框。返回 `true` 表示会话可用。
 */
export async function establishSession(
  token: string | null,
  options: BridgeOptions = {},
): Promise<boolean> {
  const base = options.baseUrl ?? ''
  const doFetch: FetchLike =
    options.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>)
  const body: SessionRequest = { token: token ?? '' }
  try {
    await unwrap<{ established: boolean }>(
      doFetch(base + API_PATHS.session, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      }),
    )
    return true
  } catch {
    return false
  }
}
