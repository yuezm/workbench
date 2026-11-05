/**
 * 宿主网络原件（M7 D7）：`NetCapability` 的唯一实现。
 *
 * 边界与取舍：
 * - **只在这里出现 `node:http` / `node:https` / `node:crypto`**：插件层（`src/plugins/**`）
 *   被 ESLint 禁止 import Node 内置，验签与传输必须由宿主代做；插件只经 `sdk.net` 调用。
 * - `fetch` 只回 `{status, headers, body}`：不暴露流、socket 与重定向语义，响应体上限
 *   1 MiB，超时默认 10 s（插件可缩短，不可超过宿主上限）。
 * - `listen` **只绑 `127.0.0.1`**，不接受插件指定地址；端口 0 表示由系统分配（实际端口经
 *   `NetListener.port` 回读），其余必须是 1..65535 的整数；请求体上限 1 MiB，超限回 413
 *   且不调用 handler。
 * - `verifyHmacSha256` 用 `timingSafeEqual` 做常数时间比较；secret / message 只作参数，
 *   不落日志（失败原因也不含两者）。
 * - handler 抛错只降级为 500（并记一条不含正文的日志），不让单个请求打断监听。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import type {
  NetCapability,
  NetFetchOptions,
  NetListener,
  NetReply,
  NetRequest,
  NetResponse,
} from '../sdk/types'

/** 网络原件的硬上限（宿主强制；插件无法放大）。 */
export const NET_LIMITS = {
  /** `fetch` 默认超时（毫秒） */
  timeoutMs: 10_000,
  /** 插件可指定的最大超时（毫秒） */
  maxTimeoutMs: 60_000,
  /** `fetch` 响应体上限 */
  responseBytes: 1024 * 1024,
  /** `listen` 请求体上限 */
  requestBytes: 1024 * 1024,
  /** `listen` 唯一允许绑定的地址 */
  listenHost: '127.0.0.1',
  /** `listen` 允许的端口上界（0 表示系统分配） */
  maxPort: 65_535,
} as const

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 响应头统一成单值字符串（多值头按 `, ` 合并，与 fetch 口径一致）。 */
const headerRecord = (headers: IncomingMessage['headers']): Record<string, string> => {
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    record[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return record
}

/** 插件传入的超时只允许缩短：非正数 / 非整数回退默认值，超过宿主上限按上限截断。 */
const normalizeTimeout = (timeoutMs: number | undefined): number => {
  if (timeoutMs === undefined || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return NET_LIMITS.timeoutMs
  }
  return Math.min(timeoutMs, NET_LIMITS.maxTimeoutMs)
}

/** 校验 `listen` 端口：0 交给系统分配，其余必须是 1..65535 的整数。 */
const normalizePort = (port: number): number => {
  if (!Number.isInteger(port) || port < 0 || port > NET_LIMITS.maxPort) {
    throw new Error(`net_listen_port: 端口必须是 0..${NET_LIMITS.maxPort} 的整数`)
  }
  return port
}

/** 校验 handler 的应答：形状不合法按 500 处理（不把插件异常透给调用方）。 */
const normalizeReply = (
  reply: NetReply | undefined,
): { status: number; body: string; headers: Record<string, string> } => {
  if (typeof reply !== 'object' || reply === null) {
    return { status: 500, body: '', headers: {} }
  }
  const status =
    Number.isInteger(reply.status) && reply.status >= 100 && reply.status <= 599
      ? reply.status
      : 500
  const rawBody = typeof reply.body === 'string' ? reply.body : ''
  const body = rawBody.length > NET_LIMITS.requestBytes ? '' : rawBody
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(reply.headers ?? {})) {
    if (typeof value === 'string') headers[key] = value
  }
  return { status, body, headers }
}

/** 读取请求体（超限返回 null，调用方回 413）。 */
const readRequestBody = (request: IncomingMessage): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > NET_LIMITS.requestBytes) {
        // 超限：摘掉 data 监听并继续消费剩余字节，避免把请求体堆进内存
        request.removeAllListeners('data')
        request.resume()
        resolve(null)
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

/** 关闭监听：先停止接收新连接，再销毁存量连接（keep-alive 不会拖住退出）。 */
const closeServer = (server: Server, sockets: Set<Socket>): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
    for (const socket of sockets) socket.destroy()
  })

/** `createNetCapability` 的可注入项（只有日志；测试注入空实现）。 */
export interface NetOptions {
  /** 监听侧诊断日志（不含请求正文、头与 secret） */
  log?: (line: string) => void
}

/** 组装网络原件：`fetch` / `listen` / `verifyHmacSha256` 三个方法共用同一套上限。 */
export function createNetCapability(options: NetOptions = {}): NetCapability {
  const log = options.log ?? ((line: string): void => console.warn(line))

  const fetch = (url: string, fetchOptions: NetFetchOptions = {}): Promise<NetResponse> => {
    let target: URL
    try {
      target = new URL(url)
    } catch (error) {
      return Promise.reject(new Error(`net_fetch_url: ${errMsg(error)}`))
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return Promise.reject(
        new Error(`net_fetch_protocol: 只支持 http/https，收到 ${target.protocol}`),
      )
    }
    const timeoutMs = normalizeTimeout(fetchOptions.timeoutMs)
    return new Promise<NetResponse>((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null, response?: NetResponse): void => {
        if (settled) return
        settled = true
        if (error === null && response !== undefined) resolve(response)
        else reject(error)
      }
      const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
      let request: ClientRequest
      try {
        request = transport(
          target,
          { method: fetchOptions.method ?? 'GET', headers: fetchOptions.headers ?? {} },
          (response: IncomingMessage) => {
            const chunks: Buffer[] = []
            let total = 0
            response.on('data', (chunk: Buffer) => {
              total += chunk.length
              if (total > NET_LIMITS.responseBytes) {
                finish(
                  new Error(`net_fetch_too_large: 响应体超过 ${NET_LIMITS.responseBytes} 字节`),
                )
                request.destroy()
                return
              }
              chunks.push(Buffer.from(chunk))
            })
            response.on('end', () => {
              finish(null, {
                // 服务端响应一定有 statusCode（类型上的 undefined 只对非响应对象成立）
                status: response.statusCode as number,
                headers: headerRecord(response.headers),
                body: Buffer.concat(chunks).toString('utf8'),
              })
            })
            response.on('error', (error: Error) => finish(error))
          },
        )
      } catch (error) {
        // 请求构造同步抛错（如非法头字符）：保留消息即可，调用方按 reject 处理
        finish(new Error(errMsg(error)))
        return
      }
      request.setTimeout(timeoutMs, () => {
        finish(new Error(`net_fetch_timeout: 请求超过 ${timeoutMs} ms 未完成`))
        request.destroy()
      })
      request.on('error', (error: Error) => finish(error))
      if (fetchOptions.body !== undefined) request.write(fetchOptions.body)
      request.end()
    })
  }

  const listen = (
    port: number,
    handler: (request: NetRequest) => Promise<NetReply>,
  ): Promise<NetListener> => {
    let normalized: number
    try {
      normalized = normalizePort(port)
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise<NetListener>((resolve, reject) => {
      const sockets = new Set<Socket>()
      let closed = false
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
          let body: string | null
          try {
            body = await readRequestBody(request)
          } catch (error) {
            log(`[net] 读取请求体失败：${errMsg(error)}`)
            response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('bad_request')
            return
          }
          if (body === null) {
            response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('request_too_large')
            // 继续消费剩余字节，避免半开连接拖住服务
            request.resume()
            return
          }
          const netRequest: NetRequest = {
            // 服务端请求的 method / url 由 HTTP 解析器保证存在（类型上的 undefined 只对客户端响应成立）
            method: request.method as string,
            path: request.url as string,
            headers: headerRecord(request.headers),
            body,
          }
          let reply: NetReply
          try {
            reply = await handler(netRequest)
          } catch (error) {
            log(
              `[net] 回环请求处理失败（${netRequest.method} ${netRequest.path}）：${errMsg(error)}`,
            )
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('handler_error')
            return
          }
          const normalizedReply = normalizeReply(reply)
          response.writeHead(normalizedReply.status, {
            ...normalizedReply.headers,
            ...(normalizedReply.body.length > 0
              ? {
                  'content-type':
                    normalizedReply.headers['content-type'] ?? 'text/plain; charset=utf-8',
                }
              : {}),
          })
          response.end(normalizedReply.body)
        })()
      })
      server.on('connection', (socket: Socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      server.on('error', (error: Error) => {
        // 绑定失败（如端口占用）由 reject 表达；已 resolve 后 reject 是空操作，
        // 因此这一句同时承担「监听期错误」的诊断日志。
        log(`[net] 监听错误：${errMsg(error)}`)
        reject(error)
      })
      server.listen({ host: NET_LIMITS.listenHost, port: normalized }, () => {
        const actualPort = (server.address() as AddressInfo).port
        resolve({
          port: actualPort,
          close: (): Promise<void> => {
            if (closed) return Promise.resolve()
            closed = true
            return closeServer(server, sockets)
          },
        })
      })
    })
  }

  const verifyHmacSha256 = (secret: string, message: string, signatureHex: string): boolean => {
    if (typeof secret !== 'string' || typeof message !== 'string') return false
    if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(signatureHex)) return false
    const expected = createHmac('sha256', secret).update(message, 'utf8').digest()
    const actual = Buffer.from(signatureHex, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  return { fetch, listen, verifyHmacSha256 }
}
