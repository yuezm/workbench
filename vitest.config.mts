import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { workspaceAliases } from './scripts/workspace-aliases.mjs'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      ...workspaceAliases,
      { find: '@renderer', replacement: resolve(import.meta.dirname, 'src/renderer/src') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      // 门槛：产品代码四元组全 100%，跌破即 test 失败（提交前由 pre-commit 的 verify:coverage 拦截）
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      // 「项目覆盖率」指产品代码：测试夹具被 import 进来也会被 v8 计入分母
      // （`tests/sim/world.ts` 这类随机世界天然跑不满 100%），口径上不该算。
      exclude: ['tests/**'],
    },
  },
})
