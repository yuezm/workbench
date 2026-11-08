import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { NotifyPayload } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'
import {
  WORKBENCH_DISPATCH_CHANNEL,
  WORKBENCH_PICK_FOLDER_CHANNEL,
  WORKBENCH_QUERY_CHANNEL,
  type IpcResponse,
} from '../protocol/ipc'
import type { CommandRouter } from '../host/commands'
import { StoreError } from '../host/store/index'
import { notify } from './notify'

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
 * 注册 IPC：系统通知 + 三动词（dispatch / query / subscribe）+ 文件夹选择器。
 * subscribe 是 main → renderer 的单向推送，不需要 handler；通道名见 `protocol/ipc`。
 */
export function registerIpcHandlers(deps: KernelIpcDeps): void {
  ipcMain.handle(NOTIFY_CHANNEL, (_event, payload: NotifyPayload) => {
    // 与插件通道共用同一个原件（`main/notify.ts`）：平台不支持 / 构造失败返回 false 而不抛，
    // 避免「窗口里的番茄钟通知在无通知服务的机器上把 IPC 打崩」。
    notify(payload.title, payload.body ?? '')
  })
  ipcMain.handle(WORKBENCH_DISPATCH_CHANNEL, (_event, command: unknown) =>
    wrap(() => deps.router.dispatch(command)),
  )
  ipcMain.handle(WORKBENCH_QUERY_CHANNEL, (_event, view: unknown, params?: unknown) =>
    wrap(() => deps.router.query(view, params)),
  )
  // M10：项目 = 本地文件夹，目录只能由宿主弹原生对话框选；取消返回 null（不是错误）。
  ipcMain.handle(WORKBENCH_PICK_FOLDER_CHANNEL, (event) =>
    wrap(async () => {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: '选择项目文件夹',
        buttonLabel: '选这个文件夹',
        properties: ['openDirectory', 'createDirectory'] as const,
      }
      const result =
        parent === null
          ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
          : await dialog.showOpenDialog(parent, {
              ...options,
              properties: [...options.properties],
            })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }),
  )
}
