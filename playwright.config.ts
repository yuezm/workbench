import { defineConfig } from '@playwright/test'

/**
 * E2E 面向构建产物：`pnm e2e` 先 build，再由每个用例的 launch 夹具起一个独立服务进程
 * （`out/server/index.js` + 一次性数据目录）和 Chromium 页面。
 *
 * 不用 `webServer`：用例之间需要互不共享的数据目录与库状态，服务必须按用例起停；
 * 端口用 `WORKBENCH_PORT=0` 由系统分配，避免撞上本机常驻实例。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
})
