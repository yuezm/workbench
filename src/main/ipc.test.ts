// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotifyPayload } from '../shared/workbench-api'
import { NOTIFY_CHANNEL } from '../shared/workbench-api'

const { ipcMainMock, notificationMock, showMock } = vi.hoisted(() => {
  const showMock = vi.fn()
  // 需可被 new：用普通函数而非箭头函数
  const notificationMock = vi.fn(function mockNotification() {
    return { show: showMock }
  })
  return { ipcMainMock: { handle: vi.fn() }, notificationMock, showMock }
})

vi.mock('electron', () => ({
  ipcMain: ipcMainMock,
  Notification: notificationMock,
}))

import { ipcMain } from 'electron'
import { registerIpcHandlers } from './ipc'

describe('main 进程通知契约（registerIpcHandlers）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerIpcHandlers()
  })

  /** 取走注册到 NOTIFY_CHANNEL 上的那个 handler */
  function handler(): (event: unknown, payload: NotifyPayload) => void {
    const calls = vi.mocked(ipcMain.handle).mock.calls
    expect(calls).toHaveLength(1)
    return calls[0][1] as (event: unknown, payload: NotifyPayload) => void
  }

  it('在 NOTIFY_CHANNEL 上注册 handler，不使用魔法字符串', () => {
    expect(ipcMain.handle).toHaveBeenCalledWith(NOTIFY_CHANNEL, expect.any(Function))
  })

  it('payload 完整透传给系统通知并展示', () => {
    handler()({}, { title: '番茄时钟', body: '已进入短休息（5 分钟）' })
    expect(notificationMock).toHaveBeenCalledWith({
      title: '番茄时钟',
      body: '已进入短休息（5 分钟）',
    })
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('body 缺省时透传 undefined，不抛错', () => {
    expect(() => handler()({}, { title: '仅标题' })).not.toThrow()
    expect(notificationMock).toHaveBeenCalledWith({ title: '仅标题', body: undefined })
  })
})
