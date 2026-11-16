/**
 * 目录浏览（服务端）：Web 端「选择项目文件夹」的唯一实现。
 *
 * 桌面形态靠 `dialog.showOpenDialog` 弹系统对话框；浏览器读不到本机文件系统，所以由服务端
 * 列目录、前端画选择器。**只列目录不列文件**：项目 = 文件夹，列出文件只会让选择器变噪音。
 *
 * 边界与取舍：
 * - 只接受绝对路径；`~` 展开到用户主目录；空值落到主目录（选择器的起点）；
 * - 读不了的子项跳过（一个坏掉的软链不该让整个目录不可选）；
 * - 错误只回可读文案（`BrowseError`），不把 errno/栈丢给浏览器。
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { DirEntryRow, DirListing } from '../protocol/http'

/** 浏览失败（HTTP 层转 400，文案直接展示） */
export class BrowseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowseError'
  }
}

export interface BrowseDeps {
  home?: string
  /** 列目录（测试注入，避免依赖真实盘） */
  readdir?: (dir: string) => Array<{ name: string; isDirectory(): boolean }>
  /** 判断是否为目录（测试注入） */
  isDirectory?: (dir: string) => boolean
}

/** 展开 `~` / `~/x`；`~user` 不认（不是本机用户目录的语义）。 */
export function expandHome(raw: string, home: string): string {
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2))
  return raw
}

/**
 * 列出一层目录。
 *
 * `target` 缺省 = 主目录。返回的 `path` 是解析后的绝对路径（前端据此显示面包屑），
 * `parent` 到盘根时为 null。
 */
export function listDirectories(target: string | undefined, deps: BrowseDeps = {}): DirListing {
  const home = deps.home ?? homedir()
  const isDir = deps.isDirectory ?? ((dir: string) => statSync(dir).isDirectory())
  const readdir =
    deps.readdir ??
    ((dir: string) =>
      readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory(),
      })))

  const raw = (target ?? '').trim()
  const resolved = path.resolve(raw === '' ? home : expandHome(raw, home))

  const isResolvedDir = (): boolean => {
    try {
      return isDir(resolved)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new BrowseError(`目录不存在：${resolved}`)
      if (code === 'EACCES' || code === 'EPERM') throw new BrowseError(`没有权限读取：${resolved}`)
      throw new BrowseError(`无法读取目录：${resolved}`)
    }
  }
  if (!isResolvedDir()) throw new BrowseError(`不是目录：${resolved}`)

  let names: Array<{ name: string; isDirectory(): boolean }>
  try {
    names = readdir(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw new BrowseError(`没有权限读取：${resolved}`)
    throw new BrowseError(`无法读取目录：${resolved}`)
  }

  const entries: DirEntryRow[] = []
  for (const entry of names) {
    if (entry.name.startsWith('.')) continue
    const directory = ((): boolean => {
      try {
        return entry.isDirectory()
      } catch {
        // 坏软链 / 权限不足：跳过这一项，不让它毁掉整个目录
        return false
      }
    })()
    if (!directory) continue
    entries.push({ name: entry.name, path: path.join(resolved, entry.name) })
  }
  // 稳定排序：大小写不敏感，避免同一目录在两张表里顺序不同（e2e 会按位置点）
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'zh-CN'))

  const parent = path.dirname(resolved)
  return { path: resolved, parent: parent === resolved ? null : parent, entries }
}
