import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * e2e 启动封装：每次启动都用独立临时 userData，用例之间、用例与本机已开实例之间互不干扰
 * （单实例锁以 userData 为作用域）。临时目录在关闭时删除，不读写真机 %APPDATA%。
 */
export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  /** 本次启动专用的临时 userData 目录，供断言启动隔离 */
  userDataDir: string
  /** 关闭应用并删除临时 userData 目录 */
  close: () => Promise<void>
}

/**
 * 从 Electron/IPC 宿主终端继承的 ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node，
 * 主进程直接起不来；这里给子进程一份去掉该变量的环境。
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  return env
}

/** Windows 上进程退出后句柄可能延迟释放，删除重试几次，避免 afterEach 偶发失败 */
function removeUserDataDir(userDataDir: string): void {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'workbench-e2e-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      env: childEnv(),
    })
    const page = await app.firstWindow()
    return {
      app,
      page,
      userDataDir,
      close: async () => {
        try {
          await app?.close()
        } finally {
          removeUserDataDir(userDataDir)
        }
      },
    }
  } catch (error) {
    if (app) await app.close().catch(() => undefined)
    removeUserDataDir(userDataDir)
    throw error
  }
}
