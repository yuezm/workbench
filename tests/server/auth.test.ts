// @vitest-environment node
/**
 * 服务端鉴权：一个共享 token，三种带法（请求头 / Bearer / HttpOnly cookie）。
 *
 * 断言口径：没带口令不等于口令对；错口令一律拒绝；cookie 必须带 HttpOnly + SameSite=Strict
 * （前者防 XSS 偷，后者防跨站提交）。
 */
import { describe, expect, it } from 'vitest'
import {
  SESSION_COOKIE,
  TOKEN_HEADER,
  bearerToken,
  createAuthenticator,
  parseCookie,
  tokenDigest,
  tokenMatches,
} from '../../src/server/auth'

const TOKEN = 't'.repeat(32)

describe('tokenMatches / tokenDigest', () => {
  it('相同 token 通过；不同 / 空值一律不通过', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches(TOKEN, `${TOKEN}x`)).toBe(false)
    expect(tokenMatches(TOKEN, '')).toBe(false)
    expect(tokenMatches(TOKEN, null)).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
  })

  it('摘要长度固定：不等长输入也能走常数时间比较', () => {
    expect(tokenDigest('a').length).toBe(32)
    expect(tokenDigest(TOKEN).length).toBe(32)
  })
})

describe('parseCookie / bearerToken', () => {
  it('解析同名只取第一个值，畸形百分号按原文', () => {
    expect(parseCookie(`${SESSION_COOKIE}=a; other=b; ${SESSION_COOKIE}=c`)).toEqual({
      [SESSION_COOKIE]: 'a',
      other: 'b',
    })
    expect(parseCookie('bad=%E0%A4%A')).toEqual({ bad: '%E0%A4%A' })
    expect(parseCookie('=empty; novalue')).toEqual({})
    expect(parseCookie(undefined)).toEqual({})
  })

  it('只认 Bearer 前缀（大小写不敏感），其余为空', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer  abc ')).toBe('abc')
    expect(bearerToken('Token abc')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })
})

describe('createAuthenticator', () => {
  it('未配置 token：全部放行，但 verify 恒为 false（没有口令可对）', () => {
    const auth = createAuthenticator(null)
    expect(auth.enabled).toBe(false)
    expect(auth.check({})).toBe(true)
    expect(auth.verify(TOKEN)).toBe(false)
    expect(auth.sessionCookie()).toBeNull()
  })

  it('三种带法都通过：自定义头、Bearer、cookie', () => {
    const auth = createAuthenticator(TOKEN)
    expect(auth.enabled).toBe(true)
    expect(auth.check({ [TOKEN_HEADER]: TOKEN })).toBe(true)
    expect(auth.check({ authorization: `Bearer ${TOKEN}` })).toBe(true)
    expect(auth.check({ cookie: `${SESSION_COOKIE}=${TOKEN}` })).toBe(true)
  })

  it('数组形式的重复头取第一个；没有口令或口令错都拒绝', () => {
    const auth = createAuthenticator(TOKEN)
    expect(auth.check({ [TOKEN_HEADER]: [TOKEN, 'other'] })).toBe(true)
    expect(auth.check({ [TOKEN_HEADER]: ['other', TOKEN] })).toBe(false)
    expect(auth.check({})).toBe(false)
    expect(auth.check({ cookie: `${SESSION_COOKIE}=wrong` })).toBe(false)
    expect(auth.check({ authorization: `Bearer wrong` })).toBe(false)
  })

  it('verify：只接受字符串且必须相同', () => {
    const auth = createAuthenticator(TOKEN)
    expect(auth.verify(TOKEN)).toBe(true)
    expect(auth.verify('wrong')).toBe(false)
    expect(auth.verify(42)).toBe(false)
    expect(auth.verify(undefined)).toBe(false)
  })

  it('会话 cookie：HttpOnly + SameSite=Strict + Path=/，值做 URL 编码', () => {
    const auth = createAuthenticator('a b/c')
    const cookie = auth.sessionCookie() ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE}=a%20b%2Fc`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(auth.expiredCookie()).toContain('Max-Age=0')
  })

  it('自定义 cookie 名：check 与 sessionCookie 用同一个名字', () => {
    const auth = createAuthenticator(TOKEN, { cookieName: 'custom' })
    expect(auth.sessionCookie()).toContain('custom=')
    expect(auth.check({ cookie: `custom=${TOKEN}` })).toBe(true)
    expect(auth.check({ cookie: `${SESSION_COOKIE}=${TOKEN}` })).toBe(false)
  })
})
