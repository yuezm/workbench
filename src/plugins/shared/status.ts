/**
 * 终态归一（插件共享纯函数）：协议 result 帧的 `status` 词表 → 执行器内部状态。
 *
 * 归一后的状态比回执多一个 `timeout`：回执状态只有 succeeded/failed/cancelled
 * （`protocol/entities.ts` 的 `RUN_TERMINAL_STATUSES`），插件在产出回执时把
 * `timeout` 折成 `failed` + `errorCode='timeout'`。
 */

/** 执行器内部终态（含 timeout） */
export type NormalizedRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout'

/** result 帧 status → 执行器内部终态（大小写与空值都做归一） */
export function mapResultStatus(status: string | undefined): NormalizedRunStatus {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'completed':
    case 'succeeded':
    case 'success':
      return 'succeeded'
    case 'cancelled':
    case 'canceled':
    case 'aborted':
      return 'cancelled'
    case 'timeout':
    case 'timed_out':
      return 'timeout'
    default:
      return 'failed'
  }
}
