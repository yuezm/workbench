// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSdkHost } from '../../src/host/sdk-host'
import { defaultSpawn } from '../../src/host/process'
import type { NetCapability, SpawnFn, Spawned } from '../../src/sdk/types'

/**
 * 宿主能力原件（M3 T4 / M4 T6）：`createSdkHost` 用 `host/process.ts` 与 `host/executable.ts`
 * 的现成实现组装 `SdkHost`，本用例只验证「原件接得对 + 缺省值 + 失败不抛」。
 * 命令解析/进程树终止的平台分支由 `tests/main/ai-workflow/runtime/{executable,process}.test.ts`
 * 覆盖，这里不重复；只补 sdk-host 自身的失败语义（含 M4 的 notify 缺省/注入）。
 */

/** 最小子进程句柄：注入假 spawn 时用，不跑真实进程。 */
const spawned: Spawned = {
  pid: 7777,
  stdin: null,
  stdout: null,
  stderr: null,
  onError: () => undefined,
  onClose: () => undefined,
  kill: () => undefined,
}

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sdk-host-'))
  tempDirs.push(dir)
  return dir
}

/** 放一个可执行文件：Windows 用 `.cmd`（findInDirs 认后缀），POSIX 靠可执行位。 */
function dirWithTool(tool: string): { dir: string; file: string } {
  const dir = tempDir()
  const file = path.join(dir, process.platform === 'win32' ? `${tool}.cmd` : tool)
  writeFileSync(file, 'x', { mode: 0o755 })
  return { dir, file }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createSdkHost 缺省值', () => {
  it('sessionRoot 未配置为 null，注入后原样保留；cwd 缺省为主进程当前目录', () => {
    expect(createSdkHost().paths.sessionRoot).toBeNull()
    const sessions = 'C:/data/ai-workflow/sessions'
    expect(createSdkHost({ sessionRoot: sessions }).paths.sessionRoot).toBe(sessions)
    expect(createSdkHost().paths.cwd).toBe(process.cwd())
    expect(createSdkHost({ cwd: 'D:/work' }).paths.cwd).toBe('D:/work')
  })

  it('now 缺省用系统时钟（毫秒），可注入假时钟', () => {
    expect(createSdkHost().now()).toBeGreaterThan(1_600_000_000_000)
    expect(createSdkHost({ now: () => 42 }).now()).toBe(42)
  })

  it('log 缺省落 console.warn，可注入自己的通道', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    createSdkHost().log('[plugin:dsh] 探活')
    expect(warn).toHaveBeenCalledWith('[plugin:dsh] 探活')

    const lines: string[] = []
    createSdkHost({ log: (line) => lines.push(line) }).log('x')
    expect(lines).toEqual(['x'])
  })

  it('config 缺省为空对象，可注入插件配置', () => {
    expect(createSdkHost().config()).toEqual({})
    const config = <T = Record<string, unknown>>(): T => ({ mode: 'dsh' }) as T
    expect(createSdkHost({ config }).config<{ mode: string }>().mode).toBe('dsh')
  })

  it('spawn 缺省是 host/process 的 defaultSpawn，可注入假实现', () => {
    expect(createSdkHost().process.spawn).toBe(defaultSpawn)

    const spawn = vi.fn<SpawnFn>(() => spawned)
    const host = createSdkHost({ spawn })
    const options = { env: { PATH: 'C:/bin' } }
    expect(host.process.spawn('dsh.cmd', ['--stdio'], options)).toBe(spawned)
    expect(spawn).toHaveBeenCalledWith('dsh.cmd', ['--stdio'], options)
  })

  it('notify 缺省静默丢弃：不抛、不落日志（通知文案与落点都不落日志）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const host = createSdkHost()

    expect(host.notify).toBeTypeOf('function')
    expect(() => host.notify?.('待审批', '任务已挂起')).not.toThrow()
    expect(() => host.notify?.('待审批', '任务已挂起', { cardId: 'card-1' })).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it('notify 注入后原样转发 title/body（只作参数，不拼接）', () => {
    const notify = vi.fn()
    const host = createSdkHost({ notify })

    host.notify?.('待审批', '任务已挂起\n1. 继续\n2. 终止')

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('待审批', '任务已挂起\n1. 继续\n2. 终止')
  })

  it('notify 注入后第三参落点原样转发（宿主原件不补 appId、不改写）', () => {
    const notify = vi.fn()
    const host = createSdkHost({ notify })

    host.notify?.('待审批', '点开工作台查看并处理', { cardId: 'card-1', conversationId: 'c-1' })

    expect(notify).toHaveBeenCalledWith('待审批', '点开工作台查看并处理', {
      cardId: 'card-1',
      conversationId: 'c-1',
    })
  })

  it('net 缺省不注入（声明 net 的插件调用即 capability_unavailable），注入后原样保留', () => {
    expect(createSdkHost().net).toBeUndefined()

    const net: NetCapability = {
      fetch: vi.fn(async () => ({ status: 200, headers: {}, body: '' })),
      listen: vi.fn(async () => ({ port: 47_615, close: async () => undefined })),
      verifyHmacSha256: vi.fn(() => true),
    }
    expect(createSdkHost({ net }).net).toBe(net)
  })
})

describe('createSdkHost process 能力', () => {
  it('resolve 成功给绝对路径；失败返回 {path:null,error} 不抛', () => {
    const host = createSdkHost()
    expect(host.process.resolve(process.execPath).path).toBe(path.resolve(process.execPath))

    const resolved = host.process.resolve('sdk-host-missing-command-xyz')
    expect(resolved.path).toBeNull()
    expect(resolved.error).toContain('PATH')
  })

  it('scanDirs：PATH 各段排在前，PATH 缺失时仍有全局目录兜底', () => {
    const a = path.join(tmpdir(), 'sdk-host-scan-a')
    const b = path.join(tmpdir(), 'sdk-host-scan-b')
    vi.stubEnv('PATH', [a, b].join(path.delimiter))
    expect(createSdkHost().process.scanDirs().slice(0, 2)).toEqual([a, b])

    vi.stubEnv('PATH', '')
    const dirs = createSdkHost().process.scanDirs()
    expect(Array.isArray(dirs)).toBe(true)
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.every((dir) => typeof dir === 'string' && dir.trim().length > 0)).toBe(true)
  })

  it('findInDirs：命中返回绝对路径，未命中返回 null', () => {
    const { dir, file } = dirWithTool('sdkprobe')
    const host = createSdkHost()
    expect(host.process.findInDirs('sdkprobe', [dir])).toBe(file)
    expect(host.process.findInDirs('sdk-host-missing-tool', [dir])).toBeNull()
  })

  it('killTree 接入 killProcessTree：成功 true，目标已消失 false（不向外抛）', () => {
    // 固定到 POSIX 分支：Windows 的 taskkill 是异步兜底，无法同步判定 pid 是否存在；
    // POSIX 下 process.kill 抛错即「进程已消失」，与 host/process 的返回语义一致。
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const host = createSdkHost()
      expect(host.process.killTree(4321, 'SIGTERM')).toBe(true)
      expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM')

      kill.mockImplementation(() => {
        throw new Error('ESRCH')
      })
      expect(host.process.killTree(999_999)).toBe(false)
      // 进程组与单进程各试一次，都没命中才算「已消失」
      expect(kill).toHaveBeenCalledWith(-999_999, 'SIGKILL')
    } finally {
      kill.mockRestore()
      Object.defineProperty(process, 'platform', descriptor as PropertyDescriptor)
    }
  })
})
