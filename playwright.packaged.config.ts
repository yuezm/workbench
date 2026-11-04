import { defineConfig } from '@playwright/test'

/**
 * 打包冒烟专用配置：只跑 `e2e-packaged/`，对 electron-builder 产物
 * （`dist/win-unpacked/Workbench.exe`）启动真实打包后的 Electron。
 *
 * 与默认 `playwright.config.ts`（testDir `./e2e`）互不收取用例；用 Electron
 * 自带 Chromium，不下载 Playwright 浏览器。打包产物冷启动比 `electron .` 慢，
 * 单条用例超时放宽到 120s。
 */
export default defineConfig({
  testDir: './e2e-packaged',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/packaged',
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
