// @vitest-environment node
/**
 * 服务器配置：全部从环境变量读，唯一的安全硬条件是「非回环必须带 token」。
 *
 * 这些用例不碰真实文件系统（token 文件 IO 注入），也不起服务——配置错了就该在启动
 * 第一秒抛出可读错误，而不是等浏览器来敲门才发现没有鉴权。
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MIN_TOKEN_LENGTH,
  SERVER_ENV,
  assertToken,
  defaultDataDir,
  isLoopbackHost,
  loadServerConfig,
  parsePort,
  readTokenFile,
} from '../../src/server/config'

const HOME = path.join(path.sep, 'home', 'me')
const CWD = path.join(path.sep, 'app')
const TOKEN = 'x'.repeat(MIN_TOKEN_LENGTH)

describe('isLoopbackHost', () => {
  it('四种回环写法都认，其余一律不算', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '::1'.toUpperCase()]) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['0.0.0.0', '192.168.1.5', 'me.local', '']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('parsePort', () => {
  it('空值取默认端口', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT)
    expect(parsePort('  ')).toBe(DEFAULT_PORT)
  })

  it('0 表示由系统分配，1..65535 原样接受', () => {
    expect(parsePort('0')).toBe(0)
    expect(parsePort(' 7788 ')).toBe(7788)
    expect(parsePort('65535')).toBe(65535)
  })

  it('负数 / 越界 / 小数 / 非数字都抛可读错误', () => {
    for (const raw of ['-1', '65536', '1.5', 'abc']) {
      expect(() => parsePort(raw), raw).toThrow(ConfigError)
    }
  })
})

describe('readTokenFile / assertToken', () => {
  it('文件不存在或空白都返回 null（不是错误）', () => {
    expect(readTokenFile('/data/token', { exists: () => false })).toBeNull()
    expect(readTokenFile('/data/token', { exists: () => true, read: () => '  \n' })).toBeNull()
  })

  it('文件内容 trim 后返回', () => {
    expect(readTokenFile('/data/token', { exists: () => true, read: () => ` ${TOKEN}\n` })).toBe(
      TOKEN,
    )
  })

  it('短于下限直接拒绝，错误文案不包含 token 本身', () => {
    expect(() => assertToken('short', 'WORKBENCH_TOKEN')).toThrow(
      new RegExp(`至少 ${MIN_TOKEN_LENGTH} 个字符`, 'u'),
    )
    expect(() => assertToken('short', 'WORKBENCH_TOKEN')).toThrow(/WORKBENCH_TOKEN/u)
  })
})

describe('loadServerConfig', () => {
  const base = { env: {}, cwd: CWD, home: HOME, tokenFileDeps: { exists: () => false } }

  it('零配置：回环 + 默认端口 + 默认数据目录 + 无鉴权', () => {
    const config = loadServerConfig(base)
    expect(config.host).toBe(DEFAULT_HOST)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.dataDir).toBe(path.resolve(defaultDataDir(HOME)))
    expect(config.webDir).toBe(path.resolve(CWD, 'out/web'))
    expect(config.token).toBeNull()
    expect(config.tokenSource).toBeNull()
  })

  it('环境变量覆盖主机 / 端口 / 数据目录 / 产物目录', () => {
    const config = loadServerConfig({
      ...base,
      env: {
        [SERVER_ENV.host]: '127.0.0.1',
        [SERVER_ENV.port]: '9000',
        [SERVER_ENV.dataDir]: 'var/data',
        [SERVER_ENV.webDir]: 'public',
      },
    })
    expect(config.port).toBe(9000)
    expect(config.dataDir).toBe(path.resolve(CWD, 'var/data'))
    expect(config.webDir).toBe(path.resolve(CWD, 'public'))
  })

  it('环境变量 token：校验长度并记来源', () => {
    const config = loadServerConfig({ ...base, env: { [SERVER_ENV.token]: TOKEN } })
    expect(config.token).toBe(TOKEN)
    expect(config.tokenSource).toBe('env')
  })

  it('环境变量 token 太短：启动就失败', () => {
    expect(() => loadServerConfig({ ...base, env: { [SERVER_ENV.token]: 'short' } })).toThrow(
      ConfigError,
    )
  })

  it('token 文件：环境变量没写时从数据目录读', () => {
    const config = loadServerConfig({
      ...base,
      tokenFileDeps: { exists: () => true, read: () => `${TOKEN}\n` },
    })
    expect(config.token).toBe(TOKEN)
    expect(config.tokenSource).toBe('file')
  })

  it('环境变量优先于 token 文件', () => {
    const config = loadServerConfig({
      ...base,
      env: { [SERVER_ENV.token]: `${TOKEN}-env` },
      tokenFileDeps: { exists: () => true, read: () => TOKEN },
    })
    expect(config.token).toBe(`${TOKEN}-env`)
    expect(config.tokenSource).toBe('env')
  })

  it('绑到非回环地址却没有 token：拒绝启动，并说清怎么修', () => {
    expect(() => loadServerConfig({ ...base, env: { [SERVER_ENV.host]: '0.0.0.0' } })).toThrow(
      /需要鉴权/u,
    )
  })

  it('绑到非回环地址且有 token：放行', () => {
    const config = loadServerConfig({
      ...base,
      env: { [SERVER_ENV.host]: '0.0.0.0', [SERVER_ENV.token]: TOKEN },
    })
    expect(config.host).toBe('0.0.0.0')
    expect(config.token).toBe(TOKEN)
  })

  it('端口非法：抛 ConfigError（而不是带着 0 端口跑起来）', () => {
    expect(() => loadServerConfig({ ...base, env: { [SERVER_ENV.port]: 'abc' } })).toThrow(
      ConfigError,
    )
  })
})
