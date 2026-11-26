// @vitest-environment node
/**
 * 静态资源解析：URL → 产物文件，路径穿越一律拒绝。
 *
 * 这是把 Web 产物暴露到网络上的唯一入口，越界读文件（`../../etc/passwd`、`%2e%2e%2f`）
 * 必须在这里就被挡掉，而不是指望上层再检查一遍。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  FALLBACK_CONTENT_TYPE,
  cacheControlOf,
  contentTypeOf,
  resolveStaticFile,
  resolveWebUi,
} from '@workbench/host-frontend-static'

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

describe('resolveWebUi（本次启动挂不挂界面）', () => {
  it('UI=off：显式关掉，连产物目录都不看', () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'wb-webui-on-'))
    try {
      writeFileSync(path.join(webDir, 'index.html'), '<title>Workbench</title>')
      expect(resolveWebUi({ webDir, ui: 'off' })).toEqual({
        dir: null,
        reason: 'WORKBENCH_UI=off',
      })
    } finally {
      rmSync(webDir, { recursive: true, force: true })
    }
  })

  it('有 index.html：托管这个目录（reason 就是目录本身，启动行直接读它）', () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'wb-webui-auto-'))
    try {
      writeFileSync(path.join(webDir, 'index.html'), '<title>Workbench</title>')
      for (const ui of ['auto', 'on'] as const) {
        expect(resolveWebUi({ webDir, ui }), ui).toEqual({ dir: webDir, reason: webDir })
      }
    } finally {
      rmSync(webDir, { recursive: true, force: true })
    }
  })

  it('没有产物：纯 API 模式，reason 说清缺哪个文件、怎么补（不抛错、不阻断启动）', () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'wb-webui-empty-'))
    try {
      const result = resolveWebUi({ webDir, ui: 'auto' })
      expect(result.dir).toBeNull()
      expect(result.reason).toContain('没有找到 Web 产物')
      expect(result.reason).toContain(path.join(webDir, 'index.html'))
      expect(result.reason).toContain('pnpm build:web')
      // 声明了 on 也照跑：缺产物只是没有界面
      expect(resolveWebUi({ webDir, ui: 'on' }).dir).toBeNull()
    } finally {
      rmSync(webDir, { recursive: true, force: true })
    }
  })
})
