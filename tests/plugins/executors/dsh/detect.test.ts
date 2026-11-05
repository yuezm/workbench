// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * dsh 执行器插件的本机检测（T9 搬家后的用例）。
 *
 * 原 `tests/main/ai-workflow/runtime/detect.test.ts` 的 14 条逐条保留语义：
 * 候选清单/展示名、Windows 后缀与优先级、POSIX 可执行位、多目录取靠前、默认扫描目录、
 * 环境变量缺失兜底、相对路径转绝对路径。变化只有来源——
 * 现在走 `dshPlugin.detect({ sdk })`：扫描目录与命中判定都经 sdk 能力面，
 * `executorKey` / `supported` 由注册表汇总时回填，因此这里断言原始命中（空串 / false）。
 *
 * POSIX 可执行位在 Windows 上无法通过真实 fs 表达，因此只对 statSync 的 mode/isFile
 * 做可控替换，其余走真实实现（与 `tests/host/executable.test.ts` 同一套替身）。
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

const { createSdk } = await import('../../../../src/sdk')
const { dshManifest } = await import('../../../../src/plugins/executors/dsh/manifest')
const { detectDsh } = await import('../../../../src/plugins/executors/dsh/detect')
const { defaultScanDirs, findInDirs } = await import('../../../../src/host/executable')

import type { DetectedRuntime } from '../../../../src/protocol/entities'
import type { SdkHost } from '../../../../src/sdk/types'

let root: string

beforeEach(() => {
  fakeEntries.clear()
  root = mkdtempSync(path.join(tmpdir(), 'detect-dsh-'))
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

/**
 * 按平台/目录构造宿主能力面并跑 dsh 插件的 detect。
 *
 * 真实生产里 `scanDirs/findInDirs` 由 `host/sdk-host.ts` 注入；这里只替换来源，
 * 命中判定仍走 `host/executable` 的真实实现（Windows 后缀 / POSIX 可执行位）。
 */
function detectWith(dirs: string[] | undefined, platform: NodeJS.Platform): DetectedRuntime[] {
  const sdkHost: SdkHost = {
    log: () => undefined,
    now: () => 0,
    paths: { sessionRoot: null },
    config: <T = Record<string, unknown>>() => ({}) as T,
    process: {
      spawn: () => {
        throw new Error('detect 不允许启动子进程')
      },
      resolve: (command) => ({ path: null, error: `detect 不解析命令：${command}` }),
      killTree: () => false,
      scanDirs: () => dirs ?? defaultScanDirs(platform),
      findInDirs: (command, list) => findInDirs(command, list, platform),
    },
  }
  return detectDsh({ sdk: createSdk(sdkHost, dshManifest) })
}

describe('dsh 插件 detect', () => {
  it('Windows：命中 .cmd shim（npm 全局安装形态），只报 dsh 自己', () => {
    const dir = dirWith({ 'dsh.cmd': '@echo off', 'claude.cmd': '@echo off' })
    const result = detectWith([dir], 'win32')
    expect(result).toHaveLength(1)
    expect(result[0].command).toBe('dsh')
    expect(result[0].label).toBe('DeepSeek Harness')
    expect(result[0].path).toBe(path.join(dir, 'dsh.cmd'))
    // executorKey / supported 由 registry 汇总时回填，插件只报命中的命令
    expect(result[0].executorKey).toBe('')
    expect(result[0].supported).toBe(false)
  })

  it('Windows：.exe / .cmd / .bat / .ps1 任一即算已安装', () => {
    for (const extension of ['.exe', '.cmd', '.bat', '.ps1']) {
      const dir = dirWith({ [`dsh${extension}`]: 'x' })
      const result = detectWith([dir], 'win32')
      expect(result.map((item) => item.path)).toEqual([path.join(dir, `dsh${extension}`)])
    }
  })

  it('Windows：后缀优先级 .exe > .cmd > .bat > .ps1', () => {
    const dir = dirWith({ 'dsh.exe': 'x', 'dsh.cmd': 'x', 'dsh.bat': 'x' })
    const result = detectWith([dir], 'win32')
    expect(result[0].path).toBe(path.join(dir, 'dsh.exe'))
  })

  it('POSIX：同名文件且有可执行权限才算命中', () => {
    const hitDir = dirWith({ dsh: '#!/bin/sh' })
    fakeFile(path.join(hitDir, 'dsh'), 0o755)
    expect(detectWith([hitDir], 'linux').map((item) => item.command)).toEqual(['dsh'])

    const missDir = dirWith({ dsh: '#!/bin/sh' })
    fakeFile(path.join(missDir, 'dsh'), 0o644)
    expect(detectWith([missDir], 'linux')).toEqual([])
  })

  it('POSIX：目录而非文件不算命中', () => {
    const dir = dirWith({})
    fakeFile(path.join(dir, 'dsh'), 0o755, false)
    expect(detectWith([dir], 'linux')).toEqual([])
  })

  it('同一命令在多个目录命中时取靠前的目录', () => {
    const first = dirWith({ 'dsh.cmd': 'a' })
    const second = dirWith({ 'dsh.cmd': 'b' })
    const result = detectWith([first, second], 'win32')
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe(path.join(first, 'dsh.cmd'))
  })

  it('目录不存在则跳过，不影响后续目录', () => {
    const dir = dirWith({ 'dsh.cmd': 'a' })
    const missing = path.join(root, 'not-exist-dir')
    expect(detectWith([missing, dir], 'win32').map((item) => item.command)).toEqual(['dsh'])
  })

  it('未安装 dsh 时不返回；装了其它 CLI 也不越权认领', () => {
    const onlyOthers = dirWith({ 'claude.cmd': 'x', 'codex.cmd': 'x' })
    expect(detectWith([onlyOthers], 'win32')).toEqual([])

    const withDsh = dirWith({ 'claude.cmd': 'x', 'dsh.cmd': 'x', 'goose.cmd': 'x' })
    expect(detectWith([withDsh], 'win32').map((item) => item.command)).toEqual(['dsh'])
  })

  it('空目录列表返回空数组', () => {
    expect(detectWith([], 'win32')).toEqual([])
    expect(detectWith([''], 'win32')).toEqual([])
  })

  it('默认从 PATH 环境变量推导扫描目录', () => {
    const dir = dirWith({ 'dsh.cmd': 'a' })
    const previous = process.env.PATH
    process.env.PATH = [dir, path.join(root, 'missing')].join(path.delimiter)
    try {
      const result = detectWith(undefined, 'win32')
      expect(result.map((item) => item.command)).toContain('dsh')
      expect(result.find((item) => item.command === 'dsh')?.path).toBe(path.join(dir, 'dsh.cmd'))
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
      expect(detectWith(undefined, 'win32').map((item) => item.command)).toContain('dsh')
    } finally {
      process.env.PATH = previousPath
      if (previousAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previousAppData
    }
  })

  it('POSIX 默认扫描目录包含 ~/.local/bin 等常见全局目录', () => {
    const dir = dirWith({ dsh: '#!/bin/sh' })
    fakeFile(path.join(dir, 'dsh'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = dir
    try {
      expect(detectWith(undefined, 'linux').map((item) => item.command)).toContain('dsh')
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
      expect(() => detectWith(undefined, 'win32')).not.toThrow()
      expect(() => detectWith(undefined, 'linux')).not.toThrow()
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
    const result = detectWith([relative], 'win32')
    expect(result[0].path).toBe(path.join(dir, 'dsh.cmd'))
    expect(path.isAbsolute(result[0].path)).toBe(true)
  })
})
