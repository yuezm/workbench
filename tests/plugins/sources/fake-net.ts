/**
 * 测试夹具：假 `NetCapability`（M7）。不监听真实端口、不发真实请求。
 *
 * 验签用确定性摘要冒充 HMAC（真 HMAC 的常数时间比较由 `host/net.ts` 的实现与其用例覆盖）：
 * 这里只需要能验证插件把 `secret` 与 `${timestamp}.${rawBody}` 原样交给宿主，
 * 以及签名头的格式判定（`sha256=<64 位十六进制>`）。
 */
import type {
  NetCapability,
  NetFetchOptions,
  NetReply,
  NetRequest,
  NetResponse,
} from '../../../src/sdk/types'

export interface FakeNetListener {
  port: number
  /** close 被调用的次数（dispose 幂等性断言用） */
  closes: number
}

export interface FakeNetFetchCall {
  url: string
  options: NetFetchOptions | undefined
}

export interface FakeNet extends NetCapability {
  /** `fetch` 的调用记录（顺序即调用顺序） */
  fetches: FakeNetFetchCall[]
  /** `listen` 的调用记录 */
  listeners: FakeNetListener[]
  /** 最近一次 `listen` 注册的请求处理器；未监听为 null */
  handler: ((request: NetRequest) => Promise<NetReply>) | null
  /** 模拟宿主收到一个请求（直接调用最近一次注册的处理器） */
  request(request: NetRequest): Promise<NetReply>
}

export interface FakeNetOptions {
  /** `listen` 返回的实际端口；缺省回显传入端口 */
  port?: number
  /** 出站请求实现；缺省 200 空响应 */
  fetch?: (url: string, options?: NetFetchOptions) => Promise<NetResponse>
  /** 验签实现；缺省与 `fakeHmacHex(secret, message)` 比对 */
  verify?: (secret: string, message: string, signatureHex: string) => boolean
}

/** 确定性摘要（64 位十六进制）：测试专用，不是真 HMAC。 */
export function fakeHmacHex(secret: string, message: string): string {
  const input = `${secret}\u0000${message}`
  let out = ''
  for (let round = 0; round < 8; round += 1) {
    let hash = (0x811c9dc5 ^ (round * 0x9e3779b9)) >>> 0
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    out += hash.toString(16).padStart(8, '0')
  }
  return out
}

/** 按插件契约拼签名头：`sha256=<hex(HMAC(secret, `${timestamp}.${body}`))>`。 */
export function fakeSignatureHeader(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${fakeHmacHex(secret, `${timestamp}.${rawBody}`)}`
}

export function fakeNet(options: FakeNetOptions = {}): FakeNet {
  const fetches: FakeNetFetchCall[] = []
  const listeners: FakeNetListener[] = []
  let handler: FakeNet['handler'] = null

  return {
    fetches,
    listeners,
    get handler() {
      return handler
    },
    request: async (request) => {
      if (handler === null) throw new Error('fakeNet：尚未调用 listen')
      return await handler(request)
    },
    fetch: async (url, fetchOptions) => {
      fetches.push({ url, options: fetchOptions })
      if (options.fetch !== undefined) return await options.fetch(url, fetchOptions)
      return { status: 200, headers: {}, body: '' }
    },
    listen: async (port, requestHandler) => {
      const listener: FakeNetListener = { port: options.port ?? port, closes: 0 }
      listeners.push(listener)
      handler = requestHandler
      return {
        port: listener.port,
        close: async () => {
          listener.closes += 1
        },
      }
    },
    verifyHmacSha256: (secret, message, signatureHex) => {
      if (options.verify !== undefined) return options.verify(secret, message, signatureHex)
      return signatureHex === fakeHmacHex(secret, message)
    },
  }
}
