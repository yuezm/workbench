import { ipcMain, Notification } from 'electron'
import type { NotifyPayload } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'

export function registerIpcHandlers(): void {
  ipcMain.handle(NOTIFY_CHANNEL, (_event, payload: NotifyPayload) => {
    new Notification({ title: payload.title, body: payload.body }).show()
  })
}
