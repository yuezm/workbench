// @vitest-environment node
import { createHmac } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NET_LIMITS, createNetCapability } from '../../src/host/net'
import type { NetReply } from '../../src/sdk/types'

/**
 * 宿主网络原件（M7 D7）：`fetch` / `listen` / `verifyHmacSha256`。
 *
 * 全部打真实回环（`127.0.0.1` 临时端口）或假 HTTP 服务，不连外网；`listen` 的端口 0
 * 由系统分配后经 `listener.port` 回读，避免用例之间抢固定端口。
 */

interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface TestServer {
  url: string
  server: Server
  close: () => Promise<void>
}

const servers: TestServer[] = []

function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push({
      url: '',
      server,
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        }),
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      const entry = servers[servers.length - 1]
      entry.url = `http://127.0.0.1:${address.port}`
      resolve(entry)
    })
  })
}

/** 直接用 node:http 发请求（被测的是宿主原件，不用它自测自己）。 */
function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: options.method ?? 'GET', headers: options.headers ?? {} },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

afterEach(async () => {
  for (const entry of servers.splice(0)) await entry.close()
  vi.restoreAllMocks()
})

const net = createNetCapability()

describe('net.fetch', () => {
  it('GET：返回状态、头与正文（只回文本，不暴露流）', async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'x-test': 'ok' })
      response.end('hello')
    })

    const response = await net.fetch(target.url)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/plain')
    expect(response.headers['x-test']).toBe('ok')
    expect(response.body).toBe('hello')
  })

  it('POST：方法、头与正文原样发出', async () => {
    const received: Array<{ method?: string; header?: string | string[]; body: string }> = []
    const target = await startServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        received.push({
          method: request.method,
          header: request.headers['x-probe'],
          body: Buffer.concat(chunks).toString('utf8'),
        })
        response.writeHead(201)
        response.end('created')
      })
    })

    const response = await net.fetch(`${target.url}/hook`, {
      method: 'POST',
      headers: { 'x-probe': 'yes', 'content-type': 'application/json' },
      body: '{"a":1}',
    })

    expect(response.status).toBe(201)
    expect(response.body).toBe('created')
    expect(received).toEqual([{ method: 'POST', header: 'yes', body: '{"a":1}' }])
  })

  it('非 2xx 照常返回状态与正文（是否失败由插件判定）', async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(418, { 'content-type': 'text/plain' })
      response.end('teapot')
    })
    await expect(net.fetch(target.url)).resolves.toMatchObject({ status: 418, body: 'teapot' })
  })

  it('非 http/https 协议与非法 URL 都 reject', async () => {
    await expect(net.fetch('ftp://127.0.0.1/file')).rejects.toThrow(/net_fetch_protocol/)
    await expect(net.fetch('not a url')).rejects.toThrow(/net_fetch_url/)
  })

  it('超时（默认 10 s，可缩短）reject，不悬挂', async () => {
    const target = await startServer((_request, response) => {
      // 永不响应：由宿主超时兜底
      response.on('error', () => undefined)
    })
    await expect(net.fetch(target.url, { timeoutMs: 30 })).rejects.toThrow(/net_fetch_timeout/)
  })

  it('响应体超过 1 MiB reject', async () => {
    const target = await startServer((_request, response) => {
      response.on('error', () => undefined)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(NET_LIMITS.responseBytes + 1))
    })
    await expect(net.fetch(target.url)).rejects.toThrow(/net_fetch_too_large/)
  })

  it('https 走 https 传输（对明文服务握手失败即 reject）', async () => {
    const target = await startServer((_request, response) => response.end('plain'))
    await expect(net.fetch(target.url.replace('http:', 'https:'))).rejects.toThrow()
  })
})

describe('net.listen', () => {
  it('只绑 127.0.0.1：端口 0 由系统分配，可回读并处理请求', async () => {
    const listener = await net.listen(0, async (request) => ({
      status: 200,
      body: `${request.method} ${request.path}`,
    }))
    try {
      expect(Number.isInteger(listener.port)).toBe(true)
      expect(listener.port).toBeGreaterThan(0)
      expect(listener.port).toBeLessThanOrEqual(NET_LIMITS.maxPort)

      const response = await send(`http://127.0.0.1:${listener.port}/webhook`)
      expect(response.status).toBe(200)
      expect(response.body).toBe('GET /webhook')
    } finally {
      await listener.close()
    }
  })

  it('handler 收到方法 / 路径 / 头 / 正文，可回状态、头与正文', async () => {
    const seen: Array<{ method: string; path: string; header?: string; body: string }> = []
    const listener = await net.listen(0, async (request) => {
      seen.push({
        method: request.method,
        path: request.path,
        header: request.headers['x-signature'],
        body: request.body,
      })
      return { status: 202, body: 'accepted', headers: { 'x-reply': 'yes' } }
    })
    try {
      const response = await send(`http://127.0.0.1:${listener.port}/hook?x=1`, {
        method: 'POST',
        headers: { 'x-signature': 'sha256=abc' },
        body: '{"type":"demo"}',
      })
      expect(response.status).toBe(202)
      expect(response.body).toBe('accepted')
      expect(response.headers['x-reply']).toBe('yes')
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(seen).toEqual([
        { method: 'POST', path: '/hook?x=1', header: 'sha256=abc', body: '{"type":"demo"}' },
      ])
    } finally {
      await listener.close()
    }
  })

  it('handler 抛错降级为 500，监听不中断（记一条不含正文的日志）', async () => {
    const log = vi.fn()
    const logged = createNetCapability({ log })
    const listener = await logged.listen(0, async () => {
      throw new Error('插件内部错误')
    })
    try {
      const response = await send(`http://127.0.0.1:${listener.port}/hook`)
      expect(response.status).toBe(500)
      expect(response.body).toBe('handler_error')
      expect(log).toHaveBeenCalledWith(expect.stringContaining('回环请求处理失败'))
      expect(String(log.mock.calls[0]?.[0])).not.toContain('{"')
    } finally {
      await listener.close()
    }
  })

  it('请求体超过 1 MiB 回 413 且不调用 handler', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }))
    const listener = await net.listen(0, handler)
    try {
      const response = await send(`http://127.0.0.1:${listener.port}/hook`, {
        method: 'POST',
        body: 'x'.repeat(NET_LIMITS.requestBytes + 1),
      })
      expect(response.status).toBe(413)
      expect(response.body).toBe('request_too_large')
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await listener.close()
    }
  })

  it('非法端口 reject（0 交给系统，其余 1..65535 的整数）', async () => {
    const handler = async (): Promise<{ status: number }> => ({ status: 200 })
    await expect(net.listen(-1, handler)).rejects.toThrow(/net_listen_port/)
    await expect(net.listen(65_536, handler)).rejects.toThrow(/net_listen_port/)
    await expect(net.listen(1.5, handler)).rejects.toThrow(/net_listen_port/)
  })

  it('close 幂等；关闭后端口不再接受连接', async () => {
    const listener = await net.listen(0, async () => ({ status: 200, body: 'ok' }))
    const url = `http://127.0.0.1:${listener.port}/hook`
    await listener.close()
    await expect(listener.close()).resolves.toBeUndefined()
    await expect(send(url)).rejects.toThrow()
  })

  it('handler 应答形状非法时按 500 处理（不透传插件异常值）', async () => {
    const listener = await net.listen(
      0,
      async () => ({ status: 999 }) as unknown as { status: number },
    )
    try {
      const response = await send(`http://127.0.0.1:${listener.port}/hook`)
      expect(response.status).toBe(500)
      expect(response.body).toBe('')
    } finally {
      await listener.close()
    }
  })
})

describe('net.verifyHmacSha256', () => {
  const secret = 's3cret'
  const message = '1700000000.{"type":"demo"}'
  const expected = createHmac('sha256', secret).update(message, 'utf8').digest('hex')

  it('正确签名（含大写 hex）返回 true', () => {
    expect(net.verifyHmacSha256(secret, message, expected)).toBe(true)
    expect(net.verifyHmacSha256(secret, message, expected.toUpperCase())).toBe(true)
  })

  it('签名错误 / 长度不对 / 非 hex / 非字符串一律 false（不抛）', () => {
    expect(net.verifyHmacSha256(secret, message, '0'.repeat(64))).toBe(false)
    expect(net.verifyHmacSha256(secret, message, expected.slice(0, 63))).toBe(false)
    expect(net.verifyHmacSha256(secret, message, 'zz'.repeat(32))).toBe(false)
    expect(net.verifyHmacSha256(secret, message, undefined as unknown as string)).toBe(false)
    expect(net.verifyHmacSha256(undefined as unknown as string, message, expected)).toBe(false)
  })

  it('message 或 secret 变化即 false（不做前缀/子串比较）', () => {
    expect(net.verifyHmacSha256(secret, `${message} `, expected)).toBe(false)
    expect(net.verifyHmacSha256('other', message, expected)).toBe(false)
  })
})

describe('net.fetch 边界', () => {
  it('多值响应头按 ", " 合并（set-cookie 不丢项）', async () => {
    const target = await startServer((_request, response) => {
      response.setHeader('set-cookie', ['a=1', 'b=2'])
      response.end('ok')
    })
    const response = await net.fetch(target.url)
    expect(response.headers['set-cookie']).toBe('a=1, b=2')
  })

  it('响应中途断开：reject（不返回半截正文）', async () => {
    const target = await startServer((_request, response) => {
      response.on('error', () => undefined)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('partial')
      setTimeout(() => response.destroy(), 10)
    })
    await expect(net.fetch(target.url)).rejects.toThrow()
  })

  it('请求构造同步抛错（非法头字符）：reject 而不是悬挂', async () => {
    const target = await startServer((_request, response) => response.end('ok'))
    await expect(net.fetch(target.url, { headers: { 'x-bad': 'a\nb' } })).rejects.toThrow()
  })
})

describe('net.listen 边界', () => {
  it('默认日志落 console.warn（未注入 log 通道）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bare = createNetCapability()
    const listener = await bare.listen(0, async () => {
      throw new Error('boom')
    })
    try {
      const response = await send(`http://127.0.0.1:${listener.port}/hook`)
      expect(response.status).toBe(500)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('回环请求处理失败'))
    } finally {
      await listener.close()
    }
  })

  it('端口占用：listen reject 并记一条监听错误日志', async () => {
    const log = vi.fn()
    const logged = createNetCapability({ log })
    const handler = async (): Promise<NetReply> => ({ status: 200, body: 'ok' })
    const first = await logged.listen(0, handler)
    try {
      await expect(logged.listen(first.port, handler)).rejects.toThrow()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('监听错误'))
    } finally {
      await first.close()
    }
  })

  it('请求体分块写入：超限后忽略后续分片，仍回 413', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }))
    const listener = await net.listen(0, handler)
    try {
      const url = `http://127.0.0.1:${listener.port}/hook`
      const body = 'x'.repeat(NET_LIMITS.requestBytes + 1)
      const response = await new Promise<HttpResponse>((resolve, reject) => {
        const request = httpRequest(
          url,
          { method: 'POST', headers: { 'content-length': String(body.length + 4) } },
          (incoming) => {
            const chunks: Buffer[] = []
            incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
            incoming.on('end', () =>
              resolve({
                status: incoming.statusCode ?? 0,
                headers: incoming.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            )
          },
        )
        request.on('error', reject)
        request.write(body)
        // 第二个分片到达时已判定超限：data 回调的 settled 守卫必须吃掉它
        setTimeout(() => {
          request.write('tail')
          request.end()
        }, 20)
      })
      expect(response.status).toBe(413)
      expect(response.body).toBe('request_too_large')
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await listener.close()
    }
  })

  it('客户端读取请求体时断开：回 400 并记日志（不调用 handler）', async () => {
    const log = vi.fn()
    const logged = createNetCapability({ log })
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }))
    const listener = await logged.listen(0, handler)
    try {
      await new Promise<void>((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: listener.port }, () => {
          socket.write('POST /hook HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial')
          setTimeout(() => {
            socket.destroy()
            resolve()
          }, 20)
        })
        socket.on('error', () => resolve())
      })
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(expect.stringContaining('读取请求体失败')),
      )
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await listener.close()
    }
  })

  it('handler 抛非 Error：500 且日志记录字符串值（不泄漏请求正文）', async () => {
    const log = vi.fn()
    const logged = createNetCapability({ log })
    const listener = await logged.listen(0, async () => {
      throw '字符串错误'
    })
    try {
      const response = await send(`http://127.0.0.1:${listener.port}/hook`, {
        method: 'POST',
        body: '{"secret":"nope"}',
      })
      expect(response.status).toBe(500)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('字符串错误'))
      expect(String(log.mock.calls[0]?.[0])).not.toContain('nope')
    } finally {
      await listener.close()
    }
  })

  it('应答 null / 超长正文 / 非字符串头：安全降级', async () => {
    let mode = 0
    const listener = await net.listen(0, async () => {
      mode += 1
      if (mode === 1) return undefined as unknown as NetReply
      if (mode === 2) {
        return { status: 200, body: 'x'.repeat(NET_LIMITS.requestBytes + 1) }
      }
      return {
        status: 200,
        body: 'ok',
        headers: { 'x-num': 5 as unknown as string, 'x-ok': 'yes' },
      }
    })
    try {
      const url = `http://127.0.0.1:${listener.port}/hook`
      const emptyReply = await send(url)
      expect(emptyReply.status).toBe(500)
      expect(emptyReply.body).toBe('')

      const tooLarge = await send(url)
      expect(tooLarge.status).toBe(200)
      expect(tooLarge.body).toBe('')

      const filtered = await send(url)
      expect(filtered.status).toBe(200)
      expect(filtered.body).toBe('ok')
      expect(filtered.headers['x-ok']).toBe('yes')
      expect(filtered.headers['x-num']).toBeUndefined()
    } finally {
      await listener.close()
    }
  })
})
