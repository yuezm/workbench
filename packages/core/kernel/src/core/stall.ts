/**
 * 停机哨兵（M55，纯基础层）：怎么判断「这条任务已经没人管了」。
 *
 * 为什么放在 `core/` 而不是域里：两个地方要读同一份判据——`clock.tick` 的扫描
 * （`scopes/stall.ts`）和**下一次唤醒时刻**（`next-wake.ts`，`core/` 不能反向 import 域）。
 * 判据分成两份会漂：扫描认为该醒了、唤醒算不到，宿主定时器就再也不会醒。
 *
 * 「没人管」的六条同时成立才算（少一条都会误报）：
 *
 * 1. 任务没归档；
 * 2. 当前阶段存在，且不是内置阶段（待办 / 已阻塞 / 已完成 / 已取消本来就不派活）；
 * 3. 阶段是**会派活**的入口（`agent` / `script`）——`user` / `none` 就是停在等人；
 * 4. 没有活跃 run（queued / running / waiting）；
 * 5. 没有开着的卡（正在等人答，或者已经喊过一次人）；
 * 6. 最近一轮已经终态、且静默超过 `STALL_SILENCE_MS`。
 *
 * 判据只看投影与注入的 `now`，不读时钟、不查库。
 */
import type { Task } from '@workbench/protocol/entities'
import type { Iso, View } from './types'

/**
 * 判定「静默停机」的阈值：最近一轮结束 10 分钟后还没新动作，就算停住。
 *
 * 为什么不更短：一轮回执到下一轮入队之间有秒级抖动，重启 / 对账也会占用几分钟；
 * 阈值太短会把「正在接续」误判成停机，弹一张假卡比晚 10 分钟发现更糟。
 */
export const STALL_SILENCE_MS = 10 * 60_000

/** 一条被盯上的任务：它停在哪一轮之后、静默了多久。 */
export interface StallWatch {
  task: Task
  /** 停住的阶段（`task.currentStageId` 的快照，判据已确认存在） */
  stageId: string
  /** 最近一轮终态 run 的 id（停机事实与评论用它做稳定键） */
  runId: string
  /** 最近一轮的结束时刻：静默时长从这一刻算 */
  endedAt: Iso
}

/** 该任务最近一轮已终态的 run（`running` / `queued` / `waiting` 不算）。 */
function latestSettledRun(view: View, taskId: string): { id: string; endedAt: Iso } | null {
  let best: { id: string; endedAt: Iso } | null = null
  for (const run of view.runs.values()) {
    if (run.taskId !== taskId) continue
    if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled')
      continue
    if (run.endedAt === null) continue
    if (best === null || run.endedAt > best.endedAt) best = { id: run.id, endedAt: run.endedAt }
  }
  return best
}

/** 是否有开着的卡（等人回答 / 停机卡还挂着）：有就说明「已经叫过人」，不再重复判停机。 */
function hasOpenCard(view: View, taskId: string): boolean {
  for (const card of view.cards.values()) {
    if (card.taskId === taskId && card.status === 'open') return true
  }
  return false
}

/**
 * 当前该盯的所有任务（不含静默时长判定）。
 *
 * 顺序稳定（按任务 id）——扫描产事实的顺序因此可复现，测试与重建同一结果。
 */
export function stallWatchList(view: View): StallWatch[] {
  const watches: StallWatch[] = []
  for (const task of [...view.tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (task.archivedAt !== null) continue
    const stage = task.currentStageId === null ? undefined : view.stages.get(task.currentStageId)
    if (stage === undefined || stage.builtin !== null) continue
    if (stage.entryMode !== 'agent' && stage.entryMode !== 'script') continue
    if (view.activeTaskIds.has(task.id)) continue
    if (hasOpenCard(view, task.id)) continue
    const last = latestSettledRun(view, task.id)
    if (last === null) continue
    watches.push({ task, stageId: stage.id, runId: last.id, endedAt: last.endedAt })
  }
  return watches
}

/** 该任务「最早该判停机」的时刻（`endedAt + STALL_SILENCE_MS`）。 */
export function stallDueAt(watch: StallWatch): Iso {
  return new Date(Date.parse(watch.endedAt) + STALL_SILENCE_MS).toISOString()
}

/**
 * 下一次需要醒来判停机的时刻：`null` = 没有待判的任务。
 *
 * 已过期（≤ now）的时刻也照常返回——那是「该马上处理」的意思，由调用方先 tick 再重算。
 */
export function nextStallAt(view: View): Iso | null {
  let earliest: Iso | null = null
  for (const watch of stallWatchList(view)) {
    const at = stallDueAt(watch)
    if (earliest === null || at < earliest) earliest = at
  }
  return earliest
}
