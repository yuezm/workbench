// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { fakeHmacHex, fakeNet, fakeSignatureHeader } from './fake-net'
import { sdkWithNet, sourceHarness } from './harness'

describe('source 测试夹具（M7）', () => {
  it('fakeNet：未 listen 时 handler 为 null，request 给可读错误', async () => {
    const net = fakeNet()
    expect(net.handler).toBeNull()
    await expect(
      net.request({ method: 'POST', path: '/x', headers: {}, body: '' }),
    ).rejects.toThrow('fakeNet：尚未调用 listen')
  })

  it('fakeNet：listen 后 handler 指向注册的处理器，default verify 与 fakeHmacHex 同口径', async () => {
    const net = fakeNet({ port: 1234 })
    const reply = { status: 200, body: 'ok' }
    const listener = await net.listen(1, async () => reply)
    expect(listener.port).toBe(1234)
    expect(net.handler).not.toBeNull()
    expect(await net.handler!({ method: 'GET', path: '/', headers: {}, body: '' })).toBe(reply)

    const message = '1700000000.{}'
    expect(net.verifyHmacSha256('secret', message, fakeHmacHex('secret', message))).toBe(true)
    expect(net.verifyHmacSha256('secret', message, 'deadbeef')).toBe(false)
    // 签名头只做格式拼接，真 HMAC 由 host/net.ts 用例覆盖
    expect(fakeSignatureHeader('secret', '1700000000', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('fakeNet：显式 verify / fetch 注入生效；fetch 缺省返回 200 空响应', async () => {
    const verify = vi.fn(() => true)
    const fetchImpl = vi.fn(async () => ({ status: 201, headers: { a: 'b' }, body: 'x' }))
    const net = fakeNet({ verify, fetch: fetchImpl })
    expect(net.verifyHmacSha256('s', 'm', 'bad')).toBe(true)
    expect(verify).toHaveBeenCalledWith('s', 'm', 'bad')
    await expect(net.fetch('http://x', { method: 'POST' })).resolves.toEqual({
      status: 201,
      headers: { a: 'b' },
      body: 'x',
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://x', { method: 'POST' })

    const plain = fakeNet()
    await expect(plain.fetch('http://x')).resolves.toEqual({ status: 200, headers: {}, body: '' })
    expect(plain.fetches).toEqual([{ url: 'http://x', options: undefined }])
  })

  it('sdkWithNet：未给配置时 config() 回落空对象（宿主未合并默认值的兜底）', () => {
    const assembled = sdkWithNet()
    expect(assembled.sdk.config()).toEqual({})
  })

  it('sdkWithNet：缺省 log 为静默函数；sourceHarness 的 emit / log 收集可用', () => {
    const assembled = sdkWithNet({ now: () => 1234 })
    expect(() => assembled.sdk.log('静默')).not.toThrow()
    expect(assembled.sdk.now()).toBe(1234)
    expect(assembled.net).toBeDefined()

    const harness = sourceHarness({ config: { port: 1 } })
    expect(harness.sdk.config()).toEqual({ port: 1 })
    harness.ctx.emit({ source: 'webhook', type: 'issues.opened', subject: 's' })
    harness.sdk.log('诊断')
    expect(harness.emitted).toEqual([{ source: 'webhook', type: 'issues.opened', subject: 's' }])
    expect(harness.logs).toEqual(['诊断'])
    expect(harness.ctx.signal).toBe(harness.controller.signal)
  })
})
