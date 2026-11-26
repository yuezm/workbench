// @vitest-environment node
/**
 * 数据目录收紧（M36-H）：Unix 0700、Windows 只留当前账号与 SYSTEM。
 *
 * 目标不是「沙箱」：同账号下的进程照样读得到（这一点写进 SPEC-host）。能挡的是
 * 其它系统账号、以及 Codex 之类工具在自己沙箱里给用户目录加出来的读权限。
 * 收紧失败不阻断启动：数据可读比「因为改不了 ACL 起不来」更好。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { secureDataDir } from '@workbench/host/secure-dir'

const posixDeps = () => ({
  platform: 'darwin' as NodeJS.Platform,
  userName: 'me',
  chmodSync: vi.fn(),
  execFileSync: vi.fn(),
  log: vi.fn(),
})

describe('secureDataDir', () => {
  it('Unix：chmod 0700', () => {
    const deps = posixDeps()
    expect(secureDataDir('/tmp/ud', deps)).toEqual({ hardened: true, error: null })
    expect(deps.chmodSync).toHaveBeenCalledWith('/tmp/ud', 0o700)
    expect(deps.execFileSync).not.toHaveBeenCalled()
  })

  it('Unix：chmod 失败只记日志，不抛', () => {
    const deps = posixDeps()
    deps.chmodSync.mockImplementation(() => {
      throw new Error('EPERM')
    })
    const result = secureDataDir('/tmp/ud', deps)
    expect(result.hardened).toBe(false)
    expect(result.error).toContain('EPERM')
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('数据目录收紧失败'))
  })

  it('Windows：icacls 只授予当前账号与 SYSTEM（去掉继承）', () => {
    const deps = { ...posixDeps(), platform: 'win32' as NodeJS.Platform, userName: 'yuezm' }
    expect(secureDataDir('C:\\ud', deps)).toEqual({ hardened: true, error: null })
    expect(deps.chmodSync).not.toHaveBeenCalled()
    expect(deps.execFileSync).toHaveBeenCalledTimes(1)
    const [file, args] = deps.execFileSync.mock.calls[0] as [string, string[]]
    expect(file).toBe('icacls')
    expect(args).toEqual([
      'C:\\ud',
      '/inheritance:r',
      '/grant:r',
      'yuezm:(OI)(CI)F',
      '/grant',
      'SYSTEM:(OI)(CI)F',
    ])
  })

  it('Windows：icacls 失败只记日志，不抛', () => {
    const deps = {
      ...posixDeps(),
      platform: 'win32' as NodeJS.Platform,
      userName: 'yuezm',
    }
    deps.execFileSync.mockImplementation(() => {
      throw new Error('Access is denied')
    })
    const result = secureDataDir('C:\\ud', deps)
    expect(result.hardened).toBe(false)
    expect(result.error).toContain('Access is denied')
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('数据目录收紧失败'))
  })

  it('Windows 拿不到用户名：跳过并记日志（不猜账号）', () => {
    const deps = { ...posixDeps(), platform: 'win32' as NodeJS.Platform, userName: '' }
    const result = secureDataDir('C:\\ud', deps)
    expect(result.hardened).toBe(false)
    expect(deps.execFileSync).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalled()
  })
})

describe('secureDataDir：默认依赖（真 fs / 真 icacls）', () => {
  it('不注入 chmod 与日志：真目录被改成 0700（默认闭包也走到）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secure-dir-'))
    try {
      const result = secureDataDir(dir, { platform: 'linux', userName: '', log: () => {} })
      expect(result).toEqual({ hardened: true, error: null })
      if (process.platform !== 'win32') {
        expect(statSync(dir).mode & 0o777).toBe(0o700)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('win32 且不注入 exec：默认 icacls 闭包被调用，失败也只返错不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secure-dir-win-'))
    try {
      const result = secureDataDir(dir, {
        platform: 'win32',
        userName: 'nobody',
        log: () => {},
      })
      // Windows 上 icacls 存在（bool 结果取决于权限）；其它平台 ENOENT 被 catch
      expect(typeof result.hardened).toBe('boolean')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('默认日志闭包：失败时写 stderr 且不抛', () => {
    const result = secureDataDir('/definitely-not-exists', {
      platform: 'linux',
      userName: '',
      chmodSync: () => {
        throw new Error('boom')
      },
    })
    expect(result).toEqual({ hardened: false, error: 'boom' })
  })
})

describe('secureDataDir：账号名来源（USERNAME → USER → 空）', () => {
  /** 临时改宿主环境：两个账号名都要能删干净，否则分支落不到。 */
  const withEnv = (patch: Record<string, string | undefined>, run: () => void): void => {
    const saved = Object.fromEntries(
      Object.keys(patch).map((key) => [key, process.env[key]] as const),
    )
    try {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      run()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  const winDeps = () => ({
    platform: 'win32' as NodeJS.Platform,
    chmodSync: vi.fn(),
    execFileSync: vi.fn(),
    log: vi.fn(),
  })

  it('USERNAME 为空时退回 USER（服务端形态下拿得到账号名）', () => {
    withEnv({ USERNAME: undefined, USER: 'fallback-user' }, () => {
      const deps = winDeps()
      expect(secureDataDir('C:\\ud', deps)).toEqual({ hardened: true, error: null })
      const [, args] = deps.execFileSync.mock.calls[0] as [string, string[]]
      expect(args).toContain('fallback-user:(OI)(CI)F')
    })
  })

  it('两个环境变量都没有：按「拿不到账号名」跳过，不猜账号', () => {
    withEnv({ USERNAME: undefined, USER: undefined }, () => {
      const deps = winDeps()
      expect(secureDataDir('C:\\ud', deps)).toEqual({ hardened: false, error: 'USERNAME 为空' })
      expect(deps.execFileSync).not.toHaveBeenCalled()
    })
  })

  it('chmod 抛非 Error：文案用 String 兜底，仍不抛', () => {
    const deps = posixDeps()
    // 外部能力（真 fs / 真 icacls）抛出来的未必是 Error：类型上按 Error 收，运行期可能是字符串
    const cause = '权限被拒' as unknown as Error
    deps.chmodSync.mockImplementation(() => {
      throw cause
    })
    expect(secureDataDir('/tmp/ud', deps)).toEqual({ hardened: false, error: '权限被拒' })
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('权限被拒'))
  })
})
