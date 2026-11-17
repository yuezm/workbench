// @vitest-environment node
/**
 * 包边界门禁（拆分方案 B0）：`scripts/check-packages.mjs` 得真的能判定越界。
 *
 * 三条检测各有正反两组用例——manifest 方向、headless 闭包、跨包相对 import。
 * 伪造在临时目录上做：脚本以「自身所在目录的上一级」为仓库根，所以整体复制过去即可，
 * 不动仓库里的真实结构（与 kernel-budget.test.ts 同款手法）。
 */
import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** 在临时目录里造一个假仓库：`files` 是「相对路径 → 内容」。 */
function fixture(files: Record<string, string>): { dir: string; run: () => Promise<RunResult> } {
  const dir = mkdtempSync(join(tmpdir(), 'check-packages-'))
  cpSync(join(ROOT, 'scripts/check-packages.mjs'), join(dir, 'scripts/check-packages.mjs'), {
    recursive: true,
  })
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const run = (): Promise<RunResult> =>
    new Promise((done) => {
      execFile(
        process.execPath,
        [join(dir, 'scripts/check-packages.mjs'), '--json'],
        { cwd: dir },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
          done({ code, stdout, stderr })
        },
      )
    })
  return { dir, run }
}

const manifest = (name: string, deps: Record<string, string> = {}): string =>
  JSON.stringify({ name, version: '0.0.0', dependencies: deps }, null, 2)

/** 合法的服务端骨架：server → bundle/base → host → kernel；client 在另一条枝上。 */
const healthyTree: Record<string, string> = {
  'packages/core/protocol/package.json': manifest('@workbench/protocol'),
  'packages/core/kernel/package.json': manifest('@workbench/kernel', {
    '@workbench/protocol': 'workspace:*',
  }),
  'packages/host/host/package.json': manifest('@workbench/host', {
    '@workbench/kernel': 'workspace:*',
    '@workbench/protocol': 'workspace:*',
  }),
  'packages/bundle/base/package.json': manifest('@workbench/bundle-base', {
    '@workbench/host': 'workspace:*',
    '@workbench/kernel': 'workspace:*',
  }),
  'packages/bundle/web/package.json': manifest('@workbench/bundle-web', {
    '@workbench/bundle-base': 'workspace:*',
  }),
  'packages/client/shell/package.json': manifest('@workbench/client-shell', {
    '@workbench/protocol': 'workspace:*',
  }),
  'apps/server/package.json': manifest('@workbench/server', {
    '@workbench/bundle-base': 'workspace:*',
    '@workbench/bundle-web': 'workspace:*',
  }),
  'apps/web/package.json': manifest('@workbench/web', {
    '@workbench/client-shell': 'workspace:*',
  }),
  'packages/host/host/src/index.ts':
    "import type { View } from '@workbench/protocol'\nimport { helper } from './helper'\nexport const x = helper\n",
  'packages/host/host/src/helper.ts': 'export const helper = 1\n',
}

describe('scripts/check-packages.mjs', () => {
  it('没有任何包时跳过检查（拆分前 / 空仓库）', async () => {
    const { dir, run } = fixture({})
    try {
      const result = await run()
      expect(result.code, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout) as { packages: unknown[]; problems: string[] }
      expect(report.packages).toEqual([])
      expect(report.problems).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('真实仓库通过（拆分进行中也必须没有越界）', async () => {
    const result = await new Promise<RunResult>((done) => {
      execFile(
        process.execPath,
        [join(ROOT, 'scripts/check-packages.mjs'), '--json'],
        { cwd: ROOT },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
          done({ code, stdout, stderr })
        },
      )
    })
    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { problems: string[] }
    expect(report.problems).toEqual([])
  }, 60_000)

  it('合法树通过并列出包清单', async () => {
    const { dir, run } = fixture(healthyTree)
    try {
      const result = await run()
      expect(result.code, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout) as { packages: unknown[]; problems: string[] }
      expect(report.packages).toHaveLength(8)
      expect(report.problems).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('host 直接依赖 client 时判定越界', async () => {
    const { dir, run } = fixture({
      ...healthyTree,
      'packages/host/host/package.json': manifest('@workbench/host', {
        '@workbench/kernel': 'workspace:*',
        '@workbench/client-shell': 'workspace:*',
      }),
    })
    try {
      const result = await run()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('依赖方向不允许')
      expect(result.stderr).toContain('@workbench/client-shell')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('服务端装配闭包里混进 client 时判定违规', async () => {
    const { dir, run } = fixture({
      ...healthyTree,
      // bundle/base 自己没写 client，但 host 里塞了：闭包检查要穿透
      'packages/host/host/package.json': manifest('@workbench/host', {
        '@workbench/kernel': 'workspace:*',
        '@workbench/client-shell': 'workspace:*',
      }),
      'packages/client/shell/package.json': manifest('@workbench/client-shell'),
    })
    try {
      const result = await run()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('没有 Web 端')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('跨包相对 import 时判定越界（必须写包名）', async () => {
    const { dir, run } = fixture({
      ...healthyTree,
      'packages/host/host/src/index.ts': "import { decide } from '../../core/kernel/src/decide'\n",
    })
    try {
      const result = await run()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('越过包边界')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('包名不在 @workbench/ 作用域下时判定违规', async () => {
    const { dir, run } = fixture({
      ...healthyTree,
      'packages/util/atomic-write/package.json': manifest('atomic-write'),
    })
    try {
      const result = await run()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('必须')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
