/**
 * Windows shell 集成（main 层）：窗口图标与「系统通知归属」的快捷方式。
 *
 * 两个长期缺陷都出在这里，根因同一条——**Windows 只认「带 AppUserModelId 的开始菜单
 * 快捷方式」**：
 *
 * 1. 图标：`BrowserWindow` 不传 `icon` 时窗口 / 任务栏取进程 exe 的资源，打包后是
 *    `Workbench.exe` 的图标（正确），但开发态进程是 `electron.exe`，底部任务栏显示
 *    Electron 图标；装了安装版以后，同 AUMID 的旧开发态快捷方式还会把归属抢回去。
 * 2. 通知点击：Electron 第一次弹系统通知时会自己补一条快捷方式（名字取 exe 描述名，
 *    **不带启动参数**）。点通知 → Windows 按快捷方式拉起进程：开发态就是重新起一个裸
 *    `electron.exe`（Electron 默认 app 打印 `electron.exe path-to-app`），永远进不到
 *    已经跑着的那个窗口。
 *
 * 修法：启动时（以及第一次弹通知前）把归属入口修一遍——写我们自己的快捷方式（当前 exe +
 * 正确启动参数 + 我们的 AUMID + 我们的图标），并就地修正 / 清掉同 AUMID 的残留。
 * 之后点通知：Windows 拉起的是「本应用」而不是空 Electron，单实例锁把请求转给已运行的
 * 实例，`second-instance` 把窗口唤到前台。
 *
 * 边界：只动同 AUMID 的快捷方式（别人家的一个都不碰）；非 Windows 直接返回；任何一步
 * 失败只留一条 warn，不阻断启动。
 */
import { app, shell } from 'electron'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'

/** 与 `electron-builder.yml` 的 `appId` 同一个值：AUMID 必须与安装包一致 */
export const APP_USER_MODEL_ID = 'com.workbench.desktop'

/** 开始菜单快捷方式名：与 `nsis.shortcutName` 一致，避免出现两条同名入口 */
export const APP_SHORTCUT_NAME = '工作台'

/**
 * 窗口 / 任务栏图标：打包后随 extraResources 落在 `<resources>/icon.ico`，
 * 开发态读仓库里的 `resources/icon.ico`（Windows 用 ico，其它平台用 png）。
 */
export function windowIconPath(): string {
  const dir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
  return path.join(dir, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
}

/** 快捷方式要写的字段（Electron `ShortcutDetails` 的子集） */
export interface ShortcutDetails {
  target: string
  args: string
  cwd: string
  description: string
  appUserModelId: string
  icon?: string
  iconIndex?: number
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 同一路径判定：Windows 路径大小写不敏感 */
const samePath = (left: string, right: string): boolean =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()

/** 快捷方式内容是否已经是「我们要的那份」 */
export function sameShortcut(current: Partial<ShortcutDetails>, next: ShortcutDetails): boolean {
  return (
    typeof current.target === 'string' &&
    samePath(current.target, next.target) &&
    (current.args ?? '') === next.args &&
    (current.icon ?? '') === (next.icon ?? '') &&
    current.appUserModelId === next.appUserModelId
  )
}

/** 目录下的 `.lnk`；读不到目录按空处理（首次启动 / 受限环境不该阻断装配） */
function shortcutFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.lnk'))
      .map((name) => path.join(dir, name))
  } catch {
    // 目录读不到：当作没有快捷方式，装配继续
    return []
  }
}

/** 读快捷方式；坏链接（第三方工具写坏 / 权限不足）返回 null，跳过即可 */
function readShortcut(file: string): Partial<ShortcutDetails> | null {
  try {
    return shell.readShortcutLink(file) as Partial<ShortcutDetails>
  } catch {
    // 坏链接（第三方工具写坏 / 权限不足）：跳过
    return null
  }
}

/** 写快捷方式：失败只留 warn（不影响通知本身照常弹） */
function writeShortcut(file: string, details: ShortcutDetails, mode: 'create' | 'update'): void {
  try {
    if (!shell.writeShortcutLink(file, mode, details)) {
      console.warn(`[shell] 快捷方式写入被拒：${file}`)
    }
  } catch (error) {
    console.warn(`[shell] 快捷方式写入失败：${file}（${errorText(error)}）`)
  }
}

/**
 * 修复通知归属（幂等）：Windows 才有意义。
 *
 * `programsDir` 只给用例注入临时目录用，生产走 `%APPDATA%\Microsoft\Windows\Start Menu\Programs`。
 */
export function ensureNotificationShortcut(programsDir?: string): void {
  if (process.platform !== 'win32') return

  const dir =
    programsDir ??
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const icon = windowIconPath()
  const next: ShortcutDetails = {
    target: process.execPath,
    // 开发态必须带上 app 目录：不带就只会拉起一个空的 Electron（默认 app 打印
    // `electron.exe path-to-app`）。打包态 exe 自带入口，不需要参数。
    args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
    cwd: path.dirname(process.execPath),
    description: APP_SHORTCUT_NAME,
    appUserModelId: APP_USER_MODEL_ID,
    ...(existsSync(icon) ? { icon, iconIndex: 0 } : {}),
  }
  const own = path.join(dir, `${APP_SHORTCUT_NAME}.lnk`)

  for (const file of shortcutFiles(dir)) {
    if (samePath(file, own)) continue
    const current = readShortcut(file)
    // 只处理同 AUMID 的：它们才是本应用的归属入口
    if (current === null || current.appUserModelId !== APP_USER_MODEL_ID) continue
    if (typeof current.target !== 'string' || !samePath(current.target, next.target)) {
      // 残留（例如装过安装版后开发态那条 Electron.lnk）：任务栏图标与点通知都跟着它错
      removeShortcut(file)
      continue
    }
    if (sameShortcut(current, next)) continue
    writeShortcut(file, next, 'update')
  }

  const currentOwn = readShortcut(own)
  if (currentOwn === null || !sameShortcut(currentOwn, next)) {
    writeShortcut(own, next, 'create')
  }
}

/** 删快捷方式；删不掉就留着，下次启动再试 */
function removeShortcut(file: string): void {
  try {
    unlinkSync(file)
  } catch (error) {
    console.warn(`[shell] 残留快捷方式删除失败：${file}（${errorText(error)}）`)
  }
}
