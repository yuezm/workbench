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
import { isCronRule } from '@workbench/protocol/rules'
import { STALL_REMIND_DELAYS_MS } from '@workbench/protocol/channels'
import { nextCronTime, parseCron } from './cron'
import { nextStallAt } from './stall'

/** ISO 时刻 + 毫秒（本层只做算术，不读时钟）。 */
const plusMs = (at: Iso, ms: number): Iso => new Date(Date.parse(at) + ms).toISOString()

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

  // M41：卡片重投排期（内核只算时刻，投递由宿主按这个时刻唤醒后执行）
  for (const card of view.cards.values()) {
    consider(card.nextDeliveryAt)
  }

  // M55：停机卡的下一档提醒（到点由 `clock.tick` 把同一张卡版本 +1 重投）。
  // 没有这一项，任务停住后宿主定时器就再也不会醒——正是 2026-11-24 那次静默的机制。
  for (const card of view.cards.values()) {
    if (card.kind !== 'stall' || card.status !== 'open') continue
    const delay = STALL_REMIND_DELAYS_MS[card.version - 1]
    if (delay === undefined) continue
    consider(plusMs(card.updatedAt, delay))
  }

  // M55：静默哨兵的下一判时刻。缺它的话「任务停住、没有 run、没有卡」这种形态下
  // `nextWakeAt` 会返回 null，宿主定时器睡过去——正是那次静默的机制。
  consider(nextStallAt(view))

  return earliest
}
