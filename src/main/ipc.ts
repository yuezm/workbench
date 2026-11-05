import { ipcMain, Notification } from 'electron'
import type { NotifyPayload } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'
import {
  WORKBENCH_DISPATCH_CHANNEL,
  WORKBENCH_QUERY_CHANNEL,
  type IpcResponse,
} from '../protocol/ipc'
import type { CommandRouter } from '../host/commands'
import { StoreError } from '../host/store/index'

export interface KernelIpcDeps {
  /** 三动词的宿主实现（命令路由 / 读视图） */
  router: CommandRouter
}

/** 统一应答信封：命令/查询的异常转成 `{code,message}`，不把栈序列化给 renderer。 */
async function wrap<T>(run: () => Promise<T> | T): Promise<IpcResponse<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    const code = error instanceof StoreError ? error.code : 'internal'
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code, message } }
  }
}

/**
 * 注册 IPC：系统通知 + 三动词（dispatch / query / subscribe）。
 * subscribe 是 main → renderer 的单向推送，不需要 handler；通道名见 `protocol/ipc`。
 */
export function registerIpcHandlers(deps: KernelIpcDeps): void {
  ipcMain.handle(NOTIFY_CHANNEL, (_event, payload: NotifyPayload) => {
    new Notification({ title: payload.title, body: payload.body }).show()
  })
  ipcMain.handle(WORKBENCH_DISPATCH_CHANNEL, (_event, command: unknown) =>
    wrap(() => deps.router.dispatch(command)),
  )
  ipcMain.handle(WORKBENCH_QUERY_CHANNEL, (_event, view: unknown, params?: unknown) =>
    wrap(() => deps.router.query(view, params)),
  )
}
