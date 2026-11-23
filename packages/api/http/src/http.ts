/**
 * HTTP 接口（服务端）：三动词 + 会话 + 目录浏览 + SSE + 静态托管，全部在一个同源服务上。
 *
 * 为什么手写 `node:http` 路由而不上框架：接口一共 8 条，语义都是「读 JSON、调宿主、回 JSON」，
 * 框架带来的中间件生态在这里没有用武之地，却会增加一个运行时依赖和一层看不见的错误处理。
 *
 * 统一约定：
 * - `/api` 下除 `health` / `session` 外都要鉴权（`auth.check`）；
 * - 所有应答都是 `IpcResponse` 信封（`{ok:true,value}` / `{ok:false,error}`），
 *   浏览器侧的解包逻辑与旧 IPC 完全一致；
 * - 请求体上限 1 MiB，非法 JSON 回 400，异常只回 `{code,message}`，不回栈；
 * - 有 `Origin` 头的写请求必须同源（cookie 鉴权 + SameSite 之后的第二道闸）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import {
  API_PATHS,
  MAX_BODY_BYTES,
  type DirListing,
  type LarkRequest,
  type NotifyRequest,
  type ServerInfo,
  type SessionRequest,
} from '@workbench/protocol/http'
import type { IpcResponse } from '@workbench/protocol/ipc'
import type { CommandRouter } from '@workbench/host/commands'
import { asLarkAction, runLarkAction, type LarkAdmin } from '@workbench/host/lark-admin'
import { StoreError } from '@workbench/host-store/index'
import type { Authenticator } from './auth'
import type { EventStream } from './event-stream'
import { cacheControlOf, contentTypeOf, resolveStaticFile } from '@workbench/host-frontend-static'

/** HTTP 错误：状态码 + 机读 code + 人话 message */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface ApiDeps {
  auth: Authenticator
  router: CommandRouter
  /** 飞书连接管理：未装配时 `/api/lark` 回可读错误 */
  lark?: LarkAdmin
  /** 通用知会（宿主 outcome 通知）：广播给所有在线页面 */
  notify(payload: NotifyRequest): void
  events: EventStream
  listDirs(target?: string): DirListing
  info(): ServerInfo
  /** Web 产物目录（`out/web`）；null = 纯 API 模式（不托管静态资源） */
  webDir: string | null
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

const sendValue = <T>(res: ServerResponse, value: T, status = 200): void => {
  const body: IpcResponse<T> = { ok: true, value }
  sendJson(res, status, body)
}

/** 异常 → 信封。`StoreError` 的 code 原样透出（前端按 code 分支），其余归 `internal`。 */
const sendError = (res: ServerResponse, error: unknown): void => {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const code = error instanceof StoreError ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { ok: false, error: { code, message } })
}

/**
 * 读 JSON 请求体。
 *
 * 空体返回 null（`/api/notify` 之类允许省略）；超限立刻 413 并停止继续读——
 * 不先把大包收完再判断，免得一个恶意请求把内存占满。
 */
export async function readJsonBody(
  req: IncomingMessage,
  limit: number = MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new HttpError(413, 'payload_too_large', `请求体超过 ${limit} 字节`)
    chunks.push(buffer)
  }
  if (size === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON')
  }
}

/** 同源判定：没有 `Origin`（curl / 服务端自检）算同源；有就必须与 `Host` 一致。 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 纯 API 模式下的根路径说明：没有 Web 产物也照常服务，只把「界面没构建」这件事讲清楚。
 *
 * 服务端是产品本体，Web 只是可选的可视化层；所以这里给 200 + 纯文本（而不是 404 / 500），
 * 让 `curl` 与运维脚本一眼看到 API 在哪、怎么建界面。
 */
function sendApiOnlyNotice(res: ServerResponse, info: ServerInfo): void {
  const lines = [
    'workbench 正在以纯 API 模式运行（没有找到 Web 产物）。',
    '',
    `服务信息：${info.name} ${info.version}`,
    `数据目录：${info.dataDir}`,
    '',
    '要界面就构建一次：pnpm build:web（产物默认落到 out/web）',
    '或者用 WORKBENCH_WEB_DIR 指向已有产物目录；WORKBENCH_UI=off 可显式关闭界面。',
  ]
  const body = `${lines.join('\n')}\n`
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
  })
  res.end(body)
}

/** 静态文件：命中就写响应并返回 true。 */
async function tryServeStatic(
  deps: ApiDeps,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  if (deps.webDir === null) return false
  const file = resolveStaticFile(deps.webDir, pathname)
  if (file === null) {
    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: '路径非法' } })
    return true
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(file)
  } catch {
    return false
  }
  if (!info.isFile()) return false
  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': contentTypeOf(file),
    'content-length': body.byteLength,
    'cache-control': cacheControlOf(file),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
  return true
}

/** 处理一条请求。导出成纯函数便于单测（不需要真监听端口）。 */
export async function handleRequest(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname
  const method = (req.method ?? 'GET').toUpperCase()

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', '只支持 GET')
    }
    // 没有 Web 产物：根路径说明「纯 API 模式」，其余路径照常 404（不伪装成页面）
    if (deps.webDir === null && pathname === '/') {
      sendApiOnlyNotice(res, deps.info())
      return
    }
    const served = deps.webDir === null ? false : await tryServeStatic(deps, pathname, res)
    if (!served) {
      throw new HttpError(
        404,
        'not_found',
        deps.webDir === null
          ? `没有这个页面：${pathname}（当前是纯 API 模式，未托管 Web 产物）`
          : `没有这个页面：${pathname}（Web 产物目录：${deps.webDir}）`,
      )
    }
    return
  }

  // 存活探测与会话建立不鉴权：探针没有 cookie，登录本来就发生在会话之前
  if (pathname === API_PATHS.health && method === 'GET') {
    sendValue(res, { status: 'ok', clients: deps.events.size })
    return
  }
  if (pathname === API_PATHS.session && method === 'POST') {
    if (!isSameOrigin(req)) throw new HttpError(403, 'forbidden_origin', '拒绝跨站请求')
    const body = (await readJsonBody(req)) as SessionRequest | null
    if (!deps.auth.verify(body?.token)) {
      throw new HttpError(401, 'unauthorized', 'token 不正确')
    }
    const cookie = deps.auth.sessionCookie()
    if (cookie !== null) res.setHeader('set-cookie', cookie)
    sendValue(res, { established: true })
    return
  }

  if (!deps.auth.check(req.headers)) {
    throw new HttpError(401, 'unauthorized', '需要登录：先 POST /api/session')
  }

  if (method === 'POST' && !isSameOrigin(req)) {
    throw new HttpError(403, 'forbidden_origin', '拒绝跨站请求')
  }

  switch (`${method} ${pathname}`) {
    case `GET ${API_PATHS.events}`: {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // 反向代理（Nginx）默认会缓冲响应：关掉它，否则推送要等到连接结束才到浏览器
        'x-accel-buffering': 'no',
      })
      deps.events.attach(res)
      return
    }
    case `GET ${API_PATHS.info}`: {
      sendValue(res, deps.info())
      return
    }
    case `POST ${API_PATHS.dispatch}`: {
      const body = (await readJsonBody(req)) as { command?: unknown } | null
      if (body === null || body.command === undefined) {
        throw new HttpError(400, 'invalid_body', '缺少 command')
      }
      sendValue(res, await deps.router.dispatch(body.command))
      return
    }
    case `POST ${API_PATHS.query}`: {
      const body = (await readJsonBody(req)) as { view?: unknown; params?: unknown } | null
      if (body === null || typeof body.view !== 'string') {
        throw new HttpError(400, 'invalid_body', '缺少 view')
      }
      sendValue(res, await deps.router.query(body.view, body.params))
      return
    }
    case `POST ${API_PATHS.lark}`: {
      const admin = deps.lark
      if (admin === undefined) throw new HttpError(501, 'unsupported', '飞书连接管理未装配')
      const body = (await readJsonBody(req)) as LarkRequest | null
      const action = asLarkAction(body?.action)
      if (action === null) throw new HttpError(400, 'invalid_body', '飞书连接动作非法')
      sendValue(res, await runLarkAction(admin, action))
      return
    }
    case `POST ${API_PATHS.notify}`: {
      const body = (await readJsonBody(req)) as NotifyRequest | null
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      if (title === '') throw new HttpError(400, 'invalid_body', '缺少 title')
      deps.notify({ title, body: typeof body?.body === 'string' ? body.body : '' })
      sendValue(res, { sent: true })
      return
    }
    case `GET ${API_PATHS.dirs}`: {
      const target = url.searchParams.get('path') ?? undefined
      sendValue(res, deps.listDirs(target))
      return
    }
    default:
      throw new HttpError(404, 'not_found', `没有这个接口：${method} ${pathname}`)
  }
}

export interface RequestHandlerDeps extends ApiDeps {
  /** 未捕获异常的落点（生产写 stderr；测试注入断言） */
  log?(line: string): void
}

/** 把异步 handler 包成 `node:http` 需要的同步回调，并兜住所有异常。 */
export function createRequestHandler(
  deps: RequestHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const log = deps.log ?? ((line: string) => console.error(line))
  return (req, res) => {
    void handleRequest(deps, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      if (!(error instanceof HttpError)) {
        const message = error instanceof Error ? error.message : String(error)
        log(`[http] ${req.method ?? 'GET'} ${req.url ?? '/'} 失败：${message}`)
      }
      sendError(res, error)
    })
  }
}

export interface WebServer {
  readonly port: number
  readonly server: Server
  close(): Promise<void>
}

/**
 * 关服务的收尾宽限：`server.close()` 只是「停收新连接」，已有连接要自己结束；
 * SSE 是永不结束的响应（`close()` 之前没人合上它），不设上限就会把进程吊在退出流程里。
 * 所以到点直接切断连接，让 `close()` 一定有个结束。
 */
export const CLOSE_GRACE_MS = 3_000

/** 空闲连接补扫间隔：响应合上到连接被回收有延迟，只扫一次会漏掉刚结束的 SSE */
const IDLE_SWEEP_MS = 50

/**
 * 关监听：先停收新连接，再反复扫掉空闲 keep-alive（连接空闲下来就断），
 * `graceMs` 到点仍有连接没走就强制断开（未结束的响应不再等）。
 */
export function closeServer(server: Server, graceMs: number = CLOSE_GRACE_MS): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    let sweep: NodeJS.Timeout | null = null
    let grace: NodeJS.Timeout | null = null
    const finish = (): void => {
      if (done) return
      done = true
      if (sweep !== null) clearInterval(sweep)
      if (grace !== null) clearTimeout(grace)
      resolve()
    }
    sweep = setInterval(
      () => server.closeIdleConnections(),
      Math.max(1, Math.min(IDLE_SWEEP_MS, graceMs)),
    )
    sweep.unref()
    grace = setTimeout(() => {
      server.closeAllConnections()
      finish()
    }, graceMs)
    grace.unref()
    server.close(finish)
    server.closeIdleConnections()
  })
}

/** 起服务：`port=0` 时由系统分配（e2e 与容器常用），实际端口从 `WebServer.port` 读。 */
export async function startWebServer(
  deps: RequestHandlerDeps,
  options: { host: string; port: number; closeGraceMs?: number },
): Promise<WebServer> {
  const server = createServer(createRequestHandler(deps))
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port, options.host)
  })
  const address = server.address() as AddressInfo
  return {
    server,
    port: address.port,
    close: () => closeServer(server, options.closeGraceMs),
  }
}
