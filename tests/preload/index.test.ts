// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contextBridge, ipcRenderer } from 'electron'
import { NOTIFY_CHANNEL, type WorkbenchApi } from '../../src/shared/workbench-api'
import {
  WORKBENCH_DISPATCH_CHANNEL,
  WORKBENCH_EVENT_CHANNEL,
  WORKBENCH_OPEN_TARGET_CHANNEL,
  WORKBENCH_PICK_FOLDER_CHANNEL,
  WORKBENCH_QUERY_CHANNEL,
} from '../../src/protocol/ipc'

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
}

async function loadExposed(): Promise<Exposed> {
  vi.resetModules()
  await import('../../src/preload/index')
  const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls
  const map: Record<string, unknown> = {}
  for (const [name, api] of calls) map[name as string] = api
  return map as unknown as Exposed
}

describe('preload 桥接契约（M5 三动词）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('只暴露 workbench 一个世界', async () => {
    await loadExposed()
    const names = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.map((call) => call[0])
    expect(names).toEqual(['workbench'])
  })

  it('workbench 形状 = dispatch / query / subscribe / onOpenTarget / pickFolder / notify', async () => {
    const { workbench } = await loadExposed()
    expect(Object.keys(workbench).sort()).toEqual([
      'dispatch',
      'notify',
      'onOpenTarget',
      'pickFolder',
      'query',
      'subscribe',
    ])
  })

  it('dispatch：走固定通道并解包成功信封', async () => {
    const { workbench } = await loadExposed()
    ipcRendererMock.invoke.mockResolvedValueOnce({ ok: true, value: { facts: [], value: null } })
    const command = { commandId: 'c-1', type: 'task.complete', id: 't-1' } as const
    await expect(workbench.dispatch(command)).resolves.toEqual({ facts: [], value: null })
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(WORKBENCH_DISPATCH_CHANNEL, command)
  })

  it('dispatch：失败信封转成带文案的 Error（renderer catch 直接展示）', async () => {
    const { workbench } = await loadExposed()
    ipcRendererMock.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: '该对话正在执行中' },
    })
    await expect(
      workbench.dispatch({ commandId: 'c-1', type: 'task.complete', id: 't-1' }),
    ).rejects.toThrow('该对话正在执行中')
  })

  it('query：视图 id 与参数原样转发，并解包信封', async () => {
    const { workbench } = await loadExposed()
    ipcRendererMock.invoke.mockResolvedValueOnce({ ok: true, value: [{ id: 'wf-1' }] })
    await expect(workbench.query('workflows.all')).resolves.toEqual([{ id: 'wf-1' }])
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      WORKBENCH_QUERY_CHANNEL,
      'workflows.all',
      undefined,
    )

    ipcRendererMock.invoke.mockResolvedValueOnce({ ok: true, value: [] })
    await workbench.query('runs.byTask', { taskId: 't-1' })
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(WORKBENCH_QUERY_CHANNEL, 'runs.byTask', {
      taskId: 't-1',
    })
  })

  it('subscribe：订阅 kernel-event、透传事件体并可退订', async () => {
    const { workbench } = await loadExposed()
    const cb = vi.fn()
    const off = workbench.subscribe(cb)
    expect(ipcRenderer.on).toHaveBeenCalledWith(WORKBENCH_EVENT_CHANNEL, expect.any(Function))
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as (
      event: unknown,
      payload: { kind: 'facts'; seq: number; types: string[] },
    ) => void
    const payload = { kind: 'facts' as const, seq: 3, types: ['task.created'] }
    listener({}, payload)
    expect(cb).toHaveBeenCalledWith(payload)
    off()
    expect(ipcRenderer.off).toHaveBeenCalledWith(WORKBENCH_EVENT_CHANNEL, listener)
  })

  it('notify：仍走 NOTIFY_CHANNEL 发载荷', async () => {
    const { workbench } = await loadExposed()
    workbench.notify('番茄时钟', '已进入短休息')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(NOTIFY_CHANNEL, {
      title: '番茄时钟',
      body: '已进入短休息',
    })
  })

  it('onOpenTarget：订阅 open-target 通道，只把落点交给调用方（不引出 event），退订走 off', async () => {
    const { workbench } = await loadExposed()
    const cb = vi.fn()
    const off = workbench.onOpenTarget(cb)
    expect(ipcRenderer.on).toHaveBeenCalledWith(WORKBENCH_OPEN_TARGET_CHANNEL, expect.any(Function))

    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as (
      event: unknown,
      payload: { appId: string; cardId: string },
    ) => void
    const target = { appId: 'ai-workflow', cardId: 'card-1', taskId: 't-1' }
    // 事件对象不传出去：回调只收到落点本身
    listener({ sender: '不该外泄' }, target)
    expect(cb).toHaveBeenCalledWith(target)
    expect(cb.mock.calls[0]).toEqual([target])

    off()
    expect(ipcRenderer.off).toHaveBeenCalledWith(WORKBENCH_OPEN_TARGET_CHANNEL, listener)
  })

  it('onOpenTarget：连续点击逐个透传，退订后不再打扰', async () => {
    const { workbench } = await loadExposed()
    const cb = vi.fn()
    const off = workbench.onOpenTarget(cb)
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as (
      event: unknown,
      payload: { appId: string; taskId: string },
    ) => void

    listener({}, { appId: 'ai-workflow', taskId: 't-1' })
    listener({}, { appId: 'ai-workflow', taskId: 't-2' })
    expect(cb.mock.calls.map((call) => (call[0] as { taskId: string }).taskId)).toEqual([
      't-1',
      't-2',
    ])

    off()
    expect(ipcRenderer.off).toHaveBeenCalledTimes(1)
  })

  it('notify：body 缺省时透传 undefined，不改变标题', async () => {
    const { workbench } = await loadExposed()
    workbench.notify('仅标题')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(NOTIFY_CHANNEL, {
      title: '仅标题',
      body: undefined,
    })
  })

  it('subscribe：返回可调用退订函数；连续事件逐个透传', async () => {
    const { workbench } = await loadExposed()
    const cb = vi.fn()
    const off = workbench.subscribe(cb)
    expect(typeof off).toBe('function')
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1] as (
      event: unknown,
      payload: { kind: 'facts'; seq: number; types: string[] },
    ) => void
    listener({}, { kind: 'facts', seq: 1, types: ['task.created'] })
    listener({}, { kind: 'facts', seq: 2, types: ['task.moved'] })
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb.mock.calls[1][0]).toEqual({ kind: 'facts', seq: 2, types: ['task.moved'] })
  })

  it('dispatch/query：成功值原样解包，不包信封', async () => {
    const { workbench } = await loadExposed()
    ipcRendererMock.invoke.mockResolvedValueOnce({ ok: true, value: 'task-1' })
    await expect(
      workbench.dispatch({ commandId: 'c-1', type: 'task.complete', id: 't-1' }),
    ).resolves.toBe('task-1')
    ipcRendererMock.invoke.mockResolvedValueOnce({ ok: true, value: true })
    await expect(
      workbench.dispatch({ commandId: 'c-2', type: 'task.complete', id: 't-1' }),
    ).resolves.toBe(true)
  })

  it('query：失败信封抛 Error（只带 message，不带 code 字段）', async () => {
    const { workbench } = await loadExposed()
    ipcRendererMock.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_input', message: '未知视图: x' },
    })
    const error = await workbench.query('kernel.seq').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('未知视图: x')
    expect((error as { code?: string }).code).toBeUndefined()
  })
  it('pickFolder：走文件夹选择通道，解包成功信封（取消为 null）', async () => {
    const { workbench } = await loadExposed()
    ipcRendererMock.invoke.mockResolvedValueOnce({ ok: true, value: null })
    await expect(workbench.pickFolder()).resolves.toBeNull()
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(WORKBENCH_PICK_FOLDER_CHANNEL)

    ipcRendererMock.invoke.mockResolvedValueOnce({ ok: true, value: 'D:/work' })
    await expect(workbench.pickFolder()).resolves.toBe('D:/work')
  })

  it('pickFolder：失败信封同样抛带文案的 Error', async () => {
    const { workbench } = await loadExposed()
    ipcRendererMock.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: '对话框不可用' },
    })
    await expect(workbench.pickFolder()).rejects.toThrow('对话框不可用')
  })
})
