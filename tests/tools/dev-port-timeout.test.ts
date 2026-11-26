// @vitest-environment node
/**
 * dev-port 的超时降级（R9）：连接既不通也不报错（防火墙吞包 / 地址黑洞）时，
 * 探测必须在 1.5 s 后回 false，而不是把 dev 启动吊死。
 *
 * 真网络上造不出稳定的「静默丢弃」环境，所以这里把 `node:net` 换成假 socket，
 * 手动触发 `timeout` 事件——判断逻辑本身（谁先到就收谁）与真实现完全一致。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { createConnectionMock } = vi.hoisted(() => ({ createConnectionMock: vi.fn() }))

vi.mock('node:net', () => ({ createConnection: createConnectionMock }))

const { portInUse } = await import('../../scripts/dev-port.mjs')

/** 假 socket：记录 setTimeout 回调与 destroy 调用，事件手动触发。 */
class FakeSocket extends EventEmitter {
  destroyed = false
  timeoutMs: number | null = null
  timeoutCallback: (() => void) | null = null

  destroy(): void {
    this.destroyed = true
  }

  setTimeout(ms: number, callback: () => void): this {
    this.timeoutMs = ms
    this.timeoutCallback = callback
    return this
  }
}

describe('scripts/dev-port：连接静默时的降级', () => {
  it('既没 connect 也没 error：1.5 s 到点回 false，并断开 socket', async () => {
    const socket = new FakeSocket()
    createConnectionMock.mockReturnValue(socket)

    const pending = portInUse(7788, '10.255.255.1')
    expect(socket.timeoutMs).toBe(1_500)
    expect(createConnectionMock).toHaveBeenCalledWith({ host: '10.255.255.1', port: 7788 })

    socket.timeoutCallback?.()
    await expect(pending).resolves.toBe(false)
    expect(socket.destroyed).toBe(true)
  })

  it('connect 先到：true，且只结算一次（后续 timeout 不再改结果）', async () => {
    const socket = new FakeSocket()
    createConnectionMock.mockReturnValue(socket)

    const pending = portInUse(7788)
    socket.emit('connect')
    await expect(pending).resolves.toBe(true)

    // 结算后再触发超时：Promise 已经有值，destroy 已执行
    socket.timeoutCallback?.()
    expect(socket.destroyed).toBe(true)
  })
})
