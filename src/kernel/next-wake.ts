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
import { isCronRule } from '../protocol/rules'
import { nextCronTime, parseCron } from './cron'

export function nextWakeAt(view: View, now: Iso, env: Environment): Iso | null {
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

  // M6：cron 规则的下一次到点（墙钟 + 时区由 kernel/cron 纯函数求）
  for (const rule of view.rules) {
    if (!rule.enabled || !isCronRule(rule)) continue
    const spec = parseCron(rule.when.cron)
    if (spec === null) continue
    consider(nextCronTime(spec, now, env.timezone))
  }

  return earliest
}
