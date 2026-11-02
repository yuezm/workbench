// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchApi } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'
import type { AiWorkflowApi } from '../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANGED, AI_WORKFLOW_CHANNEL } from '../shared/ai-workflow-api'

const { contextBridgeMock, ipcRendererMock } = vi.hoisted(() => ({
  contextBridgeMock: { exposeInMainWorld: vi.fn() },
  ipcRendererMock: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

vi.mock('electron', () => ({
  contextBridge: contextBridgeMock,
  ipcRenderer: ipcRendererMock,
}))

interface Exposed {
  workbench: WorkbenchApi
  aiWorkflow: AiWorkflowApi
}

async function loadExposed(): Promise<Exposed> {
  vi.resetModules()
  await import('./index')
  const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls
  const map: Record<string, unknown> = {}
  for (const [name, api] of calls) map[name as string] = api
  return map as unknown as Exposed
}

describe('preload 桥接契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('暴露 workbench 与 aiWorkflow 两个世界，且仅此两个', async () => {
    await loadExposed()
    const names = vi
      .mocked(contextBridge.exposeInMainWorld)
      .mock.calls.map((c) => c[0])
      .sort()
    expect(names).toEqual(['aiWorkflow', 'workbench'])
  })

  it('window.workbench 仍有且仅有 notify，并走 NOTIFY_CHANNEL', async () => {
    const { workbench } = await loadExposed()
    expect(Object.keys(workbench).sort()).toEqual(['notify'])
    workbench.notify('番茄时钟', '已进入短休息')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(NOTIFY_CHANNEL, {
      title: '番茄时钟',
      body: '已进入短休息',
    })
  })

  it('window.aiWorkflow 形状：五组方法 + onChanged', async () => {
    const { aiWorkflow } = await loadExposed()
    expect(Object.keys(aiWorkflow).sort()).toEqual([
      'agents',
      'onChanged',
      'runs',
      'runtimes',
      'tasks',
      'workflows',
    ])
  })

  it('方法经单一 RPC 通道转发 method + args', async () => {
    const { aiWorkflow } = await loadExposed()
    const input = { name: 'ds', command: 'dsh' }
    await aiWorkflow.runtimes.create(input)
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'runtimes.create', [input])

    await aiWorkflow.tasks.move('t1', 'approve')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'tasks.move', [
      't1',
      'approve',
    ])

    await aiWorkflow.runs.listByTask('t1')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'runs.listByTask', ['t1'])
  })

  it('onChanged 订阅 CHANGED 事件并返回可退订函数', async () => {
    const { aiWorkflow } = await loadExposed()
    const cb = vi.fn()
    const off = aiWorkflow.onChanged(cb)
    expect(ipcRenderer.on).toHaveBeenCalledWith(AI_WORKFLOW_CHANGED, expect.any(Function))
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as () => void
    listener()
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    expect(ipcRenderer.off).toHaveBeenCalledWith(AI_WORKFLOW_CHANGED, listener)
  })
})
