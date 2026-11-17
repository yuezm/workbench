/**
 * 开发脚手架：一条命令起「服务端（watch 构建 + node --watch）+ Web dev server（HMR）」
 *
 * 三个子进程：
 * 1. `vite build --watch --config vite.server.config.mts`：改服务端代码就重打 `out/server/index.js`
 * 2. `node --watch out/server/index.js`：产物一变就重启服务（端口 7788）
 * 3. `vite --config vite.web.config.mts`：Web 页面 HMR，`/api` 由 dev server 代理到服务端
 * 数据目录默认落 `.scratch/dev-data`（不进仓库、不碰 `~/.workbench`），可用 `WORKBENCH_DATA_DIR` 覆盖
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
// vite 8 起 exports 只暴露包根，`vite/bin/vite.js` 不再可 resolve：从包根拼 bin 路径
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js')

const PORT = process.env.WORKBENCH_PORT ?? '7788'
const DATA_DIR = process.env.WORKBENCH_DATA_DIR ?? '.scratch/dev-data'
const API = process.env.WORKBENCH_DEV_API ?? `http://127.0.0.1:${PORT}`

const children = []
let stopping = false

function run(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  child.on('exit', (code) => {
    if (stopping) return
    console.error(`[dev] ${name} 退出（code=${String(code)}）`)
    shutdown(code ?? 1)
  })
  children.push(child)
  return child
}

function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.exitCode = code
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('server:build', [viteBin, 'build', '--config', 'vite.server.config.mts', '--watch'])
run('web', [viteBin, '--config', 'vite.web.config.mts'], { WORKBENCH_DEV_API: API })

// 服务端产物要等第一次构建完成：轮询到文件出现再拉起，避免首个请求打到半成品
const startServer = () => {
  if (stopping) return
  if (!existsSync('out/server/index.js')) {
    setTimeout(startServer, 300)
    return
  }
  console.log(`[dev] 服务端 http://127.0.0.1:${PORT}（数据目录 ${DATA_DIR}）`)
  run('server', ['--watch', 'out/server/index.js'], {
    WORKBENCH_PORT: PORT,
    WORKBENCH_DATA_DIR: DATA_DIR,
  })
}
setTimeout(startServer, 300)
