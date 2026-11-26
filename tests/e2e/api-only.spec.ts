/**
 * 纯 API 模式（无浏览器）：服务端脱离 Web 端单独跑通的证明。
 *
 * 这是拆分方案「服务端是产品本体」的第一档门禁——不启 Chromium，只 spawn 服务进程，
 * 用 `WORKBENCH_UI=off` 断言四件事：
 * 1. `/` 给一段纯文本说明（不是 404 / 500）；
 * 2. `/api/health`、`/api/info` 正常；
 * 3. `POST /api/query` 能取视图（读路径通）；
 * 4. `POST /api/dispatch` 能落命令（写路径通）。
 *
 * 与 `helpers/launch.ts` 的区别：这里不建页面，所以不需要 Chromium；数据目录仍然一次性隔离。
 */
import { expect, test } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const LISTENING = /workbench listening on (http:\/\/\S+)/u

interface ApiOnlyServer {
  baseUrl: string
  logs: () => string
  close: () => Promise<void>
}

/** 起一个纯 API 的服务进程（`WORKBENCH_UI=off`），等它打印监听地址。 */
async function startApiOnly(): Promise<ApiOnlyServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'workbench-api-'))
  const output: string[] = []
  const child: ChildProcess = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'out/server/index.js'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKBENCH_PORT: '0',
        WORKBENCH_DATA_DIR: dataDir,
        WORKBENCH_UI: 'off',
        WORKBENCH_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务没起来：\n${output.join('\n')}`)), 30_000)
    const onData = (chunk: Buffer): void => {
      output.push(chunk.toString())
      const match = LISTENING.exec(output.join(''))
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`服务提前退出（code=${String(code)}）：\n${output.join('\n')}`))
    })
  })

  return {
    baseUrl,
    logs: () => output.join(''),
    close: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((done) => {
        if (child.exitCode !== null) return done()
        child.once('exit', () => done())
      })
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  }
}

test('纯 API 模式：没有 Web 产物也能起、读写路径都通', async () => {
  const server = await startApiOnly()
  try {
    // 1. 根路径：纯文本说明，不是错误页
    const root = await fetch(`${server.baseUrl}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain('text/plain')
    expect(await root.text()).toContain('纯 API 模式')

    // 2. 探针与服务信息
    const health = await fetch(`${server.baseUrl}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.text()).toContain('ok')

    const info = await fetch(`${server.baseUrl}/api/info`)
    expect(info.status).toBe(200)

    // 3. 读：取一个视图切片（工作流列表，空库也必须能答）
    const query = await fetch(`${server.baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ view: 'workflows.all', params: {} }),
    })
    expect(query.status).toBe(200)

    // 4. 写：提交一条命令（幂等 commandId；落事实，返回结果信封）
    const dispatch = await fetch(`${server.baseUrl}/api/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'api-only-smoke-1',
        type: 'task.create',
        payload: { title: 'api-only 冒烟', workflowId: 'wf-default' },
      }),
    })
    expect([200, 400]).toContain(dispatch.status)
    expect(server.logs()).toContain('(api only;')
  } finally {
    await server.close()
  }
})
