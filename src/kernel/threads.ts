/**
 * 线程（纯函数，M6.5）：行级原语、会话现算、生命周期判定。
 *
 * 本文件只做「线程行怎么变」与「从视图读什么」，**不做规则匹配**（在 `kernel/rules`）：
 * 事件归并 / 复用任务 / 合并 queued run 由 `eventThreadFacts` 组合这些原语。
 *
 * 线程行随事实整行携带（`thread.*` 的 payload 是完整 `ThreadRow`），所以这里每个
 * `withXxx` 都返回**新行**：调用方按事实顺序演进，重建 fold 得到同一结果。
 */
import type { RunRow, Task } from '../protocol/entities'
import type { EventReceivedPayload } from '../protocol/facts'
import {
  THREAD_INACTIVITY_MS,
  THREAD_LIMITS,
  type ThreadCloseReason,
  type ThreadEventRef,
  type ThreadNote,
  type ThreadNoteAuthor,
  type ThreadRow,
  type ThreadStatus,
} from '../protocol/thread'
import type { Actor, Environment, FactDraft, Id, Iso, View } from './types'

const truncate = (value: string, max: number): string =>
  Array.from(value).length > max ? Array.from(value).slice(0, max).join('') : value

/** 线程标题：事件 subject 优先，其次 summary；都空时用来源。 */
export function threadTitle(
  source: string,
  event: Pick<EventReceivedPayload, 'subject' | 'summary'>,
): string {
  return truncate(event.subject.trim() || event.summary.trim() || source, THREAD_LIMITS.title)
}

/** 按 `(source, externalRef)` 找线程；`externalRef` 为 null 的隐式线程不参与事件归并。 */
export function findThreadByKey(
  view: View,
  source: string,
  externalRef: string | null,
): ThreadRow | undefined {
  if (externalRef === null) return undefined
  for (const thread of view.threads.values()) {
    if (thread.source === source && thread.externalRef === externalRef) return thread
  }
  return undefined
}

/** 新线程行（`thread.opened` 的 payload）。 */
export function openThreadRow(
  env: Environment,
  input: { source: string; externalRef: string | null; title: string; now: Iso },
  concurrency = 1,
): ThreadRow {
  return {
    id: env.nextId('thread'),
    source: input.source,
    externalRef: input.externalRef,
    title: truncate(input.title.trim() || input.source, THREAD_LIMITS.title),
    status: 'open',
    taskIds: [],
    rootTaskIds: [],
    concurrency,
    notesVersion: 0,
    notes: [],
    events: [],
    lastActivityAt: input.now,
    createdAt: input.now,
  }
}

/** 事件引用（只存摘要与资料指针，正文留资料文件）。 */
export function eventRefOf(event: EventReceivedPayload, at: Iso): ThreadEventRef {
  return {
    eventId: event.eventId,
    type: event.type,
    subject: event.subject,
    summary: truncate(event.summary, 200),
    link: event.link,
    detailRef: event.detailRef,
    at,
  }
}

const capTail = <T>(items: T[], max: number): T[] =>
  items.length > max ? items.slice(items.length - max) : items

/** 追加事件引用（同一 `eventId` 只记一次；保最新 50 条）。 */
export function withEvent(thread: ThreadRow, event: EventReceivedPayload, at: Iso): ThreadRow {
  const exists = thread.events.some((item) => item.eventId === event.eventId)
  const events = exists ? thread.events : [...thread.events, eventRefOf(event, at)]
  return {
    ...thread,
    events: capTail(events, THREAD_LIMITS.events),
    lastActivityAt: at,
    status: 'open',
  }
}

/**
 * 任务挂进线程：`rootTaskIds` 收「在本线程里没有父任务」的任务（任务树根）。
 *
 * 不直接看 `parentTaskId === null`：交接产物（M7）挂的是**别的线程里**的来源任务，
 * 它在新线程里就是根，否则线程树会认为这条线程没有根任务。
 */
export function withTask(thread: ThreadRow, task: Task, at: Iso): ThreadRow {
  const taskIds = thread.taskIds.includes(task.id) ? thread.taskIds : [...thread.taskIds, task.id]
  const parentInThread = task.parentTaskId !== null && thread.taskIds.includes(task.parentTaskId)
  const rootTaskIds =
    !parentInThread && !thread.rootTaskIds.includes(task.id)
      ? [...thread.rootTaskIds, task.id]
      : thread.rootTaskIds
  return { ...thread, taskIds, rootTaskIds, lastActivityAt: at }
}

/** 追加笔记（保最新 50 条；`notesVersion` 每次 +1）。 */
export function withNote(thread: ThreadRow, note: ThreadNote, at: Iso): ThreadRow {
  return {
    ...thread,
    notes: capTail([...thread.notes, note], THREAD_LIMITS.notes),
    notesVersion: thread.notesVersion + 1,
    lastActivityAt: at,
  }
}

/** 改状态；重开时清空 `lastActivityAt` 到当前时刻。 */
export function withStatus(thread: ThreadRow, status: ThreadStatus, at: Iso): ThreadRow {
  return { ...thread, status, lastActivityAt: at }
}

/** 绑定外部入口：行内 `source/externalRef` 改成入口键。 */
export function withBinding(
  thread: ThreadRow,
  source: string,
  externalRef: string,
  at: Iso,
): ThreadRow {
  return { ...thread, source, externalRef, lastActivityAt: at }
}

// ---------- 读视图 ----------

/** 线程内的任务（按 `taskIds` 顺序，已删的任务自然跳过）。 */
export function tasksOfThread(view: View, thread: ThreadRow): Task[] {
  const tasks: Task[] = []
  for (const taskId of thread.taskIds) {
    const task = view.tasks.get(taskId)
    if (task) tasks.push(task)
  }
  return tasks
}

/** 线程内的 active 任务（复用策略只看它们）。 */
export function activeTasksOfThread(view: View, thread: ThreadRow): Task[] {
  return tasksOfThread(view, thread).filter((task) => task.status === 'active')
}

const TERMINAL_RUN: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

/** 视图里满足 `match` 的终态 run，按「结束 → 创建 → id」升序（后写覆盖先写）。 */
function settledRuns(view: View, match: (run: RunRow) => boolean): RunRow[] {
  return [...view.runs.values()]
    .filter((run) => match(run) && TERMINAL_RUN.has(run.status))
    .sort(
      (a, b) =>
        (a.endedAt ?? a.createdAt).localeCompare(b.endedAt ?? b.createdAt) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    )
}

/**
 * 线程内每个 agentId 最近一次终态 run 的 `sessionId`（不落线程行，按 runs 现算）。
 *
 * **仅供视图展示**（`thread.byId.sessions`，界面上的「各智能体最近会话」）。
 * 派活的续接口径是 `taskSessions`：同一线程的另一个任务不得复用这份历史。
 *
 * 排序：`endedAt`（缺省 `createdAt`）→ `createdAt` → `id`，后写覆盖先写；
 * 只有终态且带 `sessionId` 的 run 才算数（首轮没有会话可续接）。
 */
export function threadSessions(view: View, threadId: Id): Record<Id, Id> {
  const sessions: Record<Id, Id> = {}
  for (const run of settledRuns(
    view,
    (run) => run.threadId === threadId && run.agentId !== null && run.sessionId !== null,
  )) {
    // filter 已收口 agentId/sessionId 非空，这里只做类型断言
    sessions[run.agentId as Id] = run.sessionId as Id
  }
  return sessions
}

/**
 * 任务内每个 agentId 最近一次终态 run 的 `sessionId`（M15：会话键下沉到任务）。
 *
 * 这是派活的唯一续接口径：同一任务打回重做 / 追加反馈 / `turn+1` 续接同一会话，
 * 换任务、换智能体都开新会话（跨任务上下文靠「任务索引 + 产物路径」按需读取，
 * 不靠共享对话历史）。排序与终态判定与 `threadSessions` 同口径。
 */
export function taskSessions(view: View, taskId: Id): Record<Id, Id> {
  const sessions: Record<Id, Id> = {}
  for (const run of settledRuns(
    view,
    (run) => run.taskId === taskId && run.agentId !== null && run.sessionId !== null,
  )) {
    sessions[run.agentId as Id] = run.sessionId as Id
  }
  return sessions
}

/** 该任务在视图里已有的 run 数（下一轮 `turn` = 已有数 + 1）。 */
export function runCountOfTask(view: View, taskId: Id): number {
  let count = 0
  for (const run of view.runs.values()) {
    if (run.taskId === taskId) count += 1
  }
  return count
}

/**
 * 该任务在该阶段已经跑过几轮（M28：从 `commands/run.ts` 挪过来，供派活与提示词共用）。
 *
 * 轮次**派生**而不是加 `runs` 列：加列要物理重建 `runs` 表，而这里只需要一个计数
 * （沿用 review-handoff D2 的口径：不扩 `RunRow` 契约）。`running` / `queued` 都算一轮，
 * 因为「本阶段跑过几轮」在派活那一刻就该反映刚结束的那一轮。
 */
export function stageRoundCount(view: View, taskId: Id, stageId: Id): number {
  let count = 0
  for (const run of view.runs.values()) {
    if (run.purpose === 'stage' && run.taskId === taskId && run.stageId === stageId) count += 1
  }
  return count
}

/** 任务当前阶段是否已有 queued run（只合并 queued；claimed / waiting 不合并）。 */
export function queuedRunOfTask(view: View, taskId: Id): RunRow | undefined {
  const runs = [...view.runs.values()].filter(
    (run) => run.taskId === taskId && run.status === 'queued',
  )
  runs.sort((a, b) => a.queueSeq - b.queueSeq || a.id.localeCompare(b.id))
  return runs[0]
}

// ---------- 事实 ----------

/** `thread.opened`（actor 由调用方给：规则内核 / owner）。 */
export function openedFacts(
  thread: ThreadRow,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.opened'>[] {
  return [{ type: 'thread.opened', actor, at: now, payload: { thread } }]
}

/** `thread.event_attached`（行里的 `events` 已追加）。 */
export function eventAttachedFacts(
  thread: ThreadRow,
  event: EventReceivedPayload,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.event_attached'>[] {
  return [
    {
      type: 'thread.event_attached',
      actor,
      at: now,
      payload: { thread, eventId: event.eventId, summary: truncate(event.summary, 200) },
    },
  ]
}

/** `thread.task_attached`（行里的 `taskIds` / `rootTaskIds` 已更新）。 */
export function taskAttachedFacts(
  thread: ThreadRow,
  task: Task,
  ruleId: Id | null,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.task_attached'>[] {
  return [
    {
      type: 'thread.task_attached',
      actor,
      at: now,
      payload: { thread, taskId: task.id, ruleId },
    },
  ]
}

/** `thread.note_appended`（行里的 `notes` 已追加）。 */
export function noteFacts(
  thread: ThreadRow,
  note: ThreadNote,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.note_appended'>[] {
  return [{ type: 'thread.note_appended', actor, at: now, payload: { thread, note } }]
}

/** `thread.closed` / `thread.reopened` / `thread.bound` 的事实包装。 */
export function closedFacts(
  thread: ThreadRow,
  reason: ThreadCloseReason,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.closed'>[] {
  return [{ type: 'thread.closed', actor, at: now, payload: { thread, reason } }]
}

export function reopenedFacts(
  thread: ThreadRow,
  eventId: Id | null,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.reopened'>[] {
  return [{ type: 'thread.reopened', actor, at: now, payload: { thread, eventId } }]
}

export function boundFacts(
  thread: ThreadRow,
  source: string,
  externalRef: string,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.bound'>[] {
  return [{ type: 'thread.bound', actor, at: now, payload: { thread, source, externalRef } }]
}

// ---------- 生命周期 ----------

/**
 * 线程内任务全部完成（已删的任务视为完成）→ `thread.closed{all-tasks-done}`。
 *
 * `overrides` 用于「同一批事实里刚完成 / 刚删除的任务」：视图里它们还是 active。
 */
export function closeIfAllDone(
  view: View,
  thread: ThreadRow | undefined,
  now: Iso,
  actor: Actor,
  overrides?: ReadonlyMap<Id, Task['status']>,
): FactDraft[] {
  if (thread === undefined || thread.status === 'closed') return []
  for (const taskId of thread.taskIds) {
    const status = overrides?.get(taskId) ?? view.tasks.get(taskId)?.status
    if (status === 'active') return []
  }
  return closedFacts(withStatus(thread, 'closed', now), 'all-tasks-done', actor, now)
}

/**
 * 线程内的任务行已被删光 → `thread.removed`（线程连同执行记录一起消失）。
 *
 * `removedTaskId` 是本批刚删的任务——视图里它还在，判定时跳过。**只要还剩一条任务行就不删**：
 * 那种情况属于 `closeIfAllDone` 的归档（线程保留，历史还能回看）。
 * 与 `thread.remove` 同口径：线程行删掉，线程内执行记录由各任务自己的 `run.removed` 逐条清掉
 * （任务都删过了，这里不再补），落盘归档由宿主按 `thread.removed` 清 `<artifacts>/threads/<id>/`。
 */
export function removedIfNoTasksLeft(
  view: View,
  thread: ThreadRow | undefined,
  removedTaskId: Id,
  actor: Actor,
  now: Iso,
): FactDraft<'thread.removed'>[] {
  if (thread === undefined) return []
  const left = thread.taskIds.filter((taskId) => taskId !== removedTaskId && view.tasks.has(taskId))
  if (left.length > 0) return []
  return [{ type: 'thread.removed', actor, at: now, payload: { thread } }]
}

/** 任务完成后取它所属线程（找不到 / 已关闭返回 undefined）。 */
export function threadOfTask(view: View, task: Task): ThreadRow | undefined {
  if (task.threadId === null) return undefined
  return view.threads.get(task.threadId)
}

/** 14 天无活动的 open 线程归档。 */
export function inactivityFacts(view: View, now: Iso, actor: Actor): FactDraft[] {
  const facts: FactDraft[] = []
  const timestamp = Date.parse(now)
  for (const thread of view.threads.values()) {
    if (thread.status !== 'open') continue
    const last = Date.parse(thread.lastActivityAt)
    if (Number.isNaN(last) || timestamp - last < THREAD_INACTIVITY_MS) continue
    facts.push(...closedFacts(withStatus(thread, 'closed', now), 'inactivity', actor, now))
  }
  return facts
}

/** 新笔记行（author 由调用方给；文本由校验层保证非空与长度）。 */
export function makeNote(
  env: Environment,
  author: ThreadNoteAuthor,
  text: string,
  now: Iso,
): ThreadNote {
  return {
    id: env.nextId('thread-note'),
    author,
    text: truncate(text, THREAD_LIMITS.noteText),
    at: now,
  }
}
