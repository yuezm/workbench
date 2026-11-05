// @vitest-environment node
/**
 * 宿主测试夹具（M3）：把「旧后端形态」的假实现适配成执行器插件。
 *
 * 为什么需要：M2 的 `tests/host/{chat,process-registry}.test.ts` 用
 * `ExecutorBackendOutcome`（多一个 `timeout` 状态、带 requestId/onSpawn）描述执行结果。
 * M3 起执行器是插件、直接返回三值 `Receipt`；这里只在**测试侧**做一次形状适配，
 * 让聊天/进程登记用例仍然按原来的脚本表达「后端返回什么」，不必逐例重写业务断言。
 *
 * 生产路径没有这个适配层：`host/executor.ts` 只做回执归一与续接重试。
 */
import type { RunErrorCode, RunEvent, Runtime, RunUsage } from '../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../src/protocol/executor'
import type { ExecutorContext, ExecutorPlugin, Sdk } from '../../src/sdk/types'

/** 一轮请求（旧后端形态：turn + 派生的协议字段 + 回调） */
export interface TestBackendRequest {
  turn: Turn
  requestId: string
  timeoutMs: number
  signal: AbortSignal
  onEvent: (event: RunEvent) => void
  onSpawn?: (pid: number) => void
}

/** 一轮结果（旧后端形态：`timeout` 由适配成 `failed + errorCode='timeout'`） */
export interface TestBackendOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timeout'
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  exitCode: number | null
  sessionId: string | null
  resumeRejected?: boolean
  usage: RunUsage
  durationMs: number
}

export interface TestBackend {
  execute(request: TestBackendRequest): Promise<TestBackendOutcome>
}

/** 测试用运行时（插件若读 ctx.runtime，拿到的是这一行） */
export const testRuntime = (patch: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-test',
  name: '测试运行时',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...patch,
})

/** 执行器插件不使用能力面：空对象足够（ctx 由包装层原样转发） */
export const testSdk = {} as Sdk

export const testContext = (patch: Partial<Runtime> = {}): ExecutorContext => ({
  runtime: testRuntime(patch),
  sdk: testSdk,
})

/** 旧后端形态 → 执行器插件（timeout 折成 failed + errorCode='timeout'）。 */
export function pluginFromBackend(backend: TestBackend): ExecutorPlugin {
  return {
    async run(_ctx: ExecutorContext, turn: Turn, io: ExecutorIO): Promise<Receipt> {
      const outcome = await backend.execute({
        turn,
        requestId: `${turn.runId}:${turn.turn}:1`,
        timeoutMs: turn.timeoutMs,
        signal: turn.signal,
        onEvent: (event) => io.emit(event),
        onSpawn: (pid) => io.process?.(pid),
      })
      const receipt: Receipt = {
        status: outcome.status === 'timeout' ? 'failed' : outcome.status,
        leaseId: turn.leaseId,
        turn: turn.turn,
        output: outcome.output,
        usage: outcome.usage,
        durationMs: outcome.durationMs,
      }
      if (outcome.sessionId !== null) receipt.sessionId = outcome.sessionId
      if (outcome.error !== null) receipt.error = outcome.error
      const errorCode =
        outcome.status === 'succeeded'
          ? null
          : (outcome.errorCode ?? (outcome.status === 'timeout' ? 'timeout' : 'run_failed'))
      if (errorCode !== null) receipt.errorCode = errorCode
      if (outcome.exitCode !== null) receipt.exitCode = outcome.exitCode
      if (outcome.resumeRejected === true) receipt.resumeRejected = true
      return receipt
    },
  }
}
