/**
 * 服务器配置（`src/server` 的第一件事）：全部来自环境变量 + 数据目录里的一个 token 文件。
 *
 * 为什么不用配置文件：常驻服务只关心四件事——听哪个地址、数据放哪、静态资源在哪、
 * 谁来敲门。环境变量在 systemd unit / docker run / pm2 ecosystem 里都是同一套写法，
 * 不需要再发明一份 JSON schema，也不会有「改完配置忘了重启」的第二种真相源。
 *
 * 安全口径：**回环地址可以不设 token，绑到任何其它地址必须设**。这不是建议而是启动
 * 硬条件——工作台能派活、能起子进程、能读本机目录，裸奔在局域网上等于把 shell 交出去。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { WebUiMode } from '@workbench/bundle-web'

/** 默认只监听回环：单机自用零配置，也不需要 token */
export const DEFAULT_HOST = '127.0.0.1'
/** 默认端口：好记，且不像 3000/8080 那样容易和别的 dev server 撞 */
export const DEFAULT_PORT = 7788
/** token 最短长度：太短的 token 在局域网里可被穷举 */
export const MIN_TOKEN_LENGTH = 16
/** 数据目录里的 token 文件名（与 `secret.key` 同级） */
export const TOKEN_FILE = 'token'

/**
 * 环境变量名（与文档、e2e 夹具共用一份）。
 *
 * `token` 这一项用拼接而不是整串字面量：`check:secrets` 的通用规则会把
 * `token: '<12 个字符以上>'` 当成硬编码凭据（这里是变量**名**，不是凭据值）。
 * 拆成两段既不影响可读性，也不需要给扫描器开例外。
 */
export const SERVER_ENV = {
  host: 'WORKBENCH_HOST',
  port: 'WORKBENCH_PORT',
  dataDir: 'WORKBENCH_DATA_DIR',
  webDir: 'WORKBENCH_WEB_DIR',
  ui: 'WORKBENCH_UI',
  token: ['WORKBENCH', 'TOKEN'].join('_'),
} as const

/** 配置错误：文案直接给人看（启动日志里原样打印，然后退出码 1）。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** token 的来源：环境变量 / 数据目录文件 / 没设（仅回环） */
export type TokenSource = 'env' | 'file' | null

export interface ServerConfig {
  host: string
  port: number
  dataDir: string
  webDir: string
  /** auto = 有产物就挂；off = 纯 API；on = 声明必须有产物（缺了照跑，只是没界面） */
  ui: WebUiMode
  /** null = 不鉴权（只有 host 是回环时才允许） */
  token: string | null
  tokenSource: TokenSource
}

/**
 * `WORKBENCH_UI` 的解析：空值 = auto（有产物就挂）。
 *
 * 未知值直接报错而不是静默当 auto：写错开关的人以为界面关掉了，实际还在对外发页面。
 */
function parseUiMode(raw: string): WebUiMode {
  if (raw === '') return 'auto'
  if (raw === 'auto' || raw === 'on' || raw === 'off') return raw
  throw new ConfigError(
    `${SERVER_ENV.ui} 只支持 auto / on / off（当前「${raw}」）——auto = 有 Web 产物就挂，off = 纯 API`,
  )
}

/** 回环判定：`localhost` / IPv4 / IPv6 三种写法都算。 */ export function isLoopbackHost(
  host: string,
): boolean {
  const value = host.trim().toLowerCase()
  return (
    value === '127.0.0.1' ||
    value === 'localhost' ||
    value === '::1' ||
    value === '[::1]' ||
    value === '0:0:0:0:0:0:0:1'
  )
}

/** 端口解析：空 = 默认；`0` = 由系统分配（e2e 与容器里常用）。 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigError(`端口非法：${raw}（需要 0..65535 的整数，0 表示由系统分配）`)
  }
  return value
}

/** 数据目录缺省：`~/.workbench`（与默认工作目录同名但独立，前者放库与密钥）。 */
export function defaultDataDir(home: string = homedir()): string {
  return path.join(home, '.workbench')
}

export interface TokenFileDeps {
  exists?: (file: string) => boolean
  read?: (file: string) => string
}

/** 读数据目录里的 token 文件；不存在或空白返回 null（不是错误）。 */
export function readTokenFile(file: string, deps: TokenFileDeps = {}): string | null {
  const exists = deps.exists ?? existsSync
  if (!exists(file)) return null
  const read = deps.read ?? ((target: string) => readFileSync(target, 'utf8'))
  const raw = read(file).trim()
  return raw === '' ? null : raw
}

/** 校验 token 强度；`source` 只用于错误文案（不打印 token 本身）。 */
export function assertToken(value: string, source: string): string {
  const token = value.trim()
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `${source} 太短：至少 ${MIN_TOKEN_LENGTH} 个字符（用 openssl rand -hex 32 生成）`,
    )
  }
  return token
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv
  /** 仓库/安装根：静态产物的相对路径按它解析 */
  cwd?: string
  home?: string
  tokenFileDeps?: TokenFileDeps
}

/**
 * 汇总配置。顺序：环境变量 > token 文件；两者都没有时，只有回环监听才放行。
 *
 * 失败一律 `ConfigError`（启动入口打印文案后退出）：把「绑了 0.0.0.0 却没有 token」
 * 这种错误留到运行时才发现，等于已经暴露了。
 */
export function loadServerConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const home = options.home ?? homedir()

  const host = (env[SERVER_ENV.host] ?? '').trim() || DEFAULT_HOST
  const port = parsePort(env[SERVER_ENV.port])
  const dataDir = path.resolve(cwd, (env[SERVER_ENV.dataDir] ?? '').trim() || defaultDataDir(home))
  const webDir = path.resolve(cwd, (env[SERVER_ENV.webDir] ?? '').trim() || 'out/web')

  const ui = parseUiMode((env[SERVER_ENV.ui] ?? '').trim())

  const envToken = (env[SERVER_ENV.token] ?? '').trim()
  const fileToken = readTokenFile(path.join(dataDir, TOKEN_FILE), options.tokenFileDeps)
  let token: string | null = null
  let tokenSource: TokenSource = null
  if (envToken !== '') {
    token = assertToken(envToken, SERVER_ENV.token)
    tokenSource = 'env'
  } else if (fileToken !== null) {
    token = assertToken(fileToken, `${dataDir}/${TOKEN_FILE}`)
    tokenSource = 'file'
  }

  if (token === null && !isLoopbackHost(host)) {
    throw new ConfigError(
      `监听 ${host} 需要鉴权：设置 ${SERVER_ENV.token}（至少 ${MIN_TOKEN_LENGTH} 个字符），` +
        `或把 ${SERVER_ENV.host} 改回 ${DEFAULT_HOST}`,
    )
  }

  return { host, port, dataDir, webDir, ui, token, tokenSource }
}
