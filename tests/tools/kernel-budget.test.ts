// @vitest-environment node
/**
 * 内核预算门禁（M37）：`scripts/check-kernel-budget.mjs` 得真的能判定超限。
 *
 * 两条用例：现状通过；伪造一个超预算的 core 文件时必须 exit 1（守卫要能失败才叫守卫）。
 * 伪造在临时副本上做——脚本按 `process.cwd()` 找 `src/kernel`，所以把脚本复制进临时
 * 目录再跑，不改动仓库。
 */
import { execFile } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

const run = (cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [join(cwd, 'scripts/check-kernel-budget.mjs')],
      { cwd },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolvePromise({ code, stdout, stderr })
      },
    )
  })

describe('scripts/check-kernel-budget.mjs', () => {
  it('当前源码在预算内', async () => {
    const result = await run(ROOT)
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.stdout).toContain('kernel-budget: core')
    expect(result.stdout).toContain('kernel-budget: decide.ts')
  }, 60_000)

  it('core 超预算时 exit 1 并指名文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-budget-'))
    try {
      cpSync(
        join(ROOT, 'scripts/check-kernel-budget.mjs'),
        join(dir, 'scripts/check-kernel-budget.mjs'),
        {
          recursive: true,
        },
      )
      cpSync(join(ROOT, 'src/kernel'), join(dir, 'src/kernel'), { recursive: true })
      // 2000 行预算：写 2100 行塞进 core
      writeFileSync(join(dir, 'src/kernel/core/blob.ts'), 'export const x = 1\n'.repeat(2_100))
      const result = await run(dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('core/ 合计')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
