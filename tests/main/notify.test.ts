// @vitest-environment node
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * 系统通知原件（M4 T6；点击落点）：`main/notify.ts` 只把 title/body 交给 Electron `Notification`，
 * 不拼命令/HTML、不写日志；平台不支持或构造/展示失败时返回 false 而不抛。
 *
 * 带落点时它还负责一件主进程独有的事：接住通知的 `click`，把窗口唤到前台再把 `OpenTarget`
 * 推给渲染层（点击发生在系统通知中心，渲染层看不见）。
 *
 * Electron 用模块 mock（与 `tests/main/ipc.test.ts` 同一写法），断言只关心「通知参数原样传入」
 * 与「点击后的窗口动作 + 推送载荷」，不真弹系统通知、不真开窗口。
 */
interface FakeNotification {
  show: Mock<() => void>
  /** `on` 收到的处理器按事件名归档，用例直接触发 click / close */
  handlers: Record<string, Array<() => void>>
  on: (event: string, handler: () => void) => void
}

interface FakeWindow {
  isMinimized: Mock<() => boolean>
  restore: Mock<() => void>
  show: Mock<() => void>
  focus: Mock<() => void>
  webContents: { send: Mock<(...args: unknown[]) => void> }
}

const { notificationMock, isSupportedMock, showMock, browserWindowMock, instances, windows } =
  vi.hoisted(() => {
    const show = vi.fn()
    const isSupported = vi.fn(() => true)
    const instances: Array<{
      show: () => void
      handlers: Record<string, Array<() => void>>
      on: (event: string, handler: () => void) => void
    }> = []
    // `new Notification(...)` 需要可构造：普通函数返回带 show/on 的最小对象
    const Notification = vi.fn(function mockNotification(_options: unknown) {
      const handlers: Record<string, Array<() => void>> = {}
      const instance = {
        show,
        handlers,
        on: (event: string, handler: () => void) => {
          handlers[event] = [...(handlers[event] ?? []), handler]
        },
      }
      instances.push(instance)
      return instance
    })
    ;(Notification as unknown as { isSupported: typeof isSupported }).isSupported = isSupported
    const windows: Array<Record<string, never>> = []
    // 窗口入口只有 `getAllWindows`：返回什么（0 个 / 1 个 / 最小化）由用例决定
    const browserWindowMock = { getAllWindows: vi.fn(() => windows) }
    return {
      notificationMock: Notification,
      isSupportedMock: isSupported,
      showMock: show,
      browserWindowMock,
      instances,
      windows,
    }
  })

vi.mock('electron', () => ({
  Notification: notificationMock,
  BrowserWindow: browserWindowMock,
}))

import { notify } from '../../src/main/notify'

/** 构造时收到的 options（断言 title/body 原样传入）。 */
function constructedWith(): unknown {
  const calls = notificationMock.mock.calls
  expect(calls).toHaveLength(1)
  return calls[0][0]
}

/** 最近一次构造出来的通知实例（没有则用例本身写错了）。 */
function lastNotification(): FakeNotification {
  const instance = instances[instances.length - 1]
  if (instance === undefined) throw new Error('用例没有构造通知')
  return instance as FakeNotification
}

/** 触发某个事件的所有处理器（没挂监听时什么都不做，正好验证「不挂」）。 */
function fire(event: 'click' | 'close'): void {
  for (const handler of lastNotification().handlers[event] ?? []) handler()
}

/** 造一个可用窗口并登记到 `getAllWindows`。 */
function windowOf(over: { minimized?: boolean; sendThrows?: boolean } = {}): FakeWindow {
  const win: FakeWindow = {
    isMinimized: vi.fn(() => over.minimized === true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      send: vi.fn((..._args: unknown[]) => {
        if (over.sendThrows === true) throw new Error('窗口已销毁')
      }),
    },
  }
  windows.push(win as unknown as Record<string, never>)
  return win
}

describe('main/notify：系统通知原件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isSupportedMock.mockReturnValue(true)
    instances.length = 0
    windows.length = 0
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

describe('main/notify：点击落点', () => {
  const target = { appId: 'ai-workflow', cardId: 'card-1', taskId: 't-1' }

  beforeEach(() => {
    vi.clearAllMocks()
    isSupportedMock.mockReturnValue(true)
    instances.length = 0
    windows.length = 0
  })

  it('带落点：构造参数仍是 title/body，点击后窗口到前台并把落点原样推给渲染层', () => {
    const win = windowOf()

    expect(notify('待审批', '点开工作台查看并处理', target)).toBe(true)
    expect(constructedWith()).toEqual({ title: '待审批', body: '点开工作台查看并处理' })
    // 落点不进通知内容：标题与正文只来自卡片标题 + 固定指引
    expect(JSON.stringify(constructedWith())).not.toContain('appId')

    fire('click')

    expect(win.restore).not.toHaveBeenCalled()
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('workbench:open-target', target)
    // 载荷逐字相等：不重排、不补字段、不脱敏
    expect(win.webContents.send.mock.calls[0]?.[1]).toEqual(target)
  })

  it('窗口最小化：先 restore 再 show / focus（只 show 弹不回最小化窗口）', () => {
    const win = windowOf({ minimized: true })
    notify('待审批', '正文', target)

    fire('click')

    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.restore.mock.invocationCallOrder[0]).toBeLessThan(
      win.show.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('没有窗口：点击什么都不做，也不抛', () => {
    notify('待审批', '正文', target)

    expect(() => fire('click')).not.toThrow()
    expect(browserWindowMock.getAllWindows).toHaveBeenCalled()
  })

  it('窗口已失效（send 抛错）：点击不抛，通知不受影响', () => {
    const win = windowOf({ sendThrows: true })
    notify('待审批', '正文', target)

    expect(() => fire('click')).not.toThrow()
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('关闭事件：回收活引用，重复关闭不抛（Set 删除幂等）', () => {
    windowOf()
    notify('待审批', '正文', target)
    expect(lastNotification().handlers.close).toHaveLength(1)

    expect(() => fire('close')).not.toThrow()
    expect(() => fire('close')).not.toThrow()
  })

  it('无落点：不挂任何监听（点通知没有任何副作用）', () => {
    const win = windowOf()
    notify('番茄时钟', '已进入短休息')

    expect(lastNotification().handlers).toEqual({})
    expect(() => fire('click')).not.toThrow()
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
