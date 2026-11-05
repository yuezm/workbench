// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
import { NOTIFY_CHANNEL } from '../../src/shared/workbench-api'
import type { AiWorkflowApi } from '../../src/shared/ai-workflow-api'
import {
  AI_WORKFLOW_CHANGED,
  AI_WORKFLOW_CHANNEL,
  AI_WORKFLOW_CHAT,
} from '../../src/shared/ai-workflow-api'

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
  await import('../../src/preload/index')
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

  it('window.aiWorkflow 形状：七组方法 + onChanged', async () => {
    const { aiWorkflow } = await loadExposed()
    expect(Object.keys(aiWorkflow).sort()).toEqual([
      'agents',
      'cards',
      'chat',
      'onChanged',
      'runs',
      'runtimes',
      'tasks',
      'workflows',
    ])
    expect(Object.keys(aiWorkflow.runtimes).sort()).toEqual([
      'create',
      'detect',
      'executors',
      'list',
      'models',
      'probe',
      'remove',
      'statuses',
      'update',
    ])
  })

  it('方法经单一 RPC 通道转发 method + args', async () => {
    const { aiWorkflow } = await loadExposed()
    const input = { name: 'ds', command: 'dsh' }
    await aiWorkflow.runtimes.create(input)
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'runtimes.create', [input])

    await aiWorkflow.tasks.moveToStage('t1', 's2')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'tasks.moveToStage', [
      't1',
      's2',
    ])

    await aiWorkflow.runs.listByTask('t1')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'runs.listByTask', ['t1'])
    await aiWorkflow.runs.events('run1')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'runs.events', ['run1'])

    await aiWorkflow.cards.open()
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'cards.open', [])
    await aiWorkflow.cards.answer('card1', 1)
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, 'cards.answer', [
      'card1',
      1,
    ])
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

  it('chat.onEvent 订阅 CHAT 事件、透传事件体并可退订', async () => {
    const { aiWorkflow } = await loadExposed()
    const cb = vi.fn()
    const off = aiWorkflow.chat.onEvent(cb)
    expect(ipcRenderer.on).toHaveBeenCalledWith(AI_WORKFLOW_CHAT, expect.any(Function))
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as (
      e: unknown,
      payload: { conversationId: string; type: 'event'; event: unknown },
    ) => void
    const payload = {
      conversationId: 'c1',
      type: 'event' as const,
      event: { seq: 1, type: 'text' },
    }
    listener({}, payload)
    expect(cb).toHaveBeenCalledWith(payload)
    off()
    expect(ipcRenderer.off).toHaveBeenCalledWith(AI_WORKFLOW_CHAT, listener)
  })

  it('覆盖其余全部方法：都走同一 RPC 通道', async () => {
    const { aiWorkflow } = await loadExposed()
    await aiWorkflow.runtimes.create({ name: 'ds', command: 'dsh' })
    await aiWorkflow.runtimes.list()
    await aiWorkflow.runtimes.update('r1', { name: 'x' })
    await aiWorkflow.runtimes.remove('r1')
    await aiWorkflow.runtimes.detect()
    await aiWorkflow.runtimes.executors()
    await aiWorkflow.runtimes.probe('r1')
    await aiWorkflow.runtimes.statuses()
    await aiWorkflow.runtimes.models('r1')
    await aiWorkflow.agents.list()
    await aiWorkflow.agents.create({ name: 'a', runtimeId: 'r1' })
    await aiWorkflow.agents.update('a1', { name: 'b' })
    await aiWorkflow.agents.remove('a1')
    await aiWorkflow.workflows.list()
    await aiWorkflow.workflows.create({ name: 'w', stages: [] })
    await aiWorkflow.workflows.update('w1', { name: 'w2', stages: [] })
    await aiWorkflow.workflows.remove('w1')
    await aiWorkflow.tasks.list('w1')
    await aiWorkflow.tasks.create({ title: 't', workflowId: 'w1', stageId: 's1' })
    await aiWorkflow.tasks.moveToStage('t1', 's1')
    await aiWorkflow.tasks.complete('t1')
    await aiWorkflow.tasks.remove('t1')
    await aiWorkflow.runs.listByTask('t1')
    await aiWorkflow.runs.events('run1')
    await aiWorkflow.cards.open()
    await aiWorkflow.cards.answer('card1', 0)
    await aiWorkflow.chat.listConversations()
    await aiWorkflow.chat.createConversation('a1')
    await aiWorkflow.chat.removeConversation('c1')
    await aiWorkflow.chat.listMessages('c1')
    await aiWorkflow.chat.send('c1', '你好')
    await aiWorkflow.chat.cancel('c1')
    const methods = vi.mocked(ipcRenderer.invoke).mock.calls.map((c) => c[1])
    expect(methods).toEqual(
      expect.arrayContaining([
        'runtimes.create',
        'runtimes.list',
        'runtimes.update',
        'runtimes.remove',
        'runtimes.detect',
        'runtimes.executors',
        'runtimes.probe',
        'runtimes.statuses',
        'runtimes.models',
        'runs.listByTask',
        'runs.events',
        'cards.open',
        'cards.answer',
        'agents.list',
        'agents.create',
        'agents.update',
        'agents.remove',
        'workflows.list',
        'workflows.create',
        'workflows.update',
        'workflows.remove',
        'tasks.list',
        'tasks.create',
        'tasks.moveToStage',
        'tasks.complete',
        'tasks.remove',
        'chat.listConversations',
        'chat.createConversation',
        'chat.removeConversation',
        'chat.listMessages',
        'chat.send',
        'chat.cancel',
      ]),
    )
  })
})
