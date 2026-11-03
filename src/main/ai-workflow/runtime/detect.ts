import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { DetectedRuntime } from '../../../shared/ai-workflow-api'

/** 候选 agent CLI：命令名 → 展示名。顺序即输出顺序。 */
export const RUNTIME_CANDIDATES: ReadonlyArray<{ command: string; label: string }> = [
  { command: 'dsh', label: 'DeepSeek Harness' },
  { command: 'claude', label: 'Claude Code' },
  { command: 'codex', label: 'Codex CLI' },
  { command: 'gemini', label: 'Gemini CLI' },
  { command: 'opencode', label: 'OpenCode' },
  { command: 'aider', label: 'Aider' },
  { command: 'cursor-agent', label: 'Cursor Agent' },
  { command: 'qwen', label: 'Qwen Code' },
  { command: 'goose', label: 'Goose' },
  { command: 'crush', label: 'Crush' },
]

/** Windows 下可接受的命令文件后缀（npm 全局安装生成 .cmd shim） */
const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1'] as const

/** 常见全局安装目录（不存在则跳过） */
function commonGlobalDirs(platform: NodeJS.Platform): string[] {
  const home = homedir()
  if (platform === 'win32') {
    return [
      path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'local'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
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
function defaultScanDirs(platform: NodeJS.Platform): string[] {
  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.trim().length > 0)
  return [...fromPath, ...commonGlobalDirs(platform)]
}

/** 目录是否存在且可读 */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    // 目录不存在或不可访问：跳过
    return false
  }
}

/** POSIX：同名文件且具备可执行权限（stat.mode & 0o111） */
function posixExecutable(dir: string, command: string): string | null {
  const file = path.join(dir, command)
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return null
    if ((stat.mode & 0o111) === 0) return null
    return file
  } catch {
    return null
  }
}

/** Windows：存在 <cmd>.exe/.cmd/.bat/.ps1 任一即算已安装 */
function windowsExecutable(dir: string, command: string): string | null {
  for (const ext of WINDOWS_EXTENSIONS) {
    const file = path.join(dir, command + ext)
    try {
      if (statSync(file).isFile()) return file
    } catch {
      // 该后缀不存在：尝试下一个
    }
  }
  return null
}

/** 归一为绝对路径 */
function absolute(candidate: string): string {
  return path.resolve(candidate)
}

/**
 * 扫描本机已安装的 agent CLI。
 *
 * 纯同步、无副作用：不 spawn 进程、不读版本号。
 *
 * @param dirs 扫描目录；默认取 PATH + 常见全局目录（传入时以注入值为准）
 * @param platform 目标平台；默认取当前平台
 */
export function detectInstalledRuntimes(
  dirs?: string[],
  platform: NodeJS.Platform = process.platform,
): DetectedRuntime[] {
  const scanDirs = dirs ?? defaultScanDirs(platform)
  const existingDirs = scanDirs.filter((dir) => dir.trim().length > 0 && isDirectory(dir))
  const found = new Map<string, DetectedRuntime>()

  for (const { command, label } of RUNTIME_CANDIDATES) {
    for (const dir of existingDirs) {
      const hit =
        platform === 'win32' ? windowsExecutable(dir, command) : posixExecutable(dir, command)
      if (hit) {
        // 同一命令命中多个目录时，取 PATH 中靠前的那个
        found.set(command, { command, label, path: absolute(hit) })
        break
      }
    }
  }

  // 按候选清单顺序稳定输出
  return RUNTIME_CANDIDATES.filter((c) => found.has(c.command)).map(
    (c) => found.get(c.command) as DetectedRuntime,
  )
}
