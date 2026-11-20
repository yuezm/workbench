/**
 * 开发脚手架：一条命令起「服务端（watch 构建 + 产物变更自动重启）+ Web dev server（HMR）」
 *
 * 三个子进程：
 * 1. `vite build --watch --config vite.server.config.mts`：改服务端代码就重打 `out/server/index.js`
 * 2. `node out/server/index.js`：产物一变就重启服务（端口 3000，`WORKBENCH_PORT` 可覆盖）
 * 3. `vite --config vite.web.config.mts`：Web 页面 HMR，`/api` 由 dev server 代理到服务端
 * 数据目录默认落 `.scratch/dev-data`（不进仓库、不碰 `~/.workbench`），可用 `WORKBENCH_DATA_DIR` 覆盖
 *
 * ## 为什么服务端不用 `node --watch`（2026-11-20）
 *
 * `node --watch` 会把「模块依赖上报」按**进程树**广播：树里任何人 spawn 带 `stdio: 'ipc'`
 * 的子进程，那个子进程一启动就先发一串 `{watch:import:[...]}`。DSH 的 Windows subprocess
 * runner 正好占 `fd3 = 'ipc'`，收到这种消息即判定 invalid result 并杀掉 runner——表现为
 * 执行器派活的 agent 里 pwsh / grep / glob 全部失败，而 read / write / edit 正常。
 *
 * 该污染既不依赖环境变量、也不依赖直接父进程有无 IPC（实测「watch → 无 ipc 中间层 →
 * 带 ipc 孙进程」仍复现），所以只能在 spawn 之外解决：让服务端进程别挂在 `--watch` 下。
 * 重启改由本脚本轮询产物完成；别改回 `node --watch`。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
// vite 8 起 exports 只暴露包根，`vite/bin/vite.js` 不再可 resolve：从包根拼 bin 路径
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js')

const PORT = process.env.WORKBENCH_PORT ?? '3000'
const DATA_DIR = process.env.WORKBENCH_DATA_DIR ?? '.scratch/dev-data'
const API = process.env.WORKBENCH_DEV_API ?? `http://127.0.0.1:${PORT}`

/** 服务端产物目录与入口：产物变化即重启 */
const SERVER_OUT_DIR = 'out/server'
const SERVER_ENTRY = join(SERVER_OUT_DIR, 'index.js')
/** 产物是分批写入的：最后一次写入后再等这么久才重启 */
const SETTLE_MS = 400
const POLL_MS = 500
const IS_WIN = process.platform === 'win32'

const children = []
let stopping = false
let poller = null
let serverChild = null
let restarting = false
let restartQueued = false

function run(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  child.on('exit', (code) => {
    // 主动重启时走 restartServer 的路径，不能把整个 dev 脚本一起带走
    if (stopping || child.intentional === true) return
    console.error(`[dev] ${name} 退出（code=${String(code)}）`)
    shutdown(code ?? 1)
  })
  children.push(child)
  return child
}

/** 连子孙一起杀：Windows 上 kill() 只打直接子进程，DSH 与它的 runner 会残留 */
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

function shutdown(code) {
  if (stopping) return
  stopping = true
  if (poller !== null) clearInterval(poller)
  for (const child of children) killTree(child)
  process.exitCode = code
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function startServer() {
  console.log(`[dev] 服务端 http://127.0.0.1:${PORT}（数据目录 ${DATA_DIR}）`)
  serverChild = run('server', [SERVER_ENTRY], {
    WORKBENCH_PORT: PORT,
    WORKBENCH_DATA_DIR: DATA_DIR,
  })
}

async function stopServer() {
  const child = serverChild
  serverChild = null
  if (child === null) return
  child.intentional = true
  if (child.exitCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    killTree(child)
  })
}

async function restartServer() {
  if (stopping) return
  if (restarting) {
    restartQueued = true
    return
  }
  restarting = true
  await stopServer()
  if (!stopping) startServer()
  restarting = false
  if (restartQueued) {
    restartQueued = false
    await restartServer()
  }
}

/** 产物目录里最新的 .js mtime：一次构建写多个文件也只算一版 */
function latestStamp(dir) {
  let latest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) latest = Math.max(latest, latestStamp(full))
    else if (entry.name.endsWith('.js')) latest = Math.max(latest, statSync(full).mtimeMs)
  }
  return latest
}

run('server:build', [viteBin, 'build', '--config', 'vite.server.config.mts', '--watch'])
run('web', [viteBin, '--config', 'vite.web.config.mts'], { WORKBENCH_DEV_API: API })

// 产物要等第一次构建完成：入口出现且 mtime 稳定后再拉起，避免首个请求打到半成品
let lastStamp = 0
let settleAt = 0
poller = setInterval(() => {
  if (stopping || !existsSync(SERVER_ENTRY)) return
  let stamp
  try {
    stamp = latestStamp(SERVER_OUT_DIR)
  } catch {
    return // vite 重写目录的瞬间读不到：下一轮再看
  }
  if (stamp !== lastStamp) {
    lastStamp = stamp
    settleAt = Date.now() + SETTLE_MS
    return
  }
  if (settleAt !== 0 && Date.now() >= settleAt) {
    settleAt = 0
    restartServer().catch((error) => {
      console.error('[dev] 服务端重启失败', error)
      shutdown(1)
    })
  }
}, POLL_MS)
