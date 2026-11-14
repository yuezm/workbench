// @vitest-environment node
/**
 * 性能基线脚本的冒烟（M36-G）：小规模真跑一遍，确保 `scripts/bench.mjs` 没腐化。
 *
 * 不断言具体毫秒数（机器差异会让它变成假红），只断言「表格结构齐全、关键数字 > 0」；
 * 基线数字写在 `docs/testing/PERF.md`，由人跑完整规模后更新。
 */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [resolve(ROOT, 'scripts/bench.mjs'), ...args],
      { cwd: ROOT, timeout: 180_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolvePromise({ code, stdout, stderr })
      },
    )
  })

describe('scripts/bench.mjs', () => {
  it('小规模跑通并输出指标表', async () => {
    const result = await run(['--facts=2000', '--tasks=200', '--samples=10'])
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.stdout).toContain('| 指标 | 实测 |')
    expect(result.stdout).toMatch(/\| 事实条数 \| 2000 \|/)
    expect(result.stdout).toMatch(/\| 任务数 \| 200 \|/)
    expect(result.stdout).toMatch(/\| 装载 \+ decide p99 \| [1-9][\d.]* ms \|/)
    expect(result.stdout).toMatch(/\| 全量重建 \| [1-9][\d.]* ms \|/)
  }, 180_000)

  it('--json 给机器可读结果', async () => {
    const result = await run(['--facts=500', '--tasks=50', '--samples=3', '--json'])
    expect(result.code, result.stderr).toBe(0)
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, number>
    expect(parsed['facts']).toBe(500)
    expect(parsed['decideP99Ms']).toBeGreaterThan(0)
    expect(parsed['dbBytes']).toBeGreaterThan(0)
  }, 180_000)
})
