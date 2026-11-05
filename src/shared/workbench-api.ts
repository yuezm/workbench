/**
 * shell 提供给所有 app 的跨进程 API 契约（M5：三动词 + 通知）。
 *
 * renderer 通过 `window.workbench` 调用，禁止直接 import electron / Node。
 * 类型全部从 `src/protocol` 派生：命令、视图、推送事件只在这里收口一次。
 */
import type { Command } from '../protocol/commands'
import type { CommandDispatchResult, KernelEvent } from '../protocol/ipc'
import type { ViewId, ViewParams, ViewResult } from '../protocol/views'

export interface WorkbenchApi {
  /** 唯一写入口：提交一条命令（带 `commandId` 幂等），返回本次事实与实体值 */
  dispatch<C extends Command>(command: C): Promise<CommandDispatchResult<C>>
  /** 唯一读入口：取一个视图切片（视图 id 与参数由 `protocol/views` 登记） */
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  /** 订阅事实批次与聊天流；返回取消订阅函数。同一窗口只订阅一次 */
  subscribe(handler: (event: KernelEvent) => void): () => void
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
