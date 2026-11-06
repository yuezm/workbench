// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeEntries } = vi.hoisted(() => ({
  fakeEntries: new Map<string, { mode: number; isFile: boolean; isDirectory: boolean }>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realStatSync = actual.statSync as unknown as (
    p: string,
    o?: unknown,
  ) => import('node:fs').Stats
  return {
    ...actual,
    default: actual,
    statSync: (p: string, o?: unknown): import('node:fs').Stats => {
      const fake = fakeEntries.get(p)
      if (fake) {
        return {
          isFile: () => fake.isFile,
          isDirectory: () => fake.isDirectory,
          mode: fake.mode,
        } as unknown as import('node:fs').Stats
      }
      return realStatSync(p, o)
    },
  }
})

const { needsShell, resolveExecutable, findInDirs, commonGlobalDirs, defaultScanDirs } =
  await import('../../src/host/executable')

let root: string

beforeEach(() => {
  fakeEntries.clear()
  root = mkdtempSync(path.join(tmpdir(), 'resolve-exe-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function dirWith(files: Record<string, string>): string {
  const dir = path.join(root, `d${Math.random().toString(36).slice(2, 10)}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content)
  return dir
}

function fakeEntry(
  filePath: string,
  entry: { mode: number; isFile: boolean; isDirectory: boolean },
): void {
  fakeEntries.set(filePath, entry)
}

describe('findInDirs', () => {
  it('Windows：按 .exe > .cmd > .bat > .ps1 优先级命中', () => {
    const dir = dirWith({ 'aider.bat': 'x', 'aider.cmd': 'x' })
    expect(findInDirs('aider', [dir], 'win32')).toBe(path.join(dir, 'aider.cmd'))
  })

  it('跳过空目录、不存在的目录与非文件', () => {
    const dir = dirWith({})
    fakeEntry(path.join(dir, 'crush.exe'), { mode: 0o755, isFile: false, isDirectory: true })
    expect(findInDirs('crush', ['', path.join(root, 'missing'), dir], 'win32')).toBeNull()
  })

  it('POSIX：要求可执行位', () => {
    const dir = dirWith({ opencode: 'x', qwen: 'x' })
    fakeEntry(path.join(dir, 'opencode'), { mode: 0o755, isFile: true, isDirectory: false })
    fakeEntry(path.join(dir, 'qwen'), { mode: 0o644, isFile: true, isDirectory: false })
    expect(findInDirs('opencode', [dir], 'linux')).toBe(path.join(dir, 'opencode'))
    expect(findInDirs('qwen', [dir], 'linux')).toBeNull()
  })
})

describe('resolveExecutable', () => {
  it('空命令报错', () => {
    expect(resolveExecutable('  ')).toEqual({ path: null, error: '命令为空' })
  })

  it('绝对路径存在即可解析', () => {
    expect(resolveExecutable(process.execPath).path).toBe(path.resolve(process.execPath))
  })

  it('绝对路径不存在不模糊回退', () => {
    const missing = path.join(root, 'nope', 'dsh')
    const resolved = resolveExecutable(missing)
    expect(resolved.path).toBeNull()
    expect(resolved.error).toContain('找不到可执行文件')
  })

  it('Windows 下无后缀路径会补 .cmd 等候选', () => {
    const dir = dirWith({ 'dsh.cmd': 'x' })
    const resolved = resolveExecutable(path.join(dir, 'dsh'), { platform: 'win32' })
    expect(resolved.path).toBe(path.join(dir, 'dsh.cmd'))
  })

  it('相对路径按 cwd 解析为绝对路径', () => {
    const dir = dirWith({ 'dsh.cmd': 'x' })
    const relative = path.relative(process.cwd(), path.join(dir, 'dsh.cmd'))
    const resolved = resolveExecutable(relative)
    expect(resolved.path).toBe(path.join(dir, 'dsh.cmd'))
  })

  it('POSIX 下带分隔符的路径不补 Windows 后缀：找不到直接报错', () => {
    const missing = path.join(root, 'nope', 'dsh')
    const resolved = resolveExecutable(missing, { platform: 'linux' })
    expect(resolved.path).toBeNull()
    expect(resolved.error).toBe(`找不到可执行文件：${path.resolve(missing)}`)
  })

  it('命令名在注入目录中命中', () => {
    const dir = dirWith({ 'dsh.cmd': 'x' })
    expect(resolveExecutable('dsh', { dirs: [dir], platform: 'win32' }).path).toBe(
      path.join(dir, 'dsh.cmd'),
    )
  })

  it('命令名找不到时报 PATH 错误', () => {
    const dir = dirWith({})
    const resolved = resolveExecutable('dsh-xyz', { dirs: [dir], platform: 'win32' })
    expect(resolved.path).toBeNull()
    expect(resolved.error).toContain('PATH')
  })
})

describe('needsShell', () => {
  it('Windows 的 .cmd/.bat 需要 shell，其余不需要', () => {
    expect(needsShell('C:/npm/dsh.cmd', 'win32')).toBe(true)
    expect(needsShell('C:/npm/dsh.BAT', 'win32')).toBe(true)
    expect(needsShell('C:/node/dsh.exe', 'win32')).toBe(false)
    expect(needsShell('/usr/bin/dsh', 'linux')).toBe(false)
  })
})

describe('扫描目录', () => {
  it('Windows 常见全局目录包含 APPDATA/npm 与 Program Files/nodejs', () => {
    const dirs = commonGlobalDirs('win32', {
      APPDATA: 'C:/AppData/Roaming',
      ProgramFiles: 'C:/Program Files',
    })
    expect(dirs).toContain(path.join('C:/AppData/Roaming', 'npm'))
    expect(dirs).toContain(path.join('C:/Program Files', 'nodejs'))
  })

  it('Windows 缺少 APPDATA/ProgramFiles 时用兜底路径不抛错', () => {
    expect(() => commonGlobalDirs('win32', {})).not.toThrow()
  })

  it('POSIX 常见全局目录包含 homebrew 与 ~/.local/bin', () => {
    const dirs = commonGlobalDirs('linux', {}, '/home/u')
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain(path.join('/home/u', '.local', 'bin'))
  })

  it('默认目录 = PATH 各段 + 全局目录', () => {
    const dirs = defaultScanDirs('win32', {
      PATH: ['C:/a', 'C:/b'].join(path.delimiter),
      APPDATA: 'C:/AppData/Roaming',
    })
    expect(dirs.slice(0, 2)).toEqual(['C:/a', 'C:/b'])
    expect(dirs.length).toBeGreaterThan(2)
  })

  it('PATH 缺失时仍返回全局目录', () => {
    const dirs = defaultScanDirs('linux', {})
    expect(dirs).toContain('/usr/local/bin')
  })
})
