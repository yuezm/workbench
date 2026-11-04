import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Windows 下可接受的命令文件后缀（npm 全局安装生成 .cmd shim） */
export const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1'] as const

/** 常见全局安装目录（不存在则跳过） */
export function commonGlobalDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'win32') {
    return [
      path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'local'),
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
    ]
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.claude', 'local'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
}

/** 默认扫描目录：PATH 各段 + 常见全局目录 */
export function defaultScanDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const fromPath = (env.PATH ?? '').split(path.delimiter).filter((entry) => entry.trim().length > 0)
  return [...fromPath, ...commonGlobalDirs(platform, env)]
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    // 目录不存在或不可访问：跳过
    return false
  }
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return false
    return platform === 'win32' || (stat.mode & 0o111) !== 0
  } catch {
    // 文件不存在：不算命中
    return false
  }
}

/**
 * 在给定目录里找命令对应的可执行文件。
 * Windows 命中 `<cmd>.exe|.cmd|.bat|.ps1` 任一；POSIX 要求可执行位。
 */
export function findInDirs(
  command: string,
  dirs: string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const dir of dirs) {
    if (!dir.trim() || !isDirectory(dir)) continue
    if (platform === 'win32') {
      for (const ext of WINDOWS_EXTENSIONS) {
        const file = path.join(dir, command + ext)
        if (isExecutableFile(file, platform)) return file
      }
    } else {
      const file = path.join(dir, command)
      if (isExecutableFile(file, platform)) return file
    }
  }
  return null
}

export interface ResolvedExecutable {
  /** 绝对路径；找不到为 null */
  path: string | null
  /** 解析失败原因；成功为 null */
  error: string | null
}

/**
 * 把命令解析成本机可执行文件的绝对路径。
 *
 * 命令名（如 `dsh`）扫 PATH + 常见全局目录；带路径分隔符的按路径处理，
 * 不做模糊回退（配置了不存在的路径就应明确失败）。
 */
export function resolveExecutable(
  command: string,
  options: {
    platform?: NodeJS.Platform
    dirs?: string[]
    env?: NodeJS.ProcessEnv
  } = {},
): ResolvedExecutable {
  const platform = options.platform ?? process.platform
  const trimmed = command.trim()
  if (!trimmed) return { path: null, error: '命令为空' }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const absolute = path.resolve(trimmed)
    if (isExecutableFile(absolute, platform)) return { path: absolute, error: null }
    if (platform === 'win32') {
      for (const ext of WINDOWS_EXTENSIONS) {
        const withExt = absolute + ext
        if (isExecutableFile(withExt, platform)) return { path: withExt, error: null }
      }
    }
    return { path: null, error: `找不到可执行文件：${absolute}` }
  }

  const dirs = options.dirs ?? defaultScanDirs(platform, options.env ?? process.env)
  const found = findInDirs(trimmed, dirs, platform)
  if (!found) return { path: null, error: `在 PATH 中找不到命令：${trimmed}` }
  return { path: path.resolve(found), error: null }
}

/** Windows 下 .cmd/.bat 需要经 shell 启动 */
export function needsShell(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const ext = path.extname(file).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}
