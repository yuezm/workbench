/**
 * 事件流（SSE）：服务端 → 浏览器的单向推送，替代 Electron 的 `webContents.send`。
 *
 * 为什么是 SSE 而不是 WebSocket：
 * - 推送本来就是单向的（事实批次、聊天流、知会）；写操作走 HTTP POST，不需要双向；
 * - SSE 是纯文本协议，`node:http` 直接写，零第三方运行时依赖（`ws` 会多一个包）；
 * - 浏览器原生 `EventSource` 自带断线重连（默认 3 秒，服务端用 `retry:` 再声明一次）。
 *
 * 边界：只持有响应对象的写端；不解析请求、不鉴权（鉴权在 HTTP 层先做）。
 * 单个客户端写失败只把它踢掉，不影响其它客户端，更不影响内核写路径。
 */
import type { ServerEvent } from '../protocol/http'

/** 心跳间隔：中间代理（Nginx 默认 60s）会掐掉长期无数据的连接，15s 足够保守。 */
export const HEARTBEAT_MS = 15_000
/** 重连间隔建议值：浏览器据此重连 */
export const RETRY_MS = 3_000

/** 只依赖这几个成员，测试用假对象即可，不需要真 socket。 */
export interface StreamSink {
  write(chunk: string): unknown
  end(): void
  on(event: 'close', handler: () => void): void
}

export interface EventStream {
  /** 接一个客户端；返回「主动摘掉它」的函数（HTTP 层在请求结束时兜底调用） */
  attach(sink: StreamSink): () => void
  /** 广播一条消息（没有客户端时什么都不做） */
  publish(event: ServerEvent): void
  /** 当前在线客户端数 */
  readonly size: number
  /** 关掉全部连接与心跳（进程退出） */
  close(): void
}

export interface EventStreamOptions {
  heartbeatMs?: number
  /** 定时器注入（测试用假时钟，避免挂住进程） */
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  /** 是否 unref 定时器（生产 true：心跳不该单独把进程留在事件循环里） */
  unref?: boolean
}

/** 序列化：一条消息一个 `data:` 段（消息体自己带 `kind`，客户端按它分支）。 */
export function formatSse(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function createEventStream(options: EventStreamOptions = {}): EventStream {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const schedule =
    options.setInterval ??
    ((callback: () => void, ms: number) => {
      const timer = setInterval(callback, ms)
      if (options.unref ?? true) timer.unref?.()
      return timer
    })
  const cancel =
    options.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout))

  const sinks = new Set<StreamSink>()
  let heartbeat: unknown = null

  const stopHeartbeat = (): void => {
    if (heartbeat === null) return
    cancel(heartbeat)
    heartbeat = null
  }

  const drop = (sink: StreamSink): void => {
    sinks.delete(sink)
    if (sinks.size === 0) stopHeartbeat()
  }

  return {
    attach: (sink) => {
      sinks.add(sink)
      // 首帧：声明重连间隔，并立刻 flush 掉响应头（否则浏览器要等到第一次 `data:` 才认为连上了）
      try {
        sink.write(`retry: ${RETRY_MS}\n\n`)
      } catch {
        drop(sink)
        return () => undefined
      }
      sink.on('close', () => drop(sink))
      if (heartbeat === null) {
        heartbeat = schedule(() => {
          for (const client of [...sinks]) {
            try {
              client.write(': ping\n\n')
            } catch {
              drop(client)
            }
          }
        }, heartbeatMs)
      }
      return () => drop(sink)
    },
    publish: (event) => {
      if (sinks.size === 0) return
      const payload = formatSse(event)
      for (const sink of [...sinks]) {
        try {
          sink.write(payload)
        } catch {
          drop(sink)
        }
      }
    },
    get size() {
      return sinks.size
    },
    close: () => {
      stopHeartbeat()
      for (const sink of [...sinks]) {
        try {
          sink.end()
        } catch {
          // 已经断开的连接：忽略
        }
      }
      sinks.clear()
    },
  }
}
