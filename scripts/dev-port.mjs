/**
 * 端口占用探测（R9）：dev 脚手架启动前的单实例保护。
 *
 * 为什么需要：本机实测两份 `scripts/dev.mjs` 同时在跑（一份来自旧会话），都 `cd` 到仓库根、
 * 都用默认 `WORKBENCH_DATA_DIR=.scratch/dev-data` 与端口 3000。后起的实例抢到端口，先起的
 * 那份 server 进程活着却不再监听；两份 `vite --watch` 还互相踩 `out/server`，两份内核开着
 * 同一个 SQLite。表现是「同一个进程却对不上」。
 */
import { createConnection } from 'node:net'

/**
 * 端口是否已被监听。
 *
 * 端口 0 是「由系统分配」，永远不算占用；非正整数一律 false（调用方不必自己判）。
 * 连不上（ECONNREFUSED）与超时都按「没人监听」处理——这只是启动前的提示，不是鉴权。
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export const portInUse = (port, host = '127.0.0.1') => {
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (used) => {
      socket.destroy()
      resolve(used)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1_500, () => finish(false))
  })
}
