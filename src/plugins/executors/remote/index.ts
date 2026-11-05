/**
 * `remote` 执行器插件入口（D12）：把宿主注入的远端传输装配成 `ExecutorPlugin`。
 *
 * 边界（M7 架构位）：
 * - **不 spawn、不连网、不监听端口**：一轮执行全部交给 `RemoteTransport.execute`，
 *   事件与回执由传输写回；插件只做「无传输时的明确失败」与「回执字段兜底」。
 * - 无传输时回执 `failed{runtime_missing}`，不抛错（宿主按回执落终态，UI 有可读文案）。
 * - abort 后不再 emit 是传输的责任；插件把 `turn.signal` 原样传下去，不重复拦截。
 * - 回执的 `leaseId` / `turn` 原样带回是内核拒绝迟到尝试的依据（D15）；传输漏字段时
 *   由这里用 `Turn` 兜底，与宿主包装层同口径。
 */
import type { Receipt, Turn } from '../../../protocol/executor'
import type { RemoteTransport } from '../../../protocol/worker'
import type { ExecutorPlugin } from '../../../sdk/types'

/** 无传输时的回执文案：明确「没配置」而不是「执行失败」 */
const RUNTIME_MISSING_ERROR = '远端 Worker 传输未配置'

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 回执字段兜底：传输漏了 `leaseId` / `turn` 时按本轮 `Turn` 补齐（不一致保持原样，交内核拒绝）。 */
const withLease = (turn: Turn, receipt: Receipt): Receipt => ({
  ...receipt,
  leaseId: receipt.leaseId ?? turn.leaseId,
  turn: receipt.turn ?? turn.turn,
})

/**
 * 按注入的传输创建执行器；`null` = 未配置（M7 注册表即以 `null` 装配）。
 *
 * 每次调用返回新的插件实例，测试可以各用各的假传输；插件不持有可变状态。
 */
export function createRemoteExecutor(transport: RemoteTransport | null): ExecutorPlugin {
  return {
    async run(_ctx, turn: Turn, io): Promise<Receipt> {
      if (transport === null) {
        return {
          status: 'failed',
          leaseId: turn.leaseId,
          turn: turn.turn,
          errorCode: 'runtime_missing',
          error: RUNTIME_MISSING_ERROR,
        }
      }

      try {
        return withLease(turn, await transport.execute(turn, io, turn.signal))
      } catch (error) {
        // 传输异常（worker 掉线 / 帧解析失败等）：归一成 failed，不把异常抛给宿主调度
        return {
          status: 'failed',
          leaseId: turn.leaseId,
          turn: turn.turn,
          errorCode: 'executor_lost',
          error: errMsg(error),
        }
      }
    },
  }
}

export { remoteManifest } from './manifest'
