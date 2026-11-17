// @vitest-environment node
/**
 * HTTP 接口契约：真起一个 `node:http` 服务（端口 0），用真请求断言——
 * 鉴权、信封、错误码、静态托管、SSE 推送与跨站拒绝。
 *
 * 假装配只实现路由/飞书/事件流这几条接缝；契约就是「连接行为」，用假对象证不了。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirListing, ServerInfo } from '@workbench/protocol/http'
import type { CommandRouter } from '@workbench/host/commands'
import { createAuthenticator, SESSION_COOKIE } from '@workbench/api-http/auth'
import { createEventStream, type EventStream } from '@workbench/api-http/event-stream'
import { isSameOrigin, readJsonBody, startWebServer, type ApiDeps } from '@workbench/api-http/http'
import { StoreError } from '@workbench/host-store/index'

const TOKEN = 'k'.repeat(32)
const INFO: ServerInfo = {
  name: 'workbench',
  version: '2.0.0',
  kernelVersion: 'M47.0.0',
  dataDir: '/data',
  defaultWorkdir: '/work',
  startedAt: '2026-11-16T00:00:00.000Z',
  clients: 0,
  pid: 123,
}

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  base: string
  deps: ApiDeps
  events: EventStream
  close: () => Promise<void>
  webDir: string
}

async function harness(
  overrides: Partial<ApiDeps> = {},
  token: string | null = null,
): Promise<Harness> {
  // Web 产物目录：一个 index.html + 一个带指纹的 js + 一个越界目标
  const webDir = mkdtempSync(path.join(tmpdir(), 'wb-web-'))
  created.push(webDir)
  mkdirSync(path.join(webDir, 'assets'))
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Workbench</title>')
  writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)')

  const router: CommandRouter = {
    dispatch: vi.fn(async (command: unknown) => {
      if ((command as { type?: string }).type === 'boom') throw new StoreError('conflict', '冲突')
      return { facts: [{ seq: 1, type: 'task.created', at: 't' }], value: { id: 'x' } }
    }),
    query: vi.fn(async (view: unknown) =>
      view === 'broken' ? Promise.reject(new Error('读失败')) : [],
    ),
  } as unknown as CommandRouter

  const events = createEventStream()
  const deps: ApiDeps = {
    auth: createAuthenticator(token),
    router,
    notify: vi.fn(),
    events,
    listDirs: vi.fn((): DirListing => ({
      path: '/picked',
      parent: '/',
      roots: ['/'],
      entries: [],
    })),
    info: () => INFO,
    webDir,
    ...overrides,
  }
  const server = await startWebServer(
    { ...deps, log: () => undefined },
    { host: '127.0.0.1', port: 0 },
  )
  return {
    base: `http://127.0.0.1:${server.port}`,
    deps,
    events,
    webDir,
    close: () => server.close(),
  }
}

const post = (h: Harness, pathname: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(h.base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('健康检查与信封', () => {
  it('GET /api/health：不鉴权，回客户端数', async () => {
    const h = await harness({}, TOKEN)
    const res = await fetch(h.base + '/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, value: { status: 'ok', clients: 0 } })
    await h.close()
  })

  it('GET /api/info：未配置 token 时直接可读', async () => {
    const h = await harness()
    const res = await fetch(h.base + '/api/info')
    expect(await res.json()).toEqual({ ok: true, value: INFO })
    await h.close()
  })

  it('未知接口 / 方法不对：404 且带可读文案', async () => {
    const h = await harness()
    const unknown = await fetch(h.base + '/api/nope')
    expect(unknown.status).toBe(404)
    expect((await unknown.json()) as { ok: boolean }).toMatchObject({ ok: false })
    const wrongMethod = await fetch(h.base + '/api/dispatch')
    expect(wrongMethod.status).toBe(404)
    await h.close()
  })
})

describe('鉴权与会话', () => {
  it('要 token 时：没带口令 401；口令错 401', async () => {
    const h = await harness({}, TOKEN)
    const anonymous = await fetch(h.base + '/api/info')
    expect(anonymous.status).toBe(401)
    const wrong = await post(h, '/api/session', { token: 'nope' })
    expect(wrong.status).toBe(401)
    await h.close()
  })

  it('POST /api/session：口令对就下发 HttpOnly 会话 cookie，之后带 cookie 可读', async () => {
    const h = await harness({}, TOKEN)
    const session = await post(h, '/api/session', { token: TOKEN })
    expect(session.status).toBe(200)
    const cookie = session.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    const ok = await fetch(h.base + '/api/info', {
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    })
    expect(ok.status).toBe(200)
    await h.close()
  })

  it('请求头与 Bearer 两种带法都放行', async () => {
    const h = await harness({}, TOKEN)
    const header = await fetch(h.base + '/api/info', { headers: { 'x-workbench-token': TOKEN } })
    expect(header.status).toBe(200)
    const bearer = await fetch(h.base + '/api/info', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(bearer.status).toBe(200)
    await h.close()
  })

  it('跨站写请求拒绝（Origin 与 Host 不一致 → 403）', async () => {
    const h = await harness()
    const res = await post(
      h,
      '/api/dispatch',
      { command: { type: 'task.create' } },
      {
        origin: 'https://evil.example',
      },
    )
    expect(res.status).toBe(403)
    await h.close()
  })
})

describe('三动词与错误', () => {
  it('dispatch：回事实与实体值', async () => {
    const h = await harness()
    const res = await post(h, '/api/dispatch', { command: { type: 'task.create' } })
    expect(await res.json()).toEqual({
      ok: true,
      value: { facts: [{ seq: 1, type: 'task.created', at: 't' }], value: { id: 'x' } },
    })
    await h.close()
  })

  it('dispatch：缺 command → 400；非法 JSON → 400；StoreError → 500 带 code', async () => {
    const h = await harness()
    expect((await post(h, '/api/dispatch', {})).status).toBe(400)
    expect((await post(h, '/api/dispatch', '{oops')).status).toBe(400)
    const conflict = await post(h, '/api/dispatch', { command: { type: 'boom' } })
    expect(conflict.status).toBe(500)
    expect((await conflict.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    })
    await h.close()
  })

  it('dispatch：超过 1 MiB 立刻 413', async () => {
    const h = await harness()
    const huge = JSON.stringify({ command: { type: 'x', blob: 'a'.repeat(1024 * 1024 + 10) } })
    const res = await post(h, '/api/dispatch', huge)
    expect(res.status).toBe(413)
    await h.close()
  })

  it('query：缺 view → 400；路由抛错 → 500（默认 internal）', async () => {
    const h = await harness()
    expect((await post(h, '/api/query', {})).status).toBe(400)
    const failed = await post(h, '/api/query', { view: 'broken' })
    expect(failed.status).toBe(500)
    expect((await failed.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'internal' },
    })
    await h.close()
  })

  it('lark：未装配 → 501；动作非法 → 400；正常动作透传', async () => {
    const bare = await harness()
    expect((await post(bare, '/api/lark', { action: { action: 'status' } })).status).toBe(501)
    await bare.close()

    const lark = {
      status: async () => ({ ok: true }),
      addProfile: vi.fn(),
      loginStart: vi.fn(),
      loginPoll: vi.fn(),
      logout: vi.fn(),
      removeProfile: vi.fn(),
    } as unknown as ApiDeps['lark']
    const h = await harness({ lark })
    expect((await post(h, '/api/lark', { action: null })).status).toBe(400)
    const ok = await post(h, '/api/lark', { action: { action: 'status' } })
    expect(ok.status).toBe(200)
    await h.close()
  })

  it('notify：缺 title → 400；正常 → 调注入的知会并回 sent', async () => {
    const notify = vi.fn()
    const h = await harness({ notify })
    expect((await post(h, '/api/notify', { title: '  ' })).status).toBe(400)
    const res = await post(h, '/api/notify', { title: '任务失败', body: '3 个任务失败' })
    expect(await res.json()).toEqual({ ok: true, value: { sent: true } })
    expect(notify).toHaveBeenCalledWith({ title: '任务失败', body: '3 个任务失败' })
    await h.close()
  })

  it('fs/dirs：把 path 参数解出来交给注入的列目录；缺省不传', async () => {
    const listDirs = vi.fn(() => ({ path: '/picked', parent: '/', roots: ['/'], entries: [] }))
    const h = await harness({ listDirs })
    await fetch(h.base + '/api/fs/dirs?path=%2Fhome%2Fme')
    expect(listDirs).toHaveBeenCalledWith('/home/me')
    await fetch(h.base + '/api/fs/dirs')
    expect(listDirs).toHaveBeenCalledWith(undefined)
    await h.close()
  })
})

describe('SSE', () => {
  it('接上后收到 retry 与广播的 data 段；断开即从 hub 摘掉', async () => {
    const h = await harness()
    const controller = new AbortController()
    const res = await fetch(h.base + '/api/events', { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('没有 body')
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('retry:')
    expect(h.events.size).toBe(1)

    h.events.publish({ kind: 'facts', seq: 2, types: ['task.created'] })
    const second = await reader.read()
    const text = new TextDecoder().decode(second.value)
    expect(text).toContain('"kind":"facts"')
    expect(text).toContain('"seq":2')

    controller.abort()
    await vi.waitFor(() => expect(h.events.size).toBe(0))
    await h.close()
  })
})

describe('静态托管', () => {
  it('/ 回 index.html（no-cache）；带指纹的资源长缓存', async () => {
    const h = await harness()
    const index = await fetch(h.base + '/')
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('Workbench')
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.headers.get('cache-control')).toBe('no-cache')

    const asset = await fetch(h.base + '/assets/app.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    await h.close()
  })

  it('不存在的文件：404；深链回落 index.html；无非 GET/HEAD', async () => {
    const h = await harness()
    expect((await fetch(h.base + '/missing.js')).status).toBe(404)
    const deep = await fetch(h.base + '/tasks/42')
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('Workbench')
    const post = await fetch(h.base + '/index.html', { method: 'POST' })
    expect(post.status).toBe(405)
    await h.close()
  })

  it('产物目录不存在：给 404 和可读提示（不白屏也不 500）', async () => {
    const h = await harness({ webDir: path.join(tmpdir(), 'wb-missing-web') })
    const res = await fetch(h.base + '/')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('Web 产物目录')
    await h.close()
  })
})

describe('辅助函数', () => {
  it('isSameOrigin：没有 Origin 算同源；有则必须与 Host 一致', () => {
    const req = (headers: Record<string, string>) =>
      ({ headers }) as unknown as Parameters<typeof isSameOrigin>[0]
    expect(isSameOrigin(req({}))).toBe(true)
    expect(isSameOrigin(req({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }))).toBe(
      true,
    )
    expect(isSameOrigin(req({ origin: 'https://evil.example', host: '127.0.0.1:3000' }))).toBe(
      false,
    )
    expect(isSameOrigin(req({ origin: 'http://x' }))).toBe(false)
    expect(isSameOrigin(req({ origin: 'not-a-url', host: 'h' }))).toBe(false)
  })

  it('readJsonBody：空体返回 null，合法 JSON 原样解析', async () => {
    const make = (text: string) =>
      ({
        async *[Symbol.asyncIterator]() {
          if (text !== '') yield Buffer.from(text)
        },
      }) as unknown as Parameters<typeof readJsonBody>[0]
    expect(await readJsonBody(make(''))).toBeNull()
    expect(await readJsonBody(make('{"a":1}'))).toEqual({ a: 1 })
  })
})
