// @vitest-environment node
/**
 * 崩溃仿真入口（计划 M35-A）：只跑 2 轮，够验证脚本本身是绿的。
 * 放大用 `node scripts/sim-crash.mjs 200`（真强杀进程，走 vite SSR 加载 TS）。
 */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [resolve(ROOT, 'scripts/sim-crash.mjs'), ...args],
      { cwd: ROOT, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolvePromise({ code, stdout, stderr })
      },
    )
  })

describe('sim：强杀写进程', () => {
  it('强杀两轮后事实不丢、投影自愈、不变量成立', async () => {
    const result = await run(['2', '11'])
    expect(result.stderr, result.stderr).not.toContain('FAILED')
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.stdout).toContain('crash-sim ok')
    expect(result.stdout).toMatch(/restarts=2 facts=\d+/)
  }, 120_000)
})
