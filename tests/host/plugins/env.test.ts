// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_ENV_ALLOWLIST,
  PLUGIN_ENV_PREFIXES,
  PLUGIN_RUN_AS_NODE,
  buildPluginEnv,
} from '../../../src/host/plugins/env'

/**
 * 外部插件子进程环境白名单（M7 D2）：只继承运行 Node 所需的最小集合，
 * 其余 `process.env`（token、代理凭据、私有 registry 等）一律不进入子进程。
 */

const sourceOf = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: 'C:/bin',
  SystemRoot: 'C:/Windows',
  COMSPEC: 'C:/Windows/system32/cmd.exe',
  TEMP: 'C:/Temp',
  USERPROFILE: 'C:/Users/me',
  APPDATA: 'C:/Users/me/AppData/Roaming',
  HOME: '/home/me',
  LANG: 'zh_CN.UTF-8',
  LC_ALL: 'zh_CN.UTF-8',
  LC_CTYPE: 'zh_CN.UTF-8',
  ...extra,
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('buildPluginEnv 白名单', () => {
  it('固定白名单与 LC_* 前缀被继承，其余键全部丢弃', () => {
    const env = buildPluginEnv({}, sourceOf({ SECRET_TOKEN: 'leak', NODE_OPTIONS: '--inspect' }))

    expect(env.PATH).toBe('C:/bin')
    expect(env.SystemRoot).toBe('C:/Windows')
    expect(env.COMSPEC).toBe('C:/Windows/system32/cmd.exe')
    expect(env.TEMP).toBe('C:/Temp')
    expect(env.USERPROFILE).toBe('C:/Users/me')
    expect(env.APPDATA).toBe('C:/Users/me/AppData/Roaming')
    expect(env.HOME).toBe('/home/me')
    expect(env.LANG).toBe('zh_CN.UTF-8')
    expect(env.LC_ALL).toBe('zh_CN.UTF-8')
    expect(env.LC_CTYPE).toBe('zh_CN.UTF-8')
    expect(env.SECRET_TOKEN).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('白名单里的每个键都能继承（逐项核对清单）', () => {
    const source = Object.fromEntries(PLUGIN_ENV_ALLOWLIST.map((key) => [key, `v-${key}`]))
    const env = buildPluginEnv({}, source)
    for (const key of PLUGIN_ENV_ALLOWLIST) expect(env[key]).toBe(`v-${key}`)
  })

  it('大小写不敏感匹配白名单键，输出保留原键名（Windows 的 Path 也能继承）', () => {
    const env = buildPluginEnv({}, { Path: 'C:/bin', systemroot: 'C:/Windows' })
    expect(env.Path).toBe('C:/bin')
    expect(env.systemroot).toBe('C:/Windows')
    expect(env.PATH).toBeUndefined()
  })

  it('未列出的前缀（如 NODE_）不继承', () => {
    const env = buildPluginEnv({}, { NODE_ENV: 'production', WB_TOKEN: 'x' })
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.WB_TOKEN).toBeUndefined()
    expect(PLUGIN_ENV_PREFIXES).toEqual(['LC_'])
  })

  it('ELECTRON_RUN_AS_NODE 恒为 1：宿主覆盖也改不掉（固定项最后写）', () => {
    expect(buildPluginEnv({}, {})[PLUGIN_RUN_AS_NODE]).toBe('1')
    expect(buildPluginEnv({ [PLUGIN_RUN_AS_NODE]: '0' }, {})[PLUGIN_RUN_AS_NODE]).toBe('1')
  })

  it('overrides 覆盖白名单值、追加非白名单键；undefined 值不写入', () => {
    const env = buildPluginEnv(
      { PATH: 'D:/custom', WB_DEBUG: '1', WB_EMPTY: undefined },
      sourceOf(),
    )
    expect(env.PATH).toBe('D:/custom')
    expect(env.WB_DEBUG).toBe('1')
    expect('WB_EMPTY' in env).toBe(false)
  })

  it('源环境里的 undefined 值不写入（不产生 "undefined" 字符串）', () => {
    const env = buildPluginEnv({}, { PATH: undefined })
    expect('PATH' in env).toBe(false)
    expect(env[PLUGIN_RUN_AS_NODE]).toBe('1')
  })

  it('缺省源是 process.env：stub 的敏感变量不会进入子进程环境', () => {
    vi.stubEnv('WB_TEST_SECRET', 'leak')
    vi.stubEnv('PATH', 'C:/stub-bin')
    const env = buildPluginEnv()
    expect(env.WB_TEST_SECRET).toBeUndefined()
    expect(env.PATH).toBe('C:/stub-bin')
  })
})
