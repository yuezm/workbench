// @vitest-environment node
import { describe, expect, it } from 'vitest'

const {
  WINDOWS_DEFAULT_PATHEXT,
  applyEnvPatchOn,
  buildChildEnv,
  envValue,
  normalizePath,
  pathSeparatorOf,
  setEnvValue,
  shellPlatformOf,
  verifyEnv,
} = await import('@workbench/host/shell-env')

/** 一份「Windows 上完整」的宿主环境：注意 PATH 的真实键名是 `Path`。 */
const windowsBase = (): NodeJS.ProcessEnv => ({
  Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SystemRoot: 'C:\\WINDOWS',
  COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe',
  TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
  USERPROFILE: 'C:\\Users\\u',
})

const posixBase = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/u',
})

describe('shellPlatformOf / pathSeparatorOf', () => {
  it('三档平台归一，未知平台按 POSIX 处理', () => {
    expect(shellPlatformOf('win32')).toBe('win32')
    expect(shellPlatformOf('darwin')).toBe('darwin')
    expect(shellPlatformOf('linux')).toBe('linux')
    expect(shellPlatformOf('freebsd')).toBe('linux')
    expect(shellPlatformOf('aix')).toBe('linux')
  })

  it('Windows 用 ; 其余用 :', () => {
    expect(pathSeparatorOf('win32')).toBe(';')
    expect(pathSeparatorOf('darwin')).toBe(':')
    expect(pathSeparatorOf('linux')).toBe(':')
  })
})

describe('envValue / setEnvValue', () => {
  it('POSIX 大小写敏感：只有精确键能取到', () => {
    const env = { PATH: '/bin', Path: '/ignored' }
    expect(envValue(env, 'PATH', 'linux')).toBe('/bin')
    expect(envValue(env, 'path', 'linux')).toBeUndefined()
  })

  it('Windows 大小写不敏感：PATH 命中的是真实的 Path 键', () => {
    const env = { Path: '/win', OTHER: '1' }
    expect(envValue(env, 'PATH', 'win32')).toBe('/win')
    expect(envValue(env, 'Path', 'win32')).toBe('/win')
  })

  it('空串等同于没有（避免「设了但等于没设」）', () => {
    expect(envValue({ PATH: '' }, 'PATH', 'linux')).toBeUndefined()
    expect(envValue({}, 'PATH', 'linux')).toBeUndefined()
  })

  it('写回时保留原键名，不制造 PATH / Path 双键', () => {
    const env: NodeJS.ProcessEnv = { Path: '/old' }
    setEnvValue(env, 'PATH', '/new', 'win32')
    expect(env).toEqual({ Path: '/new' })
    expect('PATH' in env).toBe(false)
  })

  it('键不存在时按给定键名新建；POSIX 直接新建', () => {
    const win: NodeJS.ProcessEnv = {}
    setEnvValue(win, 'PATHEXT', '.EXE', 'win32')
    expect(win).toEqual({ PATHEXT: '.EXE' })

    const posix: NodeJS.ProcessEnv = {}
    setEnvValue(posix, 'HOME', '/home/u', 'linux')
    expect(posix).toEqual({ HOME: '/home/u' })
  })
})

describe('normalizePath', () => {
  it('去空段、去 "." 段、保序', () => {
    expect(normalizePath('/a::/b:.:/c:', 'linux')).toBe('/a:/b:/c')
  })

  it('去重：Windows 大小写不敏感，POSIX 敏感', () => {
    expect(normalizePath('C:\\bin;c:\\BIN;C:\\bin', 'win32')).toBe('C:\\bin')
    expect(normalizePath('/Bin:/bin', 'linux')).toBe('/Bin:/bin')
  })

  it('Windows 段尾反斜杠归一，但盘符根保留', () => {
    expect(normalizePath('C:\\tools\\;D:\\', 'win32')).toBe('C:\\tools;D:\\')
  })

  it('带引号的段去引号（PATH 里偶尔会出现手写的引号）', () => {
    expect(normalizePath('"/opt/my bin":/usr/bin', 'linux')).toBe('/opt/my bin:/usr/bin')
  })

  it('全是空段时得到空串', () => {
    expect(normalizePath(':::', 'linux')).toBe('')
    expect(normalizePath(';;;', 'win32')).toBe('')
  })
})

describe('buildChildEnv', () => {
  it('patch 覆盖 base，其余键原样保留', () => {
    const env = buildChildEnv(posixBase(), { DSH_PERMISSION_MODE: 'danger-full-access' }, 'linux')
    expect(env['PATH']).toBe('/usr/local/bin:/usr/bin')
    expect(env['HOME']).toBe('/home/u')
    expect(env['DSH_PERMISSION_MODE']).toBe('danger-full-access')
  })

  it('Windows：patch 只给一个键也能拿到完整 PATH 与 PATHEXT（本次修复的核心）', () => {
    const env = buildChildEnv(windowsBase(), { DSH_PERMISSION_MODE: 'read-only' }, 'win32')
    // PATH 的真实键名是 Path，值必须还在
    expect(envValue(env, 'PATH', 'win32')).toBe('C:\\Windows\\system32;C:\\Program Files\\Git\\cmd')
    expect(envValue(env, 'PATHEXT', 'win32')).toBe('.COM;.EXE;.BAT;.CMD')
    expect(envValue(env, 'SystemRoot', 'win32')).toBe('C:\\WINDOWS')
    expect(env['DSH_PERMISSION_MODE']).toBe('read-only')
  })

  it('Windows：base 缺 PATHEXT 时补标准值（libuv 不替我们补）', () => {
    const base = windowsBase()
    delete base['PATHEXT']
    const env = buildChildEnv(base, {}, 'win32')
    expect(envValue(env, 'PATHEXT', 'win32')).toBe(WINDOWS_DEFAULT_PATHEXT)
  })

  it('patch 显式给了值就以 patch 为准（不做二次兜底）', () => {
    const env = buildChildEnv(windowsBase(), { PATHEXT: '.EXE' }, 'win32')
    expect(envValue(env, 'PATHEXT', 'win32')).toBe('.EXE')
  })

  it('POSIX 分支不注入 PATHEXT（那不是它的概念）', () => {
    const env = buildChildEnv(posixBase(), {}, 'linux')
    expect('PATHEXT' in env).toBe(false)
  })

  it('路径变量顺手归一：重复段不会越叠越长', () => {
    const env = buildChildEnv(
      { PATH: '/usr/bin:/usr/bin:/bin' },
      { PATH: '/usr/bin:/bin:/opt' },
      'linux',
    )
    expect(env['PATH']).toBe('/usr/bin:/bin:/opt')
  })

  it('patch 把必需键设成空串时回落到 base（空值等于没设）', () => {
    const env = buildChildEnv({ PATH: '/bin', HOME: '/h' }, { PATH: '' }, 'linux')
    expect(env['PATH']).toBe('/bin')
  })

  it('base 缺必需键时不无中生有（只补 Windows 的 PATHEXT）', () => {
    expect(buildChildEnv({}, {}, 'linux')).toEqual({})
    // Windows 上唯一会「凭默认值补出来」的键就是 PATHEXT
    expect(buildChildEnv({}, {}, 'win32')).toEqual({ PATHEXT: WINDOWS_DEFAULT_PATHEXT })
  })
})

describe('applyEnvPatchOn', () => {
  it('先删 unset 再按 set 覆盖，其余键原样继承', () => {
    const merged = applyEnvPatchOn(
      { PATH: '/bin', HERMES_HOME: 'C:/h', OPENCLAW_HOME: 'C:/o' },
      { unset: ['HERMES_HOME', 'OPENCLAW_HOME'], set: { LARK: '1' } },
      'linux',
    )
    expect(merged).toEqual({ PATH: '/bin', LARK: '1' })
  })

  it('Windows 上删 PATH 连 Path 一起删（键名归一）', () => {
    const merged = applyEnvPatchOn({ Path: '/win', KEEP: '1' }, { unset: ['PATH'] }, 'win32')
    expect(merged).toEqual({ KEEP: '1' })
  })

  it('Windows 上 set 覆盖已有键时写回原键名', () => {
    const merged = applyEnvPatchOn({ Path: '/win' }, { set: { PATH: '/next' } }, 'win32')
    expect(merged).toEqual({ Path: '/next' })
  })

  it('不修改入参', () => {
    const base = { PATH: '/bin', X: '1' }
    applyEnvPatchOn(base, { unset: ['X'], set: { Y: '2' } }, 'linux')
    expect(base).toEqual({ PATH: '/bin', X: '1' })
  })
})

describe('verifyEnv', () => {
  it('完整环境：ok，无缺失无重复', () => {
    expect(verifyEnv(windowsBase(), 'win32')).toEqual({
      ok: true,
      platform: 'win32',
      missing: [],
      pathDuplicates: [],
      pathSegments: 2,
    })
  })

  it('缺 PATHEXT：判不 ok，并指名道姓', () => {
    const base = windowsBase()
    delete base['PATHEXT']
    const report = verifyEnv(base, 'win32')
    expect(report.ok).toBe(false)
    expect(report.missing).toEqual(['PATHEXT'])
  })

  it('PATH 重复段只报告、不判死', () => {
    const report = verifyEnv({ PATH: '/usr/bin:/bin:/usr/bin', HOME: '/h' }, 'linux')
    expect(report.ok).toBe(true)
    expect(report.pathDuplicates).toEqual(['/usr/bin'])
    expect(report.pathSegments).toBe(2)
  })

  it('PATH 缺失：段数 0 且列入 missing', () => {
    const report = verifyEnv({ HOME: '/h' }, 'linux')
    expect(report.missing).toEqual(['PATH'])
    expect(report.pathSegments).toBe(0)
  })

  it('POSIX 必需集不含 PATHEXT / SystemRoot', () => {
    expect(verifyEnv({ PATH: '/bin', HOME: '/h' }, 'darwin').missing).toEqual([])
  })
})
