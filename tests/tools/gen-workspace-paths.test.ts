// @vitest-environment node
/**
 * 包路径生成器（拆分方案 §5）：`@workbench/*` 的解析只认各包 package.json。
 *
 * 生成器坏掉的表现是「加了包但别名没跟上」——跑起来才炸。所以这里既要证明它能产出正确的
 * paths/aliases（含子路径通配与根入口），也要证明它在漂移与非法包结构上会 exit 1。
 */
import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

interface Fixture {
  dir: string
  run: (args?: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  read: (path: string) => string
}

function fixture(files: Record<string, string>): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gen-paths-'))
  cpSync(
    join(ROOT, 'scripts/gen-workspace-paths.mjs'),
    join(dir, 'scripts/gen-workspace-paths.mjs'),
    { recursive: true },
  )
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return {
    dir,
    run: (args = []) =>
      new Promise((done) => {
        execFile(
          process.execPath,
          [join(dir, 'scripts/gen-workspace-paths.mjs'), ...args],
          { cwd: dir },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
            done({ code, stdout, stderr })
          },
        )
      }),
    read: (path) => readFileSync(join(dir, path), 'utf8'),
  }
}

const pkg = (name: string): string =>
  JSON.stringify({ name, version: '0.0.0', private: true }, null, 2)

const tree: Record<string, string> = {
  'packages/core/protocol/package.json': pkg('@workbench/protocol'),
  'packages/core/protocol/src/index.ts': 'export const a = 1\n',
  'packages/client/shell/package.json': pkg('@workbench/client-shell'),
  'packages/client/shell/src/index.ts': 'export const b = 2\n',
  'apps/server/package.json': pkg('@workbench/server'),
  'apps/server/src/index.ts': 'export const c = 3\n',
}

describe('scripts/gen-workspace-paths.mjs', () => {
  it('空仓库产出空 paths 与空别名', async () => {
    const box = fixture({})
    try {
      const result = await box.run()
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(box.read('tsconfig.paths.json').replace(/^\/\/.*\n/, ''))).toEqual({
        compilerOptions: { paths: {} },
      })
      expect(box.read('scripts/workspace-aliases.mjs')).toContain(
        'export const workspaceAliases = []',
      )
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('按包清单产出 tsconfig paths 与 vite 别名（根入口 + 子路径通配）', async () => {
    const box = fixture(tree)
    try {
      const result = await box.run()
      expect(result.code, result.stderr).toBe(0)
      const paths = JSON.parse(box.read('tsconfig.paths.json').replace(/^\/\/.*\n/, ''))
      expect(paths.compilerOptions.paths).toEqual({
        '@workbench/client-shell': ['./packages/client/shell/src/index.ts'],
        '@workbench/client-shell/*': ['./packages/client/shell/src/*'],
        '@workbench/protocol': ['./packages/core/protocol/src/index.ts'],
        '@workbench/protocol/*': ['./packages/core/protocol/src/*'],
        '@workbench/server': ['./apps/server/src/index.ts'],
        '@workbench/server/*': ['./apps/server/src/*'],
      })
      const aliases = box.read('scripts/workspace-aliases.mjs')
      // 包名里的 `/` 必须转义，否则正则字面量在 `@workbench/` 处提前结束（vite 会直接起不来）
      expect(aliases).toContain(
        "{ find: /^@workbench\\/protocol\\/(.*)$/, replacement: resolve(ROOT, 'packages/core/protocol/src/$1') },",
      )
      expect(aliases).toContain(
        "{ find: /^@workbench\\/protocol$/, replacement: resolve(ROOT, 'packages/core/protocol/src/index.ts') },",
      )
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('手写 paths（tsconfig.paths.extra.json）并入生成结果', async () => {
    const box = fixture({
      ...tree,
      'tsconfig.paths.extra.json': JSON.stringify({
        compilerOptions: { paths: { '@renderer/*': ['./src/renderer/src/*'] } },
      }),
    })
    try {
      expect((await box.run()).code).toBe(0)
      const paths = JSON.parse(box.read('tsconfig.paths.json').replace(/^\/\/.*\n/, ''))
      expect(paths.compilerOptions.paths['@renderer/*']).toEqual(['./src/renderer/src/*'])
      expect(paths.compilerOptions.paths['@workbench/protocol']).toEqual([
        './packages/core/protocol/src/index.ts',
      ])
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('--check 在派生文件漂移时 exit 1', async () => {
    const box = fixture(tree)
    try {
      expect((await box.run()).code).toBe(0)
      writeFileSync(join(box.dir, 'scripts/workspace-aliases.mjs'), '// 手改过的别名\n')
      const result = await box.run(['--check'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('workspace-aliases.mjs')
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('包缺 src 目录时 exit 1 并指名', async () => {
    const box = fixture({
      'packages/core/protocol/package.json': pkg('@workbench/protocol'),
    })
    try {
      const result = await box.run()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('src/')
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('包名不在 @workbench/ 作用域下时 exit 1', async () => {
    const box = fixture({
      'packages/core/protocol/package.json': pkg('protocol'),
      'packages/core/protocol/src/index.ts': 'export const a = 1\n',
    })
    try {
      const result = await box.run()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('@workbench/')
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  }, 60_000)
})
