import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 打包冒烟专用的临时 userData：与真实 `%APPDATA%\Workbench` 完全隔离。
 *
 * 刻意不复用 `e2e/helpers/*`：默认 e2e 的隔离方式与本任务并行改造，
 * 打包冒烟要能独立演进，不因跨任务改动互相牵连。
 */
export interface TempUserData {
  dir: string
  cleanup: () => void
}

/** 在系统临时目录下建一个空目录，供打包进程当 userData 用。 */
export function createTempUserData(): TempUserData {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-packaged-'))
  return {
    dir,
    cleanup: () => {
      // Windows 上进程退出后文件句柄可能延迟释放，多留几次重试
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  }
}

/** 目录内容快照：失败信息带上它，能直接看出打包进程到底写了什么。 */
export function describeDir(dir: string): string {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).map(
      (entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`,
    )
    return entries.length === 0 ? '<空目录>' : entries.sort().join(', ')
  } catch (error) {
    return `<目录不存在或不可读: ${String(error)}>`
  }
}
