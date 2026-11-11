import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { NotifyPayload, WorkbenchApi } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'
import type { Command } from '../protocol/commands'
import type { CommandDispatchResult, IpcResponse, KernelEvent, OpenTarget } from '../protocol/ipc'
import {
  WORKBENCH_DISPATCH_CHANNEL,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_OPEN_TARGET_CHANNEL,
  WORKBENCH_PICK_FOLDER_CHANNEL,
  WORKBENCH_QUERY_CHANNEL,
} from '../protocol/ipc'
import type { ViewId, ViewParams, ViewResult } from '../protocol/views'

/** 解包 main 的应答信封：失败时抛带可读文案的 Error（renderer 现有 catch 直接展示）。 */
async function unwrap<T>(response: Promise<IpcResponse<T>>): Promise<T> {
  const result = await response
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

/**
 * M5：renderer 只拿到三个动词 + 通知。
 * 写只走 dispatch、读只走 query、变更只走 subscribe；不暴露任何具名 RPC。
 *
 * `onOpenTarget` 是 main → renderer 的单向推送（系统通知被点后我去哪儿），
 * 与 `subscribe` 同形：注册监听、返回退订函数，调用方拿不到 event 对象。
 */
const workbench: WorkbenchApi = {
  dispatch: <C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
    unwrap(ipcRenderer.invoke(WORKBENCH_DISPATCH_CHANNEL, command)) as Promise<
      CommandDispatchResult<C>
    >,
  query: <T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>> =>
    unwrap(ipcRenderer.invoke(WORKBENCH_QUERY_CHANNEL, view, params)) as Promise<ViewResult<T>>,
  subscribe: (handler) => {
    const listener = (_event: IpcRendererEvent, event: KernelEvent): void => handler(event)
    ipcRenderer.on(WORKBENCH_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.off(WORKBENCH_EVENT_CHANNEL, listener)
    }
  },
  /**
   * 系统通知被点击后主进程推来的落点。
   *
   * 只把载荷交给调用方，不引出 `IpcRendererEvent`：渲染层拿不到 `sender`，
   * 也就不会有人顺着它反向操作主进程。
   */
  onOpenTarget: (handler) => {
    const listener = (_event: IpcRendererEvent, target: OpenTarget): void => handler(target)
    ipcRenderer.on(WORKBENCH_OPEN_TARGET_CHANNEL, listener)
    return () => {
      ipcRenderer.off(WORKBENCH_OPEN_TARGET_CHANNEL, listener)
    }
  },
  pickFolder: (): Promise<string | null> =>
    unwrap(ipcRenderer.invoke(WORKBENCH_PICK_FOLDER_CHANNEL)) as Promise<string | null>,
  notify: (title, body) => {
    const payload: NotifyPayload = { title, body }
    void ipcRenderer.invoke(NOTIFY_CHANNEL, payload)
  },
}

contextBridge.exposeInMainWorld('workbench', workbench)
