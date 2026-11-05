// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 系统通知原件（M4 T6）：`main/notify.ts` 只把 title/body 交给 Electron `Notification`，
 * 不拼命令/HTML、不写日志；平台不支持或构造/展示失败时返回 false 而不抛。
 *
 * Electron 用模块 mock（与 `tests/main/ipc.test.ts` 同一写法），断言只关心「参数原样传入」，
 * 不真弹系统通知。
 */
const { notificationMock, isSupportedMock, showMock } = vi.hoisted(() => {
  const show = vi.fn()
  const isSupported = vi.fn(() => true)
  // `new Notification(...)` 需要可构造：普通函数返回带 show 的最小对象
  const Notification = vi.fn(function mockNotification(_options: unknown) {
    return { show }
  })
  ;(Notification as unknown as { isSupported: typeof isSupported }).isSupported = isSupported
  return { notificationMock: Notification, isSupportedMock: isSupported, showMock: show }
})

vi.mock('electron', () => ({ Notification: notificationMock }))

import { notify } from '../../src/main/notify'

/** 构造时收到的 options（断言 title/body 原样传入）。 */
function constructedWith(): unknown {
  const calls = notificationMock.mock.calls
  expect(calls).toHaveLength(1)
  return calls[0][0]
}

describe('main/notify：系统通知原件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isSupportedMock.mockReturnValue(true)
  })

  it('平台支持时构造并展示通知，返回 true', () => {
    expect(notify('待审批', '任务已挂起，请选择选项')).toBe(true)

    expect(isSupportedMock).toHaveBeenCalledTimes(1)
    expect(constructedWith()).toEqual({ title: '待审批', body: '任务已挂起，请选择选项' })
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('title/body 只作参数：换行 / HTML / 命令片段原样传入，不转义不拼接', () => {
    const title = '<b>待审批</b>'
    const body = '任务已挂起\n1. 继续\n2. 停止; rm -rf /'

    expect(notify(title, body)).toBe(true)

    expect(constructedWith()).toEqual({ title, body })
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('平台不支持：返回 false，不构造也不展示', () => {
    isSupportedMock.mockReturnValue(false)

    expect(notify('标题', '正文')).toBe(false)
    expect(notificationMock).not.toHaveBeenCalled()
    expect(showMock).not.toHaveBeenCalled()
  })

  it('构造抛错：返回 false，不向上抛、不展示', () => {
    notificationMock.mockImplementationOnce(function throwingNotification() {
      throw new Error('通知构造失败')
    })

    expect(notify('标题', '正文')).toBe(false)
    expect(showMock).not.toHaveBeenCalled()
  })

  it('show 抛错：返回 false，不向上抛', () => {
    showMock.mockImplementationOnce(() => {
      throw new Error('通知展示失败')
    })

    expect(notify('标题', '正文')).toBe(false)
    expect(showMock).toHaveBeenCalledTimes(1)
  })

  it('通知文案不落日志（成功与失败都不写 console）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    notify('标题', '正文')
    isSupportedMock.mockReturnValue(false)
    notify('标题', '正文')

    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
