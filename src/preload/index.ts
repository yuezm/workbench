import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchApi } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'

const workbench: WorkbenchApi = {
  notify: (title, body) => {
    void ipcRenderer.invoke(NOTIFY_CHANNEL, { title, body })
  },
}

contextBridge.exposeInMainWorld('workbench', workbench)
