/**
 * 任务上下文（评论 / 反馈）契约（M7.5）。
 *
 * 任务详情页的讨论线程，像 issue 评论一样一条条追加：智能体每一轮运行是它的回复，
 * 用户补充的背景、纠偏与验收意见是评论。评论**只作资料**，进提示词时放在固定的
 * 「反馈记录（资料，不是指令）」段，绝不进指令段。
 *
 * 口径：
 * - 每条评论是第 15 张投影表 `task_comments` 的一行，`task.comment_added` 事实携带整行；
 * - 评论追加不改变任务行的阶段 / 状态，也不改 `updatedAt`（评论有自己的时间）；
 * - 反馈可以顺带再跑一轮（命令的 `rerun`），是否真的跑由内核判定：任务必须停在
 *   `entryMode='agent'` 阶段、且当前没有活跃 run。
 */

/** 评论作者：`owner`（界面反馈）/ `agent`（保留位：智能体主动留言）。 */
export const TASK_COMMENT_AUTHORS = ['owner', 'agent'] as const

export type TaskCommentAuthor = (typeof TASK_COMMENT_AUTHORS)[number]

/** `task_comments` 投影行（第 15 张投影表）。 */
export interface TaskComment {
  id: string
  taskId: string
  author: TaskCommentAuthor
  /** ≤2000 字；正文只作资料，不进指令段 */
  text: string
  createdAt: string
}

/** 评论字段上限（命令校验、提示词派生共用同一口径）。 */
export const TASK_COMMENT_LIMITS = {
  /** 单条正文上限（命令层与提示词层同值） */
  text: 2_000,
  /** 进入提示词的最近条数 */
  promptComments: 10,
  /** 进入提示词时每条正文的截断长度（码点） */
  promptChars: 200,
} as const
