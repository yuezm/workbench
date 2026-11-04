/**
 * 下一次唤醒时刻（纯函数）：宿主只挂一个定时器，`nextWakeAt` 给出最早到期的未来时刻。
 *
 * 关注三类到期：`running` 的租约（心跳失败 → `run.abandoned`）、`running` 的
 * `deadlineAt`（整体超时 → `run.failed{timeout}`）、`queued` 的 `notBefore`（退避到期后
 * 重新可领取）。`waiting` 已释放租约与超时时刻，不参与。
 *
 * 已过去（≤ now）的时刻不算「下一次」：它们应由当前这轮 `clock.tick` 处理完，
 * 宿主再用本函数重新计算下一跳，避免定时器空转。
 */
import type { Environment, Iso, View } from './types'

export function nextWakeAt(view: View, now: Iso, _env: Environment): Iso | null {
  let earliest: Iso | null = null
  const consider = (at: Iso | null): void => {
    if (at === null || at <= now) return
    if (earliest === null || at < earliest) earliest = at
  }

  for (const run of view.runs.values()) {
    if (run.status === 'running') {
      consider(run.leaseUntil)
      consider(run.deadlineAt)
    } else if (run.status === 'queued') {
      consider(run.notBefore)
    }
  }

  return earliest
}
