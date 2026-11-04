import { defineConfig } from '@playwright/test'

/**
 * E2E 面向构建产物（out/）里的真实 Electron 应用，由 `pnpm e2e` 先 build 再跑。
 * 用 Electron 自带 Chromium，不下载任何 Playwright 浏览器。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
