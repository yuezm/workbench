// @vitest-environment node
/**
 * 静态资源解析：URL → 产物文件，路径穿越一律拒绝。
 *
 * 这是把 Web 产物暴露到网络上的唯一入口，越界读文件（`../../etc/passwd`、`%2e%2e%2f`）
 * 必须在这里就被挡掉，而不是指望上层再检查一遍。
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  FALLBACK_CONTENT_TYPE,
  cacheControlOf,
  contentTypeOf,
  resolveStaticFile,
} from '../../src/server/static'

const ROOT = path.resolve('/app/out/web')

describe('resolveStaticFile', () => {
  it('/ 映射到 index.html，普通文件按路径解析', () => {
    expect(resolveStaticFile(ROOT, '/')).toBe(path.join(ROOT, 'index.html'))
    expect(resolveStaticFile(ROOT, '/assets/app.js')).toBe(path.join(ROOT, 'assets', 'app.js'))
  })

  it('不带扩展名的深链回落到 index.html（刷新页面不回 404）', () => {
    expect(resolveStaticFile(ROOT, '/tasks/42')).toBe(path.join(ROOT, 'index.html'))
  })

  it('路径穿越：明文与编码两种写法都拒绝', () => {
    for (const bad of [
      '/../secret',
      '/assets/../../secret',
      '/%2e%2e%2fsecret',
      '/%2e%2e/%2e%2e/secret',
      '/a/%00b',
    ]) {
      const resolved = resolveStaticFile(ROOT, bad)
      expect(resolved === null || resolved.startsWith(ROOT + path.sep), bad).toBe(true)
    }
    expect(resolveStaticFile(ROOT, '/%2e%2e%2fsecret')).toBeNull()
    expect(resolveStaticFile(ROOT, '/a%00b')).toBeNull()
  })

  it('畸形百分号编码：拒绝而不是抛错', () => {
    expect(resolveStaticFile(ROOT, '/%E0%A4%A')).toBeNull()
  })
})

describe('contentTypeOf / cacheControlOf', () => {
  it('常见产物类型都有正确 MIME，未知按二进制流', () => {
    expect(contentTypeOf('index.html')).toContain('text/html')
    expect(contentTypeOf('app.js')).toContain('text/javascript')
    expect(contentTypeOf('app.css')).toContain('text/css')
    expect(contentTypeOf('a.WOFF2')).toBe('font/woff2')
    expect(contentTypeOf('data.bin')).toBe(FALLBACK_CONTENT_TYPE)
  })

  it('HTML 不缓存，其余长缓存（产物文件名带指纹）', () => {
    expect(cacheControlOf('index.html')).toBe('no-cache')
    expect(cacheControlOf('assets/app-abc.js')).toContain('immutable')
  })
})
