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
  /** 应用数据库文件（崩溃恢复等用例需要预置/复查投影） */
  dbPath: string
  /** 关闭应用；默认连临时 userData 一起删（重启用例可传 `removeUserData: false` 保留） */
  close: (options?: { removeUserData?: boolean }) => Promise<void>
}

/** 新建一个空的临时 userData 目录（崩溃恢复用例要在启动前把种子库写进去）。 */
export function createTempUserDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'workbench-e2e-'))
}

export interface LaunchOptions {
  /** 复用已存在的 userData（崩溃恢复用例重启同一份数据）；缺省新建临时目录 */
  userDataDir?: string
  /** 启动前准备 userData（例如用真实 openDatabase/createStore 写入种子库） */
  prepare?: (userDataDir: string) => void | Promise<void>
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

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? createTempUserDataDir()
  let app: ElectronApplication | undefined
  try {
    await options.prepare?.(userDataDir)
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      env: childEnv(),
    })
    const page = await app.firstWindow()
    return {
      app,
      page,
      userDataDir,
      dbPath: path.join(userDataDir, 'ai-workflow.db'),
      close: async (closeOptions = {}) => {
        try {
          await app?.close()
        } finally {
          if (closeOptions.removeUserData ?? true) removeUserDataDir(userDataDir)
        }
      },
    }
  } catch (error) {
    if (app) await app.close().catch(() => undefined)
    removeUserDataDir(userDataDir)
    throw error
  }
}
