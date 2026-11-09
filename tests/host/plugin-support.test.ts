// @vitest-environment node
/**
 * `tests/host/plugin-support.ts` 这层**测试侧**适配器自己的用例。
 *
 * 它把「旧后端形态」的执行结果适配成执行器插件的回执：timeout 折成
 * `failed + errorCode='timeout'`、退出码 / 会话 / 续接拒绝标志按缺省透传。
 * 这层代码也被计入覆盖率，所以适配规则本身要有钉子用例。
 */
import { describe, expect, it } from 'vitest'
import type { ExecutorIO, Turn } from '../../src/protocol/executor'
import { pluginFromBackend, testContext, type TestBackendOutcome } from './plugin-support'

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }

const outcomeOf = (over: Partial<TestBackendOutcome> = {}): TestBackendOutcome => ({
  status: 'succeeded',
  output: '',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  resumeRejected: false,
  usage,
  durationMs: 1,
  ...over,
})

const turnOf = (): Turn => ({
  runId: 'run-1',
  leaseId: 'run-1:1',
  turn: 1,
  purpose: 'stage',
  prompt: 'p',
  cwd: '',
  access: 'edit',
  timeoutMs: 1_000,
  signal: new AbortController().signal,
})

const ioOf = (): ExecutorIO => ({ emit: () => undefined })

describe('pluginFromBackend（旧后端形态 → 执行器插件）', () => {
  it('timeout：折成 failed + errorCode=timeout；退出码缺省时不写进回执', async () => {
    const plugin = pluginFromBackend({
      execute: async () => outcomeOf({ status: 'timeout', errorCode: null, exitCode: null }),
    })

    const receipt = await plugin.run(testContext(), turnOf(), ioOf())
    expect(receipt).toMatchObject({ status: 'failed', errorCode: 'timeout' })
    // 退出码缺省 = 后端没报，不凭空补一个
    expect(receipt.exitCode).toBeUndefined()
  })

  it('后端自带 errorCode / exitCode：原样透传（不按 timeout 规则改写）', async () => {
    const plugin = pluginFromBackend({
      execute: async () =>
        outcomeOf({ status: 'failed', errorCode: 'run_failed', exitCode: 3, error: '炸了' }),
    })

    const receipt = await plugin.run(testContext(), turnOf(), ioOf())
    expect(receipt).toMatchObject({
      status: 'failed',
      errorCode: 'run_failed',
      exitCode: 3,
      error: '炸了',
    })
  })

  it('成功：会话 id 与「续接被拒」标志透传', async () => {
    const plugin = pluginFromBackend({
      execute: async () => outcomeOf({ sessionId: 'sess-1', resumeRejected: true, output: '好了' }),
    })

    const receipt = await plugin.run(testContext(), turnOf(), ioOf())
    expect(receipt).toMatchObject({
      status: 'succeeded',
      output: '好了',
      sessionId: 'sess-1',
      resumeRejected: true,
    })
  })
})
