// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POSIX 可执行位在 Windows 上无法通过真实 fs 表达，
 * 因此只对 statSync 的 mode/isFile 做可控替换，其余走真实实现。
 */
const { fakeEntries } = vi.hoisted(() => ({
  fakeEntries: new Map<string, { mode: number; isFile: boolean }>(),
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
          isDirectory: () => false,
          mode: fake.mode,
        } as unknown as import('node:fs').Stats
      }
      return realStatSync(p, o)
    },
  }
})

const { detectInstalledRuntimes } = await import('./detect')

let root: string

beforeEach(() => {
  fakeEntries.clear()
  root = mkdtempSync(path.join(tmpdir(), 'detect-runtime-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 创建一个含指定文件的目录 */
function dirWith(files: Record<string, string>): string {
  const dir = path.join(root, `d${Math.random().toString(36).slice(2, 10)}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content)
  }
  return dir
}

/** 登记一个假的文件元数据（用于模拟 POSIX 权限位） */
function fakeFile(filePath: string, mode: number, isFile = true): void {
  fakeEntries.set(filePath, { mode, isFile })
}

describe('detectInstalledRuntimes', () => {
  it('Windows：命中 .cmd shim（npm 全局安装形态）', () => {
    const dir = dirWith({ 'dsh.cmd': '@echo off', 'claude.cmd': '@echo off' })
    const result = detectInstalledRuntimes([dir], 'win32')
    expect(result.map((r) => r.command)).toEqual(['dsh', 'claude'])
    expect(result[0].label).toBe('DeepSeek Harness')
    expect(result[1].label).toBe('Claude Code')
    expect(result[0].path).toBe(path.join(dir, 'dsh.cmd'))
    // 只有 dsh 有协议后端
    expect(result[0].supported).toBe(true)
    expect(result[1].supported).toBe(false)
  })

  it('Windows：.exe / .bat / .ps1 任一即算已安装', () => {
    const dir = dirWith({
      'codex.exe': 'x',
      'gemini.bat': 'x',
      'goose.ps1': 'x',
    })
    const result = detectInstalledRuntimes([dir], 'win32')
    expect(result.map((r) => r.command)).toEqual(['codex', 'gemini', 'goose'])
  })

  it('Windows：后缀优先级 .exe > .cmd > .bat > .ps1', () => {
    const dir = dirWith({ 'aider.exe': 'x', 'aider.cmd': 'x', 'aider.bat': 'x' })
    const result = detectInstalledRuntimes([dir], 'win32')
    expect(result[0].path).toBe(path.join(dir, 'aider.exe'))
  })

  it('POSIX：同名文件且有可执行权限才算命中', () => {
    const dir = dirWith({ opencode: '#!/bin/sh', qwen: '#!/bin/sh' })
    fakeFile(path.join(dir, 'opencode'), 0o755)
    fakeFile(path.join(dir, 'qwen'), 0o644)
    const result = detectInstalledRuntimes([dir], 'linux')
    expect(result.map((r) => r.command)).toEqual(['opencode'])
    expect(result[0].path).toBe(path.join(dir, 'opencode'))
  })

  it('POSIX：目录而非文件不算命中', () => {
    const dir = dirWith({})
    fakeFile(path.join(dir, 'crush'), 0o755, false)
    const result = detectInstalledRuntimes([dir], 'linux')
    expect(result).toEqual([])
  })

  it('同一命令在多个目录命中时取靠前的目录', () => {
    const first = dirWith({ 'dsh.cmd': 'a' })
    const second = dirWith({ 'dsh.cmd': 'b' })
    const result = detectInstalledRuntimes([first, second], 'win32')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe(path.join(first, 'dsh.cmd'))
  })

  it('目录不存在则跳过，不影响后续目录', () => {
    const dir = dirWith({ 'dsh.cmd': 'a' })
    const missing = path.join(root, 'not-exist-dir')
    const result = detectInstalledRuntimes([missing, dir], 'win32')
    expect(result.map((r) => r.command)).toEqual(['dsh'])
  })

  it('未安装的命令不返回；结果按候选清单顺序稳定输出', () => {
    const dir = dirWith({ 'goose.cmd': 'x', 'dsh.cmd': 'x', 'crush.cmd': 'x' })
    const result = detectInstalledRuntimes([dir], 'win32')
    expect(result.map((r) => r.command)).toEqual(['dsh', 'goose', 'crush'])
  })

  it('空目录列表返回空数组', () => {
    expect(detectInstalledRuntimes([], 'win32')).toEqual([])
    expect(detectInstalledRuntimes([''], 'win32')).toEqual([])
  })

  it('默认从 PATH 环境变量推导扫描目录', () => {
    const dir = dirWith({ 'dsh.cmd': 'a' })
    const previous = process.env.PATH
    process.env.PATH = [dir, path.join(root, 'missing')].join(path.delimiter)
    try {
      const result = detectInstalledRuntimes(undefined, 'win32')
      expect(result.map((r) => r.command)).toContain('dsh')
      expect(result.find((r) => r.command === 'dsh')?.path).toBe(path.join(dir, 'dsh.cmd'))
    } finally {
      process.env.PATH = previous
    }
  })

  it('默认扫描目录在 Windows 上包含 APPDATA/npm', () => {
    const dir = dirWith({ 'dsh.cmd': 'a' })
    const previousPath = process.env.PATH
    const previousAppData = process.env.APPDATA
    process.env.PATH = dir
    process.env.APPDATA = path.join(root, 'appdata')
    try {
      const result = detectInstalledRuntimes(undefined, 'win32')
      expect(result.map((r) => r.command)).toContain('dsh')
    } finally {
      process.env.PATH = previousPath
      if (previousAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previousAppData
    }
  })

  it('POSIX 默认扫描目录包含 ~/.local/bin 等常见全局目录', () => {
    const dir = dirWith({ opencode: '#!/bin/sh' })
    fakeFile(path.join(dir, 'opencode'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = dir
    try {
      const result = detectInstalledRuntimes(undefined, 'linux')
      expect(result.map((r) => r.command)).toContain('opencode')
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('PATH / APPDATA / ProgramFiles 缺失时使用兜底目录', () => {
    const previousPath = process.env.PATH
    const previousAppData = process.env.APPDATA
    const previousProgramFiles = process.env.ProgramFiles
    delete process.env.PATH
    delete process.env.APPDATA
    delete process.env.ProgramFiles
    try {
      expect(() => detectInstalledRuntimes(undefined, 'win32')).not.toThrow()
      expect(() => detectInstalledRuntimes(undefined, 'linux')).not.toThrow()
    } finally {
      process.env.PATH = previousPath
      if (previousAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previousAppData
      if (previousProgramFiles === undefined) delete process.env.ProgramFiles
      else process.env.ProgramFiles = previousProgramFiles
    }
  })

  it('相对路径目录命中时输出绝对路径', () => {
    const dir = dirWith({ 'dsh.cmd': 'a' })
    const relative = path.relative(process.cwd(), dir)
    const result = detectInstalledRuntimes([relative], 'win32')
    expect(result[0].path).toBe(path.join(dir, 'dsh.cmd'))
    expect(path.isAbsolute(result[0].path)).toBe(true)
  })
})
