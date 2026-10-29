import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      // 阈值略低于 2026-10 基线（99.3/95.5/97.9/99.2），跌破即 test 失败
      thresholds: {
        statements: 98,
        branches: 93,
        functions: 95,
        lines: 98,
      },
    },
  },
})
