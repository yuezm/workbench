// @vitest-environment node
/**
 * HTTP 接口契约：真起一个 `node:http` 服务（端口 0），用真请求断言——
 * 鉴权、信封、错误码、静态托管、SSE 推送与跨站拒绝。
 *
 * 假装配只实现路由/飞书/事件流这几条接缝；契约就是「连接行为」，用假对象证不了。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirListing, ServerInfo } from '@workbench/protocol/http'
import type { CommandRouter } from '@workbench/host/commands'
import { createAuthenticator, SESSION_COOKIE } from '@workbench/api-http/auth'
import { createEventStream, type EventStream } from '@workbench/api-http/event-stream'
import {
  closeServer,
  createRequestHandler,
  isSameOrigin,
  readJsonBody,
  startWebServer,
  type ApiDeps,
  type RequestHandlerDeps,
} from '@workbench/api-http/http'
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
  closeGraceMs?: number,
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
    { host: '127.0.0.1', port: 0, closeGraceMs },
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

  it('POST /api/session：鉴权实现不给 cookie（仅请求头模式）时照常回 established，不下发 Set-Cookie', async () => {
    // 只校验、不建会话的实现（例如运维脚本/请求头 token 模式）：必须允许
    const headerOnly = {
      enabled: true,
      token: 'k',
      check: () => true,
      verify: () => true,
      sessionCookie: () => null,
      expiredCookie: () => `${SESSION_COOKIE}=; Max-Age=0`,
    }
    const h = await harness({ auth: headerOnly })
    const res = await post(h, '/api/session', { token: 'k' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, value: { established: true } })
    expect(res.headers.get('set-cookie')).toBeNull()
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

  it('close：SSE 还连着也不无限等，宽限到点强制断开', async () => {
    const h = await harness({}, null, 30)
    const controller = new AbortController()
    const res = await fetch(h.base + '/api/events', { signal: controller.signal })
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('没有 body')
    await reader.read()

    const startedAt = Date.now()
    await h.close()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    controller.abort()
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

  it('readJsonBody：分块不是 Buffer（Uint8Array / 字符串）时先转成 Buffer 再拼', async () => {
    const make = (chunks: unknown[]) =>
      ({
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }) as unknown as Parameters<typeof readJsonBody>[0]
    expect(await readJsonBody(make([new TextEncoder().encode('{"a":'), '1}']))).toEqual({ a: 1 })
  })
})

describe('纯 API 模式（没有 Web 产物）', () => {
  it('根路径回 200 纯文本说明；其它路径照常 404 并说清是纯 API 模式', async () => {
    const h = await harness({ webDir: null })
    const root = await fetch(h.base + '/')
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain('text/plain')
    const text = await root.text()
    expect(text).toContain('纯 API 模式')
    expect(text).toContain(`${INFO.name} ${INFO.version}`)
    expect(text).toContain(INFO.dataDir)

    const missing = await fetch(h.base + '/tasks/42')
    expect(missing.status).toBe(404)
    const body = (await missing.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toContain('纯 API 模式')
    await h.close()
  })
})

describe('静态托管的边角', () => {
  it('越界路径：解析即拒（null）→ 404「路径非法」，不会读到产物目录外', async () => {
    const h = await harness()
    const res = await fetch(h.base + '/%2e%2e%2fsecret')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('路径非法')
    await h.close()
  })

  it('路径命中一个目录（存在但不是文件）：当作未命中 → 404', async () => {
    const h = await harness()
    mkdirSync(path.join(h.webDir, 'styles.css'))
    const res = await fetch(h.base + '/styles.css')
    expect(res.status).toBe(404)
    await h.close()
  })

  it('产物目录在两次判定之间变成 null（运行期关闭界面）：按 404 处理，不写静态响应', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'wb-flip-'))
    created.push(webDir)
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Workbench</title>')
    let reads = 0
    // webDir 是装配根的读属性：这里模拟「读到第二次时已被置空」的切换窗口
    const deps: RequestHandlerDeps = {
      auth: createAuthenticator(null),
      router: { dispatch: vi.fn(), query: vi.fn() } as unknown as CommandRouter,
      notify: vi.fn(),
      events: createEventStream(),
      listDirs: () => ({ path: '/', parent: null, roots: ['/'], entries: [] }),
      info: () => INFO,
      log: () => undefined,
      get webDir(): string | null {
        reads += 1
        return reads === 2 ? webDir : null
      },
    }
    const server = await startWebServer(deps, { host: '127.0.0.1', port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/app.js`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        '纯 API 模式',
      )
    } finally {
      await server.close()
    }
  })
})

describe('三动词的其余口径', () => {
  it('query：视图正常时回路由结果（成功路径也要走通）', async () => {
    const h = await harness()
    const res = await post(h, '/api/query', { view: 'tasks.active' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, value: [] })
    await h.close()
  })

  it('notify：title 不是字符串 → 400；body 省略时按空串广播', async () => {
    const notify = vi.fn()
    const h = await harness({ notify })
    expect((await post(h, '/api/notify', { body: '只有正文' })).status).toBe(400)
    await post(h, '/api/notify', { title: '任务完成' })
    expect(notify).toHaveBeenCalledWith({ title: '任务完成', body: '' })
    await h.close()
  })

  it('POST /api/session：跨站来源 403（会话建立也要同源）', async () => {
    const h = await harness({}, TOKEN)
    const res = await post(h, '/api/session', { token: TOKEN }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    await h.close()
  })
})

describe('错误兜底与收尾（createRequestHandler / closeServer / startWebServer）', () => {
  const handlerDeps = (overrides: Partial<RequestHandlerDeps> = {}): RequestHandlerDeps => ({
    auth: createAuthenticator(null),
    router: { dispatch: vi.fn(), query: vi.fn() } as unknown as CommandRouter,
    notify: vi.fn(),
    events: createEventStream(),
    listDirs: () => ({ path: '/', parent: null, roots: ['/'], entries: [] }),
    info: () => INFO,
    webDir: null,
    ...overrides,
  })

  it('未捕获的非 Error 异常：默认日志兜底，req 缺 method/url 时用 GET / 记账并回 500', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      let writeHeadCalls = 0
      const res = {
        headersSent: false,
        writeHead: vi.fn(() => {
          writeHeadCalls += 1
          // 第一次（发送纯 API 说明）就炸，且抛的是字符串而不是 Error
          if (writeHeadCalls === 1) {
            const raw: unknown = '磁盘炸了'
            throw raw
          }
          return res
        }),
        end: vi.fn(),
      } as unknown as ServerResponse
      const req = { headers: {} } as unknown as IncomingMessage
      // 不注入 log：走 createRequestHandler 的缺省 logger（console.error）
      const handler = createRequestHandler(handlerDeps())
      handler(req, res)
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))
      expect(String(errorSpy.mock.calls[0]?.[0])).toBe('[http] GET / 失败：磁盘炸了')
      // 信封仍按 internal 回出去（writeHead 第二次成功）
      expect(res.end).toHaveBeenCalledWith(
        JSON.stringify({ ok: false, error: { code: 'internal', message: '磁盘炸了' } }),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('响应头已发出后再出错：只结束响应，不再写第二个信封', async () => {
    const log = vi.fn()
    const res = {
      headersSent: true,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse
    const req = { headers: {}, url: '/api/nope', method: 'GET' } as unknown as IncomingMessage
    createRequestHandler(handlerDeps({ log }))(req, res)
    await vi.waitFor(() => expect(res.end).toHaveBeenCalledTimes(1))
    expect(res.end).toHaveBeenCalledWith()
    expect(res.writeHead).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('closeServer：没在监听时直接 resolve（重复收尾不挂起）', async () => {
    const server = createServer()
    await expect(closeServer(server, 50)).resolves.toBeUndefined()
  })

  it('closeServer：宽限回调被假时钟同步触发时，句柄尚未赋值也能收尾（不重复清表）', async () => {
    const events: string[] = []
    const fakeServer = {
      listening: true,
      close: (callback?: () => void) => {
        events.push('close')
        callback?.()
        return fakeServer
      },
      closeIdleConnections: () => events.push('idle'),
      closeAllConnections: () => events.push('all'),
    } as unknown as import('node:http').Server
    const clearIntervalStub = vi.fn()
    vi.stubGlobal('setInterval', () => ({ unref: () => undefined }))
    vi.stubGlobal('clearInterval', clearIntervalStub)
    // 假时钟：setTimeout 直接跑回调（此时 grace 变量还没拿到句柄）
    vi.stubGlobal('setTimeout', (callback: () => void) => {
      callback()
      return { unref: () => undefined }
    })
    try {
      await expect(closeServer(fakeServer, 10)).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(events).toContain('all')
    expect(events).toContain('close')
    expect(clearIntervalStub).toHaveBeenCalledTimes(1)
  })

  it('startWebServer：端口被占用时 reject（error 事件摘掉 listening 监听）', async () => {
    const h = await harness()
    const port = Number(new URL(h.base).port)
    await expect(
      startWebServer({ ...h.deps, log: () => undefined }, { host: '127.0.0.1', port }),
    ).rejects.toThrow()
    await h.close()
  })
})
