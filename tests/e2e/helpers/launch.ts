import { chromium, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { seedChannelIsolation } from '../../support/channel-isolation'

/**
 * e2e 启动封装（服务器形态）：每个用例起一个独立服务进程 + 一个 Chromium 页面。
 *
 * 隔离靠数据目录：`WORKBENCH_DATA_DIR` 指向一次性临时目录（库、产物、插件、密钥全在里面），
 * 端口用 `WORKBENCH_PORT=0` 由系统分配——用例之间、用例与本机常驻实例之间互不干扰，
 * 也不会读写 `~/.workbench`。
 *
 * 另外在启动前把外部通道（飞书）停用：临时数据目录隔离不到 `~/.lark-cli` 的真实登录态，
 * 不停用就会把测试库里的 ask 卡真的发到本人飞书（见 `tests/support/channel-isolation.ts`）。
 */
export interface LaunchedApp {
  browser: Browser
  page: Page
  /** 本次启动专用的临时数据目录，供断言启动隔离 */
  userDataDir: string
  /** 服务端启动日志（诊断用） */
  logs: () => string
  /** 应用数据库文件（崩溃恢复等用例需要预置/复查投影） */
  dbPath: string
  /** 关闭页面与服务；默认连临时数据目录一起删（重启用例可传 `removeUserData: false` 保留） */
  close: (options?: { removeUserData?: boolean }) => Promise<void>
}

/** 新建一个空的临时数据目录（崩溃恢复用例要在启动前把种子库写进去）。 */
export function createTempUserDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'workbench-e2e-'))
}

export interface LaunchOptions {
  /** 复用已存在的数据目录（崩溃恢复用例重启同一份数据）；缺省新建临时目录 */
  userDataDir?: string
  /** 启动前准备数据目录（例如用真实 openDatabase/createStore 写入种子库） */
  prepare?: (userDataDir: string) => void | Promise<void>
}

/** 服务端打印的固定格式：`workbench listening on http://127.0.0.1:PORT` */
const LISTENING = /workbench listening on (http:\/\/\S+)/u

/** Windows 上进程退出后句柄可能延迟释放，删除重试几次，避免 afterEach 偶发失败 */
function removeUserDataDir(userDataDir: string): void {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/** 等第一行 `listening on`；超时把服务端日志一起带出来（不然只有一句 60s 超时） */
function waitForUrl(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ url: string; read: () => string }> {
  let buffer = ''
  const read = (): string => buffer
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`服务在 ${timeoutMs}ms 内没有监听：\n${buffer}`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const match = LISTENING.exec(buffer)
      if (match?.[1] !== undefined) {
        cleanup()
        resolve({ url: match[1], read })
      }
    }
    const onExit = (code: number | null): void => {
      cleanup()
      reject(new Error(`服务进程提前退出（code=${String(code)}）：\n${buffer}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', onExit)
  })
}

/** 停服务：先 SIGTERM 走优雅退出，超时再强杀（Windows 上 SIGTERM 即终止进程） */
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 5_000)
  await exited
  clearTimeout(timer)
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? createTempUserDataDir()
  const workdir = path.join(userDataDir, 'workdir')
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    await options.prepare?.(userDataDir)
    // 隔离必须在服务启动之后、`channels.startAll()` 之前完成——也就是这里。
    // 放在 `prepare` 之后：spec 自己的种子先写，隔离再整批覆盖一次，谁也「打开」不了外部通道。
    seedChannelIsolation(path.join(userDataDir, 'ai-workflow.db'))
    child = spawn(process.execPath, ['out/server/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKBENCH_DATA_DIR: userDataDir,
        WORKBENCH_PORT: '0',
        WORKBENCH_HOST: '127.0.0.1',
        WORKBENCH_WEB_DIR: path.resolve('out/web'),
        WORKBENCH_WORKDIR: workdir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const { url, read } = await waitForUrl(child, 60_000)
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
    await page.goto(url)
    return {
      browser,
      page,
      userDataDir,
      logs: read,
      dbPath: path.join(userDataDir, 'ai-workflow.db'),
      close: async (closeOptions = {}) => {
        try {
          await browser?.close()
          if (child !== undefined) await stopServer(child)
        } finally {
          if (closeOptions.removeUserData ?? true) removeUserDataDir(userDataDir)
        }
      },
    }
  } catch (error) {
    if (browser) await browser.close().catch(() => undefined)
    if (child !== undefined) await stopServer(child).catch(() => undefined)
    removeUserDataDir(userDataDir)
    throw error
  }
}
