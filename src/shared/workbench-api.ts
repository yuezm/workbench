/**
 * shell 提供给所有 app 的跨进程 API 契约。
 * renderer 通过 window.workbench 调用，禁止直接 import electron。
 */
export interface WorkbenchApi {
  /** 发送一条系统通知 */
  notify(title: string, body?: string): void
}

/** IPC 通道名：preload 与 main 共用，避免魔法字符串漂移 */
export const NOTIFY_CHANNEL = 'workbench:notify'

/** notify 的 IPC 载荷 */
export interface NotifyPayload {
  title: string
  body?: string
}
