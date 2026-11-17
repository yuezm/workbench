/**
 * 浏览器桥接：把三动词映射成同源 HTTP + SSE。
 *
 * 这里断言的是「发到哪、带什么、怎么解包、怎么分发」——传输层的细节必须收在这一个文件里，
 * 否则 app 就会重新长出自己的 fetch 调用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_PATHS } from '@workbench/protocol/http'
import {
  createWebBridge,
  establishSession,
  type EventSourceLike,
  type FetchLike,
  type FetchResponseLike,
} from '@workbench/client-bridge'

interface Call {
  url: string
  init: Parameters<FetchLike>[1]
}

const ok = (value: unknown): FetchResponseLike => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ ok: true, value }),
})

const fail = (message: string, code = 'internal'): FetchResponseLike => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ ok: false, error: { code, message } }),
})

function fakeFetch(response: FetchResponseLike | (() => Promise<FetchResponseLike>)) {
  const calls: Call[] = []
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init })
    return typeof response === 'function' ? response() : Promise.resolve(response)
  }
  return { calls, fetchImpl }
}

function fakeSource() {
  const handlers: Array<(event: { data: string }) => void> = []
  let closed = false
  const source: EventSourceLike = {
    addEventListener: (_type, handler) => handlers.push(handler),
    close: () => {
      closed = true
    },
    onerror: null,
  }
  return {
    factory: (url: string) => {
      created.push(url)
      return source
    },
    emit: (payload: unknown) => {
      for (const handler of handlers) handler({ data: JSON.stringify(payload) })
    },
    emitRaw: (data: string) => {
      for (const handler of handlers) handler({ data })
    },
    get closed() {
      return closed
    },
  }
}

const created: string[] = []

beforeEach(() => {
  created.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createWebBridge', () => {
  it('dispatch：POST 到 /api/dispatch，带 JSON 头与同源凭据，解包 value', async () => {
    const { calls, fetchImpl } = fakeFetch(ok({ facts: [], value: { id: 't1' } }))
    const bridge = createWebBridge({ fetch: fetchImpl })
    const result = await bridge.dispatch({
      type: 'task.create',
      commandId: 'c1',
    } as unknown as Parameters<typeof bridge.dispatch>[0])
    expect(result).toEqual({ facts: [], value: { id: 't1' } })
    expect(calls[0]?.url).toBe(API_PATHS.dispatch)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(calls[0]?.init.credentials).toBe('same-origin')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      command: { type: 'task.create', commandId: 'c1' },
    })
  })

  it('query：带 params 原样转发；不带则省略该字段', async () => {
    const { calls, fetchImpl } = fakeFetch(ok([]))
    const bridge = createWebBridge({ fetch: fetchImpl })
    await bridge.query('tasks.byWorkflow', { workflowId: 'w1' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      view: 'tasks.byWorkflow',
      params: { workflowId: 'w1' },
    })
    await bridge.query('workflows.all')
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ view: 'workflows.all' })
  })

  it('错误信封：抛出可读 Error（app 的 catch 直接展示）', async () => {
    const { fetchImpl } = fakeFetch(fail('冲突：任务已被领取', 'conflict'))
    const bridge = createWebBridge({ fetch: fetchImpl })
    await expect(bridge.query('workflows.all')).rejects.toThrow('冲突：任务已被领取')
  })

  it('意外响应：带 HTTP 状态码报错，而不是静默返回 undefined', async () => {
    const notEnvelope = fakeFetch({
      ok: true,
      status: 502,
      json: () => Promise.resolve({ hello: 'world' }),
    })
    await expect(createWebBridge({ fetch: notEnvelope.fetchImpl }).info()).rejects.toThrow(
      /HTTP 502/u,
    )

    const broken = fakeFetch({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    })
    await expect(createWebBridge({ fetch: broken.fetchImpl }).info()).rejects.toThrow(/无法解析/u)
  })

  it('listDirs：path 做 URL 编码；缺省只发路径本身', async () => {
    const { calls, fetchImpl } = fakeFetch(ok({ path: '/', parent: null, entries: [] }))
    const bridge = createWebBridge({ fetch: fetchImpl })
    await bridge.listDirs('/home/me/项目 A')
    expect(calls[0]?.url).toBe(`${API_PATHS.dirs}?path=%2Fhome%2Fme%2F%E9%A1%B9%E7%9B%AE%20A`)
    await bridge.listDirs()
    expect(calls[1]?.url).toBe(API_PATHS.dirs)
    expect(calls[1]?.init.method).toBe('GET')
  })

  it('lark：把动作包进 {action}，返回该动作的结果', async () => {
    const { calls, fetchImpl } = fakeFetch(ok({ ok: true }))
    const bridge = createWebBridge({ fetch: fetchImpl })
    await bridge.lark({ action: 'status' })
    expect(calls[0]?.url).toBe(API_PATHS.lark)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: { action: 'status' } })
  })

  it('notify：发完就忘——失败不打断调用方', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Promise.reject(new Error('offline')))
    const bridge = createWebBridge({ fetch: fetchImpl })
    expect(() => bridge.notify('番茄时钟', '休息一下')).not.toThrow()
    await Promise.resolve()
    expect(calls[0]?.url).toBe(API_PATHS.notify)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      title: '番茄时钟',
      body: '休息一下',
    })
  })

  it('subscribe / onNotice：同一条 SSE 按 kind 分流，畸形 JSON 忽略', () => {
    const source = fakeSource()
    const { fetchImpl } = fakeFetch(ok(null))
    const bridge = createWebBridge({
      fetch: fetchImpl,
      createEventSource: source.factory,
    })
    const onFacts = vi.fn()
    const onNotice = vi.fn()
    const offFacts = bridge.subscribe(onFacts)
    const offNotice = bridge.onNotice(onNotice)

    // 懒开：第一次订阅才连，且只连一条
    expect(created).toEqual([API_PATHS.events])

    source.emit({ kind: 'facts', seq: 7, types: ['task.created'] })
    expect(onFacts).toHaveBeenCalledWith({ kind: 'facts', seq: 7, types: ['task.created'] })
    expect(onNotice).not.toHaveBeenCalled()

    source.emit({ kind: 'notice', title: '任务完成', body: '' })
    expect(onNotice).toHaveBeenCalledWith({ kind: 'notice', title: '任务完成', body: '' })
    expect(onFacts).toHaveBeenCalledTimes(1)

    source.emitRaw('{not json')
    expect(onFacts).toHaveBeenCalledTimes(1)

    offFacts()
    offNotice()
    source.emit({ kind: 'facts', seq: 8, types: [] })
    expect(onFacts).toHaveBeenCalledTimes(1)
  })

  it('缺省传输：用全局 fetch 与全局 EventSource（浏览器里就是这样跑的）', async () => {
    const fetchMock = vi.fn(async () => ok([]))
    vi.stubGlobal('fetch', fetchMock)
    const instances: string[] = []
    class FakeEventSource {
      onerror: ((event: unknown) => void) | null = null
      constructor(url: string) {
        instances.push(url)
      }
      addEventListener(): void {
        // 真实 EventSource 在这里注册 message 监听；本用例只关心「连了哪条地址」
      }
      close(): void {
        // 页面生命周期内不关
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)

    const bridge = createWebBridge()
    await bridge.query('workflows.all')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    bridge.onNotice(() => undefined)
    expect(instances).toEqual([API_PATHS.events])
  })

  it('baseUrl：所有请求都拼在它后面（反向代理挂在子路径时用）', async () => {
    const { calls, fetchImpl } = fakeFetch(ok([]))
    const bridge = createWebBridge({ fetch: fetchImpl, baseUrl: '/workbench' })
    await bridge.query('workflows.all')
    expect(calls[0]?.url).toBe(`/workbench${API_PATHS.query}`)
  })
})

describe('establishSession', () => {
  it('口令对：POST /api/session 并返回 true', async () => {
    const { calls, fetchImpl } = fakeFetch(ok({ established: true }))
    expect(await establishSession('k'.repeat(32), { fetch: fetchImpl })).toBe(true)
    expect(calls[0]?.url).toBe(API_PATHS.session)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ token: 'k'.repeat(32) })
  })

  it('没口令 / 口令错：返回 false（入口据此决定是否弹登录）', async () => {
    const { fetchImpl } = fakeFetch(fail('token 不正确', 'unauthorized'))
    expect(await establishSession(null, { fetch: fetchImpl })).toBe(false)
  })
})
