import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { NotifyPayload, WorkbenchApi } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'
import type { Command } from '../protocol/commands'
import type { CommandDispatchResult, KernelEvent } from '../protocol/ipc'
import {
  WORKBENCH_DISPATCH_CHANNEL,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_QUERY_CHANNEL,
} from '../protocol/ipc'
import type { ViewId, ViewParams, ViewResult } from '../protocol/views'

/**
 * M5：renderer 只拿到三个动词 + 通知。
 * 写只走 dispatch、读只走 query、变更只走 subscribe；不暴露任何具名 RPC。
 */
const workbench: WorkbenchApi = {
  dispatch: <C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
    ipcRenderer.invoke(WORKBENCH_DISPATCH_CHANNEL, command) as Promise<CommandDispatchResult<C>>,
  query: <T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>> =>
    ipcRenderer.invoke(WORKBENCH_QUERY_CHANNEL, view, params) as Promise<ViewResult<T>>,
  subscribe: (handler) => {
    const listener = (_event: IpcRendererEvent, event: KernelEvent): void => handler(event)
    ipcRenderer.on(WORKBENCH_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.off(WORKBENCH_EVENT_CHANNEL, listener)
    }
  },
  notify: (title, body) => {
    const payload: NotifyPayload = { title, body }
    void ipcRenderer.invoke(NOTIFY_CHANNEL, payload)
  },
}

contextBridge.exposeInMainWorld('workbench', workbench)
