// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchApi } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'

const { contextBridgeMock, ipcRendererMock } = vi.hoisted(() => ({
  contextBridgeMock: { exposeInMainWorld: vi.fn() },
  ipcRendererMock: { invoke: vi.fn() },
}))

vi.mock('electron', () => ({
  contextBridge: contextBridgeMock,
  ipcRenderer: ipcRendererMock,
}))

/** 加载被测模块，返回暴露到 window 的 API 对象 */
async function loadExposedApi(): Promise<WorkbenchApi> {
  vi.resetModules()
  await import('./index')
  const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls
  expect(calls).toHaveLength(1)
  const [name, api] = calls[0] as [string, WorkbenchApi]
  expect(name).toBe('workbench')
  return api
}

describe('preload 桥接契约（window.workbench）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('暴露的 API 形状与 WorkbenchApi 一致：有且仅有 notify', async () => {
    const api = await loadExposedApi()
    expect(Object.keys(api).sort()).toEqual(['notify'])
    expect(typeof api.notify).toBe('function')
  })

  it('notify 经由 NOTIFY_CHANNEL 调用并透传完整 payload', async () => {
    const api = await loadExposedApi()
    api.notify('番茄时钟', '已进入短休息（5 分钟）')
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1)
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(NOTIFY_CHANNEL, {
      title: '番茄时钟',
      body: '已进入短休息（5 分钟）',
    })
  })

  it('body 缺省时 payload.body 为 undefined，channel 不变', async () => {
    const api = await loadExposedApi()
    api.notify('仅标题')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(NOTIFY_CHANNEL, {
      title: '仅标题',
      body: undefined,
    })
  })
})
