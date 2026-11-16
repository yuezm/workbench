/**
 * shell 提供给所有 app 的 Web API 契约（三动词 + 知会 + 目录浏览）。
 *
 * 浏览器里由 `src/renderer/src/shared/bridge.ts` 实现（HTTP + SSE），挂到 `window.workbench`；
 * app 用 `window.workbench` 或 `getWorkbench()` 拿它，禁止直接 `fetch('/api/...')`。
 *
 * 类型全部从 `src/protocol` 派生：命令、视图、推送事件只在这里收口一次。
 * 与旧 Electron 版的差别只有三处，都是「没有桌面就没有的东西」：
 * - `onOpenTarget`（系统通知被点击）→ `onNotice`（服务端推来的知会，页面自己弹出并落点）；
 * - `pickFolder`（原生对话框）→ `listDirs`（服务端列目录，页面画选择器）；
 * - 新增 `info`（设置页「服务」一栏要显示数据目录 / 版本 / 在线页面数）。
 */
import type { Command } from '../protocol/commands'
import type {
  CommandDispatchResult,
  KernelEvent,
  LarkAdminAction,
  LarkAdminResult,
} from '../protocol/ipc'
import type { DirListing, NoticeEvent, ServerInfo } from '../protocol/http'
import type { ViewId, ViewParams, ViewResult } from '../protocol/views'

/** 推送事件：事实批次 / 聊天流（知会走 `onNotice`，不从 `subscribe` 出去） */
export type WorkbenchEvent = KernelEvent

export interface WorkbenchApi {
  /** 唯一写入口：提交一条命令（带 `commandId` 幂等），返回本次事实与实体值 */
  dispatch<C extends Command>(command: C): Promise<CommandDispatchResult<C>>
  /** 唯一读入口：取一个视图切片（视图 id 与参数由 `protocol/views` 登记） */
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  /** 订阅事实批次与聊天流；返回取消订阅函数。同一页面只订阅一次 */
  subscribe(handler: (event: WorkbenchEvent) => void): () => void
  /** 知会（任务完成 / 运行失败 / 番茄钟到点）：页面自行弹轻提示，`target` 有值时跳落点 */
  onNotice(handler: (notice: NoticeEvent) => void): () => void
  /** 列表本机目录（项目 = 文件夹；浏览器读不到文件系统，只能问服务端） */
  listDirs(path?: string): Promise<DirListing>
  /** 服务信息：数据目录、版本、默认工作目录、在线页面数 */
  info(): Promise<ServerInfo>
  /** 飞书连接管理（M45）：探测本机 `lark-cli`、新建 profile、设备码登录 */
  lark<A extends LarkAdminAction>(action: A): Promise<LarkAdminResult<A>>
  /** shell 的通用知会（番茄钟等 app 用） */
  notify(title: string, body?: string): void
}
