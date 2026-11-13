import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.mts'

/**
 * 变异测试专用的 vitest 配置。
 *
 * 为什么要单独一份：Stryker 的 vitest runner 每个变异体都要起一次 vitest 进程，
 * 高并发下单个测试的墙钟耗时会被拉长（实测并发 10 时每个变异体约 5 秒），
 * vitest 默认 5 秒的 per-test 超时会把「跑得慢」误判成「用例失败」——
 * 而 Stryker 把超时计作 killed，评分就会虚高。
 *
 * 这里只放宽超时，不动任何断言、包含范围与 setupFiles（后者从主配置继承，
 * 不会漂移）。
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      testTimeout: 30000,
      hookTimeout: 30000,
      teardownTimeout: 30000,
    },
  }),
)
