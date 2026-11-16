/**
 * 鉴权（服务端）：一个共享 token，三种带法——请求头、Bearer、HttpOnly cookie。
 *
 * 为什么是 cookie：浏览器要把 token 放进 `EventSource`（SSE 不支持自定义请求头），
 * 而把 token 放开在 URL 上会进访问日志与浏览器历史。`POST /api/session` 用一次 token
 * 换一枚 `HttpOnly; SameSite=Strict` 的 cookie，之后：
 * - `fetch` 同源自动带上；
 * - `EventSource` 同源自动带上；
 * - 页面脚本读不到它（XSS 也偷不走），跨站请求也带不出去（SameSite=Strict 挡掉 CSRF）。
 *
 * 比较一律常数时间：token 是唯一的口令，用 `===` 比较会把长度前缀信息泄给计时攻击。
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** 会话 cookie 名 */
export const SESSION_COOKIE = 'wb_session'
/** 命令行/脚本用的请求头名（curl 与运维脚本比拼 cookie 方便） */
export const TOKEN_HEADER = 'x-workbench-token'

/** 摘要后比较：长度不同也能走 `timingSafeEqual`（它只接受等长 buffer）。 */
export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** 常数时间比较；空值一律 false（没带口令不等于口令对）。 */
export function tokenMatches(expected: string, provided: string | null | undefined): boolean {
  if (expected === '' || provided === null || provided === undefined || provided === '')
    return false
  return timingSafeEqual(tokenDigest(expected), tokenDigest(provided))
}

/** 解析 Cookie 头（只认第一段同名值；畸形百分号编码按原文处理，不当错误）。 */
export function parseCookie(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (header === null || header === undefined) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    if (name === '' || name in out) continue
    const raw = part.slice(index + 1).trim()
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      out[name] = raw
    }
  }
  return out
}

/** 从 `Authorization: Bearer <token>` 取口令。 */
export function bearerToken(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

/** 鉴权只看这三个头：服务端从 `IncomingMessage.headers` 直接传进来。 */
export interface AuthHeaders {
  cookie?: string | string[] | undefined
  authorization?: string | string[] | undefined
  [TOKEN_HEADER]?: string | string[] | undefined
}

export interface Authenticator {
  /** false = 未配置 token（仅回环监听会走到这里，见 `loadServerConfig`） */
  readonly enabled: boolean
  readonly token: string | null
  /** 这个请求是否被放行 */
  check(headers: AuthHeaders): boolean
  /** 校验一次提交上来的 token（`POST /api/session`） */
  verify(value: unknown): boolean
  /** 建立会话时回给浏览器的 `Set-Cookie` 值；未配置 token 时 null */
  sessionCookie(): string | null
  /** 退出会话用的过期 cookie */
  expiredCookie(): string
}

const first = (value: string | string[] | undefined): string | null => {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * 会话 cookie。
 *
 * `Secure` 故意不加：默认部署是回环 HTTP，加了浏览器就不会保存；放到反向代理的 HTTPS
 * 后面时由代理补 HSTS，同源 + SameSite=Strict 已经挡掉跨站提交。
 */
const cookieValue = (name: string, value: string, maxAgeSeconds: number): string =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`

/** 会话有效期：30 天（自用工作台，过期只会烦人）。 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export function createAuthenticator(
  token: string | null,
  options: { cookieName?: string } = {},
): Authenticator {
  const name = options.cookieName ?? SESSION_COOKIE
  return {
    enabled: token !== null,
    token,
    check: (headers) => {
      if (token === null) return true
      const header = first(headers[TOKEN_HEADER])
      if (tokenMatches(token, header)) return true
      const bearer = bearerToken(first(headers.authorization))
      if (tokenMatches(token, bearer)) return true
      return tokenMatches(token, parseCookie(first(headers.cookie))[name] ?? null)
    },
    verify: (value) => token !== null && typeof value === 'string' && tokenMatches(token, value),
    sessionCookie: () =>
      token === null ? null : cookieValue(name, token, SESSION_MAX_AGE_SECONDS),
    expiredCookie: () => cookieValue(name, '', 0),
  }
}
