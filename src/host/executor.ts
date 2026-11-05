/**
 * 执行器端口包装（M3）：把执行器插件的一轮结果归一成 `ExecutorPort` 回执。
 *
 * 分层：`plugins/executors/<id>` 只实现 `ExecutorPlugin`（probe/models/run），
 * 宿主在这里补齐两条**通用**行为，避免每个插件各写一遍：
 *
 * - 续接被拒：`resume_rejected` → 清掉续接会话、用完整历史提示词（`fallbackPrompt`）重试一次；
 *   仍被拒按 `failed` 收口（SPEC-plugins「executor」）。
 * - 聊天失败文案：失败轮次没给 `error` 时补「执行失败」（旧 ChatService 口径）。
 *
 * 终态归一（`timeout → failed + errorCode='timeout'`）属于协议适配，由插件内部完成；
 * 宿主只做兜底 `errorCode` 补齐，避免插件漏字段导致 `runs.error_code` 为空。
 *
 * 本模块只依赖 `protocol` 与 `sdk` 的类型，不 import 具体插件（ESLint 强制）。
 */
import type { RunErrorCode } from '../protocol/entities'
import type { ExecutorIO, ExecutorPort, Receipt, Turn } from '../protocol/executor'
import type { ExecutorContext, ExecutorPlugin } from '../sdk/types'

/** 失败兜底归类：插件没给 errorCode 时按状态补一个（成功为 null）。 */
const errorCodeOf = (receipt: Receipt): RunErrorCode | null => {
  if (receipt.status === 'succeeded') return null
  if (receipt.errorCode !== undefined) return receipt.errorCode
  return receipt.status === 'cancelled' ? 'cancelled' : 'run_failed'
}

/** 回执归一：补 `leaseId/turn`（插件本应原样带回，漏了就由包装层兜底）。 */
const normalizeReceipt = (turn: Turn, receipt: Receipt): Receipt => {
  const next: Receipt = {
    ...receipt,
    leaseId: receipt.leaseId ?? turn.leaseId,
    turn: receipt.turn ?? turn.turn,
  }
  if (next.status === 'failed' && next.error === undefined && turn.purpose === 'chat') {
    next.error = '执行失败'
  }
  const errorCode = errorCodeOf(next)
  if (errorCode !== null) next.errorCode = errorCode
  else delete next.errorCode
  return next
}

export interface ExecutorPortOptions {
  /** 续接被拒时换新会话重试一次（默认 true） */
  retryOnResumeRejected?: boolean
}

/**
 * 把一个执行器插件包装成 `ExecutorPort`。
 *
 * `ctx` 由装配根按运行时配置构造（runtime + plugin 专属 sdk）；`probe/models`
 * 缺省时给出可读结论而不是抛错（执行器可以只支持执行，不支持探测）。
 */
export function createExecutorPort(
  plugin: ExecutorPlugin,
  ctx: ExecutorContext,
  options: ExecutorPortOptions = {},
): ExecutorPort {
  const retryOnResumeRejected = options.retryOnResumeRejected ?? true

  const noProbe = async (): Promise<never> => {
    throw new Error('执行器不支持探测: ' + ctx.runtime.executorKey)
  }

  return {
    probe: plugin.probe === undefined ? noProbe : (runtime) => plugin.probe!({ ...ctx, runtime }),
    models:
      plugin.models === undefined
        ? async () => []
        : (runtime) => plugin.models!({ ...ctx, runtime }),
    async run(turn: Turn, io: ExecutorIO): Promise<Receipt> {
      const first = normalizeReceipt(turn, await plugin.run(ctx, turn, io))
      const resumeSessionId = turn.resumeSessionId ?? null
      const shouldRetry =
        retryOnResumeRejected &&
        first.resumeRejected === true &&
        resumeSessionId !== null &&
        !turn.signal.aborted
      if (!shouldRetry) return first

      // 续接已失效：换新会话、带完整历史提示词重试一次（聊天续接轮只发新消息，
      // 重试必须回退到整段历史的 prompt，否则 CLI 看不到前文——旧 ChatService 同口径）
      const retryTurn: Turn = {
        ...turn,
        resumeSessionId: null,
        prompt: turn.fallbackPrompt ?? turn.prompt,
      }
      const second = normalizeReceipt(turn, await plugin.run(ctx, retryTurn, io))
      if (second.resumeRejected !== true) return second
      // 取消/超时优先于「续接仍被拒」：不把已取消的轮次改写成 failed
      if (second.status === 'cancelled') return second
      // 仍被拒：按 failed 落库（重试一次后不再重试）
      return normalizeReceipt(turn, { ...second, status: 'failed', errorCode: 'run_failed' })
    },
  }
}
