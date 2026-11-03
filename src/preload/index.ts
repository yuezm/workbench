import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchApi } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'
import type { AiWorkflowApi } from '../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANGED, AI_WORKFLOW_CHANNEL } from '../shared/ai-workflow-api'

const workbench: WorkbenchApi = {
  notify: (title, body) => {
    void ipcRenderer.invoke(NOTIFY_CHANNEL, { title, body })
  },
}

/** 统一 RPC：方法名 + 参数，主进程路由到具体 handler */
function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(AI_WORKFLOW_CHANNEL, method, args) as Promise<T>
}

const aiWorkflow: AiWorkflowApi = {
  runtimes: {
    list: () => invoke('runtimes.list'),
    create: (input) => invoke('runtimes.create', input),
    update: (id, patch) => invoke('runtimes.update', id, patch),
    remove: (id) => invoke('runtimes.remove', id),
    detect: () => invoke('runtimes.detect'),
  },
  agents: {
    list: () => invoke('agents.list'),
    create: (input) => invoke('agents.create', input),
    update: (id, patch) => invoke('agents.update', id, patch),
    remove: (id) => invoke('agents.remove', id),
  },
  workflows: {
    list: () => invoke('workflows.list'),
    create: (input) => invoke('workflows.create', input),
    update: (id, input) => invoke('workflows.update', id, input),
    remove: (id) => invoke('workflows.remove', id),
  },
  tasks: {
    list: (workflowId) => invoke('tasks.list', workflowId),
    create: (input) => invoke('tasks.create', input),
    moveToStage: (id, stageId) => invoke('tasks.moveToStage', id, stageId),
    complete: (id) => invoke('tasks.complete', id),
    remove: (id) => invoke('tasks.remove', id),
  },
  runs: {
    listByTask: (taskId) => invoke('runs.listByTask', taskId),
  },
  onChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(AI_WORKFLOW_CHANGED, listener)
    return () => {
      ipcRenderer.off(AI_WORKFLOW_CHANGED, listener)
    }
  },
}

contextBridge.exposeInMainWorld('workbench', workbench)
contextBridge.exposeInMainWorld('aiWorkflow', aiWorkflow)
