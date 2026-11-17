/**
 * Web 契约（服务端 ↔ 浏览器）：三动词 + 目录浏览 + 服务信息 + 推送。
 *
 * 取代原来的 Electron IPC（`protocol/ipc.ts` 里的通道名）：语义一模一样——
 * 写只走 dispatch、读只走 query、变更只走 subscribe，只是传输从 `ipcRenderer.invoke`
 * 换成了同源 HTTP，推送换成了 SSE。
 *
 * 为什么把契约放 `protocol`：服务端与 Web 客户端都要引用同一批类型，而 renderer 不能
 * import `src/server/**`（依赖方向单向）。协议层是两者唯一允许的共同上游。
 */
import type { Command } from './commands'
import type { CommandDispatchResult, IpcResponse, KernelEvent, NotifyTarget } from './ipc'
import type { LarkAdminAction, LarkAdminResult } from './ipc'
import type { ViewId, ViewParams, ViewResult } from './views'

/** 路由表：客户端与路由共用，避免魔法字符串漂移。 */
export const API_PATHS = {
  /** 存活探测：不鉴权（容器/K8s 探针与启动自检用） */
  health: '/api/health',
  /** 建立会话：`{token}` → HttpOnly cookie（浏览器拿不到 token 本身） */
  session: '/api/session',
  /** 服务信息：数据目录、默认工作目录、内核版本、在线客户端数 */
  info: '/api/info',
  dispatch: '/api/dispatch',
  query: '/api/query',
  lark: '/api/lark',
  notify: '/api/notify',
  /** 目录浏览：Web 端的「选择项目文件夹」用它（浏览器读不到本机文件系统） */
  dirs: '/api/fs/dirs',
  /** SSE 长连接：`KernelEvent` 批次 + `NoticeEvent` + `open-target` */
  events: '/api/events',
} as const

/** 目录项（只回目录，文件对项目选择没有意义） */
export interface DirEntryRow {
  name: string
  path: string
}

/** 一次目录浏览结果：`parent` 为 null 表示到根了 */
export interface DirListing {
  path: string
  parent: string | null
  /**
   * 可直接跳转的根：Windows 是各盘符（`C:\`、`D:\`…），POSIX 只有 `/`。
   *
   * 盘根处 `parent` 为 null，只靠「上一级」在同一盘内上下走，跨盘没有入口——
   * 主目录在 C: 的人就永远到不了 D:（选择器曾经的实际 bug）。
   */
  roots: string[]
  entries: DirEntryRow[]
}

/** 服务信息（设置页「服务」一栏与启动自检的读数） */
export interface ServerInfo {
  name: string
  version: string
  /** 内核版本（排查投影问题时第一眼要看的版本号） */
  kernelVersion: string
  /** 进程实际使用的数据目录（库、产物、插件、密钥都在这里） */
  dataDir: string
  /** 运行时表单里 workdir 留空时实际使用的目录 */
  defaultWorkdir: string
  /** 进程启动时刻（ISO） */
  startedAt: string
  /** 当前在线的事件流客户端数 */
  clients: number
  pid: number
}

/** 服务端主动推的知会（取代系统通知：浏览器里以轻提示 + 可点击落点呈现）。 */
export interface NoticeEvent {
  kind: 'notice'
  title: string
  body: string
  /** 点这条知会去哪儿（`appId` 由装配根补，与 `AppPlugin.id` 同名） */
  target?: NotifyTarget & { appId: string }
}

/** SSE 上推的所有消息：事实/聊天流（原有三动词语义）+ 知会 */
export type ServerEvent = KernelEvent | NoticeEvent

/** `POST /api/dispatch` 的请求体 */
export interface DispatchRequest {
  command: Command
}

/** `POST /api/dispatch` 的应答（与旧 IPC 信封同形，前端解包逻辑不用改） */
export type DispatchResponse<C extends Command = Command> = IpcResponse<CommandDispatchResult<C>>

/** `POST /api/query` 的请求体 */
export interface QueryRequest<T extends ViewId = ViewId> {
  view: T
  params?: ViewParams<T>
}

export type QueryResponse<T extends ViewId = ViewId> = IpcResponse<ViewResult<T>>

/** `POST /api/lark` 的请求体与应答（飞书连接管理，不写事实日志） */
export interface LarkRequest {
  action: LarkAdminAction
}

export type LarkResponse<A extends LarkAdminAction = LarkAdminAction> = IpcResponse<
  LarkAdminResult<A>
>

/** `POST /api/notify` 的请求体（宿主 outcome 通知等通用知会） */
export interface NotifyRequest {
  title: string
  body?: string
}

/** `POST /api/session` 的请求体 */
export interface SessionRequest {
  token: string
}

/** 请求体上限：命令/查询都是小对象，1 MiB 足够（超限直接 413）。 */
export const MAX_BODY_BYTES = 1024 * 1024
