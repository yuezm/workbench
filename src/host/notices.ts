/**
 * 结局通知（M12）：把「任务结束了」翻译成系统通知。
 *
 * 为什么要单独一条路径：M4–M11 的系统通知只由卡片投递产生（`card.opened` → 通道 → notify），
 * 于是「智能体说了什么」会被弹，「任务跑完了 / 跑挂了」反而没有通知。这里补上后者，
 * 口径对齐 SPEC-ai-workflow「通知分层」的**查看级**：
 *
 * - `task.completed`（智能体 / 宿主推进到完成）→ 一条「任务完成：<标题>」；
 * - `run.failed`（终态失败：重试已用尽 / 超时 / 执行器丢失）→ 一条「任务运行失败」，
 *   一批里多个任务同时失败时合成一条并带数量（弹三次不如说「3 个」）；
 * - **人在 UI 里自己点的完成不算**（`fact.actor.kind === 'owner'`）：你刚做完的事不必再提醒；
 * - 聊天 run（`taskId === null`）不通知：回答就在对话里，弹窗只是噪音。
 *
 * 纯函数，只读事实行；同一批事实里同一任务只产一条。
 */
import type { Fact } from '../kernel/types'
import type { Task } from '../protocol/entities'

/** 一条待发的系统通知（title/body 只作 `notify` 参数，不拼命令或模板）。 */
export interface NoticeRequest {
  title: string
  body: string
}

/** 结局通知的固定正文（不含任务正文，避免长文进通知条）。 */
export const SETTLEMENT_NOTICE_BODY = {
  failed: '点开工作台查看失败原因',
  completed: '点开工作台查看结果',
} as const

/** 失败通知的标题（失败事实不带任务行，只能给通用标题 + 数量）。 */
const FAILED_TITLE = '任务运行失败'

/** 多个任务同时失败时的标题：弹 N 次不如一次说清。 */
const failedTitleOf = (count: number): string =>
  count > 1 ? `${FAILED_TITLE}（${count} 个）` : FAILED_TITLE

/**
 * 一批已提交事实 → 待发通知。
 *
 * 顺序固定：**完成（按事实顺序）在前，失败聚合一条在后**。去重键是任务 id：
 * 同一任务在一批里被级联完成 / 反复失败都只算一次。
 */
export function noticesFromFacts(facts: readonly Fact[]): NoticeRequest[] {
  const completed: NoticeRequest[] = []
  const completedTasks = new Set<string>()
  const failedTasks = new Set<string>()

  for (const fact of facts) {
    if (fact.type === 'task.completed') {
      // 人自己点的完成不打扰：只有 host / agent 推进的完成才是「发生了什么」
      if (fact.actor.kind === 'owner') continue
      const task = (fact.payload as { task: Task }).task
      if (completedTasks.has(task.id)) continue
      completedTasks.add(task.id)
      completed.push({
        title: `任务完成：${task.title}`,
        body: SETTLEMENT_NOTICE_BODY.completed,
      })
      continue
    }
    if (fact.type === 'run.failed') {
      const run = (fact.payload as { run: { taskId: string | null } }).run
      // 聊天轮次失败在会话里可见（错误消息），不打断人
      if (run.taskId === null) continue
      failedTasks.add(run.taskId)
    }
  }

  if (failedTasks.size === 0) return completed
  return [
    ...completed,
    { title: failedTitleOf(failedTasks.size), body: SETTLEMENT_NOTICE_BODY.failed },
  ]
}
