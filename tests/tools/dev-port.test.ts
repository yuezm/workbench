// @vitest-environment node
/**
 * dev 脚手架的端口探测（R9）：两个 `scripts/dev.mjs` 同时跑会共写 `.scratch/dev-data`
 * 与 `out/server`，旧实例的 server 还会因为抢不到端口卡在启动上。启动前先探一次。
 */
import { createServer, type Server } from 'node:net'
import { describe, expect, it } from 'vitest'
import { portInUse } from '../../scripts/dev-port.mjs'

const listen = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, port })
    })
  })

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
  })

describe('scripts/dev-port：端口占用探测', () => {
  it('有进程在监听：true', async () => {
    const { server, port } = await listen()
    try {
      expect(await portInUse(port)).toBe(true)
    } finally {
      await close(server)
    }
  })

  it('没人监听：false', async () => {
    const { server, port } = await listen()
    await close(server)
    expect(await portInUse(port)).toBe(false)
  })

  it('端口非法（0 / 负数 / 非整数）：false（端口 0 是系统分配，不能当占用）', async () => {
    expect(await portInUse(0)).toBe(false)
    expect(await portInUse(-1)).toBe(false)
    expect(await portInUse(1.5)).toBe(false)
  })
})
