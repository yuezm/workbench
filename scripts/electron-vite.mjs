#!/usr/bin/env node
// electron-vite.mjs — 以干净环境启动 electron-vite，剔除会破坏 Electron 启动的继承变量。
// 用法: node scripts/electron-vite.mjs <dev|build|preview> [...args]
// 背景: 宿主进程若在环境里留下 ELECTRON_RUN_AS_NODE=1，electron.exe 会退化成纯 Node，
//       主进程拿不到 app 对象（out/main/index.js: Cannot read properties of undefined
//       (reading 'requestSingleInstanceLock')）。这里在 spawn 前删掉该变量。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const bin = path.resolve(here, '../node_modules/electron-vite/bin/electron-vite.js')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
})

child.on('error', (err) => {
  console.error('electron-vite: ' + err.message)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
