// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Windows shell 集成（`main/shell-integration.ts`）：窗口图标路径 + 通知归属快捷方式的修复。
 *
 * 断言落在「交给 Electron 的形状」上：快捷方式写到哪、写什么字段、哪些残留被删。
 * 真实点击行为（点通知 → 窗口到前台）只能手动验收，见 docs/testing/TEST-CASES。
 */
const mocks = vi.hoisted(() => {
  /** 快捷方式内容：按 .lnk 绝对路径返回；`null` 表示这条读不出来（坏链接） */
  const links = new Map<string, Record<string, unknown> | null>()
  const written: Array<{ file: string; mode: string; details: Record<string, unknown> }> = []
  const appMock = {
    isPackaged: false,
    getAppPath: vi.fn((): string => 'C:/app'),
    getPath: (): string => 'C:/Users/me/AppData/Roaming',
  }
  /** nativeImage 桩：默认给一张「加载成功」的图，用例按需改成空图 / 抛错 */
  const image = { isEmpty: () => false }
  const createFromPathMock = vi.fn((): unknown => image)
  const readShortcutLink = vi.fn((file: string): Record<string, unknown> => {
    const value = links.get(path.resolve(file))
    if (value === undefined || value === null) throw new Error('bad shortcut')
    return value
  })
  const writeShortcutLink = vi.fn(
    (file: string, mode: string, details: Record<string, unknown>): boolean => {
      written.push({ file: path.resolve(file), mode, details })
      return true
    },
  )
  return { links, written, appMock, image, createFromPathMock, readShortcutLink, writeShortcutLink }
})

vi.mock('electron', () => ({
  app: mocks.appMock,
  nativeImage: { createFromPath: mocks.createFromPathMock },
  shell: {
    readShortcutLink: mocks.readShortcutLink,
    writeShortcutLink: mocks.writeShortcutLink,
  },
}))

import {
  APP_SHORTCUT_NAME,
  APP_USER_MODEL_ID,
  ensureNotificationShortcut,
  sameShortcut,
  windowIcon,
  windowIconPath,
} from '../../src/main/shell-integration'

/** 造一条本应用的快捷方式内容 */
function link(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: process.execPath,
    args: '',
    appUserModelId: APP_USER_MODEL_ID,
    ...over,
  }
}

/** 在临时「开始菜单」目录里放一批 .lnk（内容由 `links` 决定） */
function programsWith(names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-shortcuts-'))
  for (const name of names) writeFileSync(path.join(dir, name), '')
  return dir
}

describe('main/shell-integration：窗口图标路径', () => {
  const original = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
    mocks.appMock.isPackaged = false
    mocks.appMock.getAppPath.mockReturnValue('C:/app')
  })

  it('开发态读仓库里的 resources/（Windows 用 ico）', () => {
    expect(windowIconPath()).toBe(path.join('C:/app', 'resources', 'icon.ico'))
  })

  it('打包态读 process.resourcesPath；其它平台用 png', () => {
    mocks.appMock.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join('C:', 'Program Files', 'Workbench', 'resources'),
      configurable: true,
    })
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(windowIconPath()).toBe(
      path.join('C:', 'Program Files', 'Workbench', 'resources', 'icon.png'),
    )
  })

  it('windowIcon：读得到就给图', () => {
    expect(windowIcon()).toBe(mocks.image)
    expect(mocks.createFromPathMock).toHaveBeenCalledWith(
      path.join('C:/app', 'resources', 'icon.ico'),
    )
  })

  it('windowIcon：空图 / 读取抛错都返回 undefined（绝不给窗口一个空图 → 任务栏空白）', () => {
    mocks.createFromPathMock.mockReturnValueOnce({ isEmpty: () => true })
    expect(windowIcon()).toBeUndefined()

    mocks.createFromPathMock.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    expect(windowIcon()).toBeUndefined()
  })
})

describe('main/shell-integration：通知归属快捷方式', () => {
  const original = process.platform
  let dir: string | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.links.clear()
    mocks.written.length = 0
    mocks.appMock.isPackaged = false
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
    dir = null
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  })

  it('非 Windows 平台整体不动（macOS 通知归属走 bundle id）', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    dir = programsWith([])
    ensureNotificationShortcut(dir)
    expect(mocks.readShortcutLink).not.toHaveBeenCalled()
    expect(mocks.writeShortcutLink).not.toHaveBeenCalled()
  })

  it('开发态：写自己的快捷方式（当前 exe + app 目录参数 + 我们的 AUMID）', () => {
    dir = programsWith([])
    ensureNotificationShortcut(dir)

    const own = path.join(dir, `${APP_SHORTCUT_NAME}.lnk`)
    expect(mocks.written).toHaveLength(1)
    expect(mocks.written[0]).toMatchObject({
      file: own,
      mode: 'create',
      details: {
        target: process.execPath,
        args: `"C:/app"`,
        appUserModelId: APP_USER_MODEL_ID,
        description: APP_SHORTCUT_NAME,
        cwd: path.dirname(process.execPath),
      },
    })
    // 图标文件不存在（临时目录里没有 resources/）：不写图标字段，交给快捷方式取 target 的图标
    expect(mocks.written[0]?.details.icon).toBeUndefined()
  })

  it('图标文件存在：快捷方式带 icon 与 iconIndex 0', () => {
    const appDir = mkdtempSync(path.join(tmpdir(), 'wb-app-'))
    mkdirSync(path.join(appDir, 'resources'))
    writeFileSync(path.join(appDir, 'resources', 'icon.ico'), 'ico')
    mocks.appMock.getAppPath.mockReturnValue(appDir)
    dir = programsWith([])
    try {
      ensureNotificationShortcut(dir)
      expect(mocks.written[0]?.details).toMatchObject({
        icon: path.join(appDir, 'resources', 'icon.ico'),
        iconIndex: 0,
      })
    } finally {
      rmSync(appDir, { recursive: true, force: true })
      mocks.appMock.getAppPath.mockReturnValue('C:/app')
    }
  })

  it('打包态：不带启动参数，已有同内容快捷方式不重写（幂等）', () => {
    mocks.appMock.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', { value: 'C:/res', configurable: true })
    dir = programsWith([`${APP_SHORTCUT_NAME}.lnk`])
    mocks.links.set(
      path.resolve(path.join(dir, `${APP_SHORTCUT_NAME}.lnk`)),
      // 打包态的图标是 exe 自己（上一轮我们写进去的形态）
      link({ args: '', icon: process.execPath }),
    )
    ensureNotificationShortcut(dir)
    expect(mocks.written).toHaveLength(0)
  })

  it('同 AUMID 却指向别的 exe 的残留：删掉（任务栏图标与点通知都跟着它错）', () => {
    dir = programsWith(['Electron.lnk'])
    mocks.links.set(
      path.resolve(path.join(dir, 'Electron.lnk')),
      link({ target: 'C:/other/electron.exe', args: '' }),
    )

    ensureNotificationShortcut(dir)

    expect(existsSync(path.join(dir, 'Electron.lnk'))).toBe(false)
  })

  it('同 AUMID 的第二条（Electron 首次弹通知时自己补的那条）：删掉，一个 AUMID 只留一条入口', () => {
    dir = programsWith(['Workbench.lnk'])
    mocks.links.set(path.resolve(path.join(dir, 'Workbench.lnk')), link({ args: '' }))

    ensureNotificationShortcut(dir)

    expect(existsSync(path.join(dir, 'Workbench.lnk'))).toBe(false)
    expect(mocks.written.map((entry) => path.basename(entry.file))).toEqual([
      `${APP_SHORTCUT_NAME}.lnk`,
    ])
  })

  it('同 AUMID 且内容已一致的第二条：同样删掉（归属只由我们的入口承担）', () => {
    dir = programsWith(['Workbench.lnk'])
    mocks.links.set(path.resolve(path.join(dir, 'Workbench.lnk')), link({ args: `"C:/app"` }))

    ensureNotificationShortcut(dir)

    expect(existsSync(path.join(dir, 'Workbench.lnk'))).toBe(false)
    expect(mocks.written.map((entry) => path.basename(entry.file))).toEqual([
      `${APP_SHORTCUT_NAME}.lnk`,
    ])
  })

  it('打包态的图标指向 exe 自己（不走文件系统，装完挪目录也不会空白）', () => {
    mocks.appMock.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', { value: 'C:/res', configurable: true })
    dir = programsWith([])

    ensureNotificationShortcut(dir)

    expect(mocks.written[0]?.details).toMatchObject({
      target: process.execPath,
      args: '',
      icon: process.execPath,
      iconIndex: 0,
    })
  })

  it('别人的快捷方式（AUMID 不同）与坏链接都不碰', () => {
    dir = programsWith(['Other.lnk', 'Broken.lnk', 'Readme.txt'])
    mocks.links.set(
      path.resolve(path.join(dir, 'Other.lnk')),
      link({ appUserModelId: 'com.other.app' }),
    )
    mocks.links.set(path.resolve(path.join(dir, 'Broken.lnk')), null)

    ensureNotificationShortcut(dir)

    // 只写了我们自己的那条；别人的与坏链接一个字段都没改
    expect(mocks.written.map((entry) => path.basename(entry.file))).toEqual([
      `${APP_SHORTCUT_NAME}.lnk`,
    ])
    expect(existsSync(path.join(dir, 'Other.lnk'))).toBe(true)
    expect(existsSync(path.join(dir, 'Broken.lnk'))).toBe(true)
  })

  it('开始菜单目录读不到：按没有快捷方式处理，只写自己那条（不抛）', () => {
    const missing = path.join(tmpdir(), 'wb-shortcuts-missing', String(Date.now()))
    expect(() => ensureNotificationShortcut(missing)).not.toThrow()
    expect(mocks.written.map((entry) => path.basename(entry.file))).toEqual([
      `${APP_SHORTCUT_NAME}.lnk`,
    ])
  })

  it('写入被拒 / 抛错：只留 warn，不打断装配', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      dir = programsWith([])
      mocks.writeShortcutLink.mockReturnValueOnce(false)
      ensureNotificationShortcut(dir)
      expect(String(warn.mock.calls[0]?.[0])).toContain('快捷方式写入被拒')

      mocks.writeShortcutLink.mockImplementationOnce(() => {
        throw new Error('EACCES')
      })
      ensureNotificationShortcut(path.join(dir, 'nope'))
      expect(String(warn.mock.calls[1]?.[0])).toContain('EACCES')
    } finally {
      warn.mockRestore()
    }
  })

  it('残留删除失败：留一条 warn 而不是让启动失败', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // 目录占位：同名 .lnk 是目录时 unlinkSync 必然失败（真实环境里也有占住句柄的情况）
      dir = programsWith([])
      mkdirSync(path.join(dir, 'Electron.lnk'))
      mocks.links.set(path.resolve(path.join(dir, 'Electron.lnk')), link({ target: 'C:/x/e.exe' }))

      ensureNotificationShortcut(dir)

      expect(String(warn.mock.calls[0]?.[0])).toContain('残留快捷方式删除失败')
    } finally {
      warn.mockRestore()
    }
  })

  it('同 AUMID 且内容已一致（例如我们之前写过的那条）：不重复写', () => {
    dir = programsWith([])
    const own = path.resolve(path.join(dir, `${APP_SHORTCUT_NAME}.lnk`))
    // 先把我们的入口写成「已一致」的样子，再跑一遍：应当零写入
    mocks.links.set(own, link({ args: `"C:/app"` }))

    ensureNotificationShortcut(dir)

    expect(mocks.written).toHaveLength(0)
  })

  it('不传目录：走 %APPDATA%\\...\\Start Menu\\Programs', () => {
    ensureNotificationShortcut()
    expect(mocks.written.map((entry) => entry.file)).toEqual([
      path.resolve(
        'C:/Users/me/AppData/Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        APP_SHORTCUT_NAME + '.lnk',
      ),
    ])
  })

  it('写入抛非 Error（Electron 偶尔只给字符串）：文案用 String 兜底', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      dir = programsWith([])
      mocks.writeShortcutLink.mockImplementationOnce(() => {
        throw 'boom'
      })
      ensureNotificationShortcut(dir)
      expect(String(warn.mock.calls[0]?.[0])).toContain('boom')
    } finally {
      warn.mockRestore()
    }
  })

  it('sameShortcut：target / args / icon / AUMID 任一不同即视为要重写', () => {
    const next = {
      target: 'C:/app/workbench.exe',
      args: '',
      cwd: 'C:/app',
      description: APP_SHORTCUT_NAME,
      appUserModelId: APP_USER_MODEL_ID,
    }
    expect(sameShortcut({ ...next, target: 'c:/APP/Workbench.exe' }, next)).toBe(true)
    // args 缺失按空串比：视作一致
    expect(sameShortcut({ target: next.target, appUserModelId: next.appUserModelId }, next)).toBe(
      true,
    )
    expect(sameShortcut({ ...next, args: '--x' }, next)).toBe(false)
    expect(sameShortcut({ ...next, icon: 'C:/i.ico' }, next)).toBe(false)
    expect(sameShortcut({ ...next, appUserModelId: 'other' }, next)).toBe(false)
    expect(sameShortcut({ appUserModelId: APP_USER_MODEL_ID }, next)).toBe(false)
  })
})
