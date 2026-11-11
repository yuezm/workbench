/**
 * shell 提供给所有 app 的跨进程 API 契约（M5：三动词 + 通知）。
 *
 * renderer 通过 `window.workbench` 调用，禁止直接 import electron / Node。
 * 类型全部从 `src/protocol` 派生：命令、视图、推送事件只在这里收口一次。
 */
import type { Command } from '../protocol/commands'
import type { CommandDispatchResult, KernelEvent, OpenTarget } from '../protocol/ipc'
import type { ViewId, ViewParams, ViewResult } from '../protocol/views'

export type { OpenTarget }

export interface WorkbenchApi {
  /** 唯一写入口：提交一条命令（带 `commandId` 幂等），返回本次事实与实体值 */
  dispatch<C extends Command>(command: C): Promise<CommandDispatchResult<C>>
  /** 唯一读入口：取一个视图切片（视图 id 与参数由 `protocol/views` 登记） */
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  /** 订阅事实批次与聊天流；返回取消订阅函数。同一窗口只订阅一次 */
  subscribe(handler: (event: KernelEvent) => void): () => void
  /**
   * 订阅「系统通知被点击」的落点（main → renderer 单向推送）；返回取消订阅函数。
   *
   * 系统通知弹在通知中心里，点击发生在渲染层之外：只有主进程能接住，接住后把窗口唤到前台
   * 再推一个 `OpenTarget` 过来。shell 据此切 app、进任务详情、定位那张卡。
   */
  onOpenTarget(handler: (target: OpenTarget) => void): () => void
  /**
   * 弹系统文件夹选择器（M10）：项目 = 本地文件夹，目录只能由宿主选。
   * 返回绝对路径；用户取消返回 null。
   */
  pickFolder(): Promise<string | null>
  /** shell 的通用系统通知（pomodoro 等 app 用） */
  notify(title: string, body?: string): void
}

/** IPC 通道名：preload 与 main 共用，避免魔法字符串漂移 */
export const NOTIFY_CHANNEL = 'workbench:notify'

/** notify 的 IPC 载荷 */
export interface NotifyPayload {
  title: string
  body?: string
}
