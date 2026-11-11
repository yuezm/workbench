// @vitest-environment node
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * 托盘（`main/tray.ts`）：Windows 通知区域图标 + 右键菜单 + 点击唤回窗口。
 *
 * 断言只落在「交给 Electron 的形状」上（图标路径、@2x 表示、菜单模板、事件绑定），
 * 不真建托盘、不真弹菜单——真实感官行为以手动验收为准（见 docs/testing/TEST-CASES）。
 */
interface FakeImage {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  addRepresentation: (representation: unknown) => void
  toDataURL: () => string
}

interface FakeTray {
  icon: unknown
  tooltip: string | null
  menu: unknown
  handlers: Record<string, Array<() => void>>
}

interface FakeMenuItem {
  label?: string
  type?: string
  click?: () => void
}

const { createFromPathMock, imageByPath, trays, buildFromTemplateMock, appMock, TrayMock } =
  vi.hoisted(() => {
    const imageByPath = new Map<string, unknown>()
    const emptyImage = (): unknown => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      addRepresentation: () => undefined,
      toDataURL: () => '',
    })
    const createFromPathMock = vi.fn(
      (target: string): unknown => imageByPath.get(target) ?? emptyImage(),
    )
    const trays: FakeTray[] = []
    const buildFromTemplateMock = vi.fn((template: FakeMenuItem[]) => ({ template }))
    const appMock = { quit: vi.fn() }

    class TrayMock implements FakeTray {
      icon: unknown
      tooltip: string | null = null
      menu: unknown = null
      handlers: Record<string, Array<() => void>> = {}
      constructor(icon: unknown) {
        this.icon = icon
        trays.push(this)
      }
      setToolTip(text: string): void {
        this.tooltip = text
      }
      setContextMenu(menu: unknown): void {
        this.menu = menu
      }
      on(event: string, handler: () => void): void {
        this.handlers[event] = [...(this.handlers[event] ?? []), handler]
      }
    }

    return { createFromPathMock, imageByPath, trays, buildFromTemplateMock, appMock, TrayMock }
  })

vi.mock('electron', () => ({
  app: appMock,
  Menu: { buildFromTemplate: buildFromTemplateMock },
  nativeImage: { createFromPath: createFromPathMock },
  Tray: TrayMock,
}))

import { createTray } from '../../src/main/tray'

/** 造一张图标；`empty` 表示加载失败（Electron 的 `isEmpty()`）。 */
function image(over: { empty?: boolean; size?: number; dataUrl?: string } = {}): FakeImage {
  const size = over.size ?? 16
  return {
    isEmpty: () => over.empty === true,
    getSize: () => ({ width: size, height: size }),
    addRepresentation: vi.fn(),
    toDataURL: () => over.dataUrl ?? `data:image/png;base64,${'x'.repeat(4)}`,
  }
}

describe('main/tray：托盘图标与菜单', () => {
  const iconDir = path.join('C:', 'app', 'resources', 'icons')
  const base = path.join(iconDir, 'tray.png')
  const retina = path.join(iconDir, 'tray@2x.png')

  it('1x 基底 + @2x 高清图：高清图注册成 scaleFactor 2 的表示', () => {
    imageByPath.clear()
    const baseImage = image({ size: 16 })
    const retinaImage = image({ size: 32, dataUrl: 'data:image/png;base64,retina' })
    imageByPath.set(base, baseImage)
    imageByPath.set(retina, retinaImage)

    createTray(iconDir, () => undefined)

    expect(createFromPathMock).toHaveBeenCalledWith(base)
    expect(createFromPathMock).toHaveBeenCalledWith(retina)
    expect(baseImage.addRepresentation).toHaveBeenCalledWith({
      scaleFactor: 2,
      width: 32,
      height: 32,
      dataURL: 'data:image/png;base64,retina',
    })
    expect(trays[trays.length - 1]?.icon).toBe(baseImage)
  })

  it('没有 @2x 图：只用 1x 基底，不注册额外表示', () => {
    imageByPath.clear()
    const baseImage = image({ size: 16 })
    const missing = image({ empty: true })
    imageByPath.set(base, baseImage)
    imageByPath.set(retina, missing)

    createTray(iconDir, () => undefined)

    expect(missing.addRepresentation).not.toHaveBeenCalled()
    expect(trays[trays.length - 1]?.icon).toBe(baseImage)
  })

  it('图标文件都加载失败：打一条警告，托盘照常建起来（不阻断启动）', () => {
    imageByPath.clear()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      createTray(iconDir, () => undefined)
      expect(warn).toHaveBeenCalledWith(`[tray] 托盘图标加载失败: ${iconDir}`)
      expect(trays[trays.length - 1]?.tooltip).toBe('工作台')
    } finally {
      warn.mockRestore()
    }
  })

  it('菜单与点击：显示工作台 / 分隔线 / 退出，托盘 click 也唤回窗口', () => {
    imageByPath.clear()
    imageByPath.set(base, image())
    imageByPath.set(retina, image({ empty: true }))
    const onShow = vi.fn()

    createTray(iconDir, onShow)
    const tray = trays[trays.length - 1] as FakeTray
    const template = (buildFromTemplateMock.mock.calls[0]?.[0] ?? []) as FakeMenuItem[]

    expect(tray.tooltip).toBe('工作台')
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      '显示工作台',
      'separator',
      '退出',
    ])

    // 「显示工作台」与托盘点击都回到 onShow；「退出」走 app.quit
    template[0]?.click?.()
    expect(onShow).toHaveBeenCalledTimes(1)
    for (const handler of tray.handlers['click'] ?? []) handler()
    expect(onShow).toHaveBeenCalledTimes(2)
    template[2]?.click?.()
    expect(appMock.quit).toHaveBeenCalledTimes(1)
  })
})
