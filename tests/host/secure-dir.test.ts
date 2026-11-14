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
import { secureDataDir } from '../../src/host/secure-dir'

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
