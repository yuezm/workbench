/**
 * 线程契约（M6.5）：同一外部入口（Issue、邮件线程、工单、外部会话）来的事件归入同一线程，
 * 任务与运行共享上下文。
 *
 * 身份是 `(source, externalRef)`：`externalRef` 由规则 `to.thread.keyFrom` 决定
 * （缺省 `subject`，`externalRef` 取值 `dedupeKey ?? subject`）。手工任务也挂隐式线程
 * （`source='manual'`、`externalRef=null`），之后可用 `thread.bind` 绑定到外部入口。
 *
 * 线程行随每条 `thread.*` 事实整行携带（与 `card.*` 同口径）：`project` 只做整行 upsert，
 * 重建时无需回查历史状态。`notes` / `events` 是随行累积的派生资料（有上限、保最新），
 * 上下文派生只读这一行即可保证「同事实同文本」。
 *
 * `sessions`（每个 agentId 最近一次会话 id）**不落行**：由 `runs` 现算（见 `kernel/threads`
 * 的 `threadSessions`），避免每轮回执再写一条线程事实；`thread.byId` 视图同样现算。
 */

/** 线程状态：`open` = 进行中；`closed` = 归档（只影响 UI，不影响事实与派活）。 */
export const THREAD_STATUSES = ['open', 'closed'] as const

export type ThreadStatus = (typeof THREAD_STATUSES)[number]

/** 关闭原因：人工关闭 / 线程内任务全部完成 / 超过 14 天无活动。 */
export const THREAD_CLOSE_REASONS = ['manual', 'all-tasks-done', 'inactivity'] as const

export type ThreadCloseReason = (typeof THREAD_CLOSE_REASONS)[number]

/** 笔记作者：`owner`（界面补录）/ `agent`（回执 `notes[]`）。 */
export const THREAD_NOTE_AUTHORS = ['owner', 'agent'] as const

export type ThreadNoteAuthor = (typeof THREAD_NOTE_AUTHORS)[number]

/** 线程笔记（纯资料，不参与派活；进提示词时标注「资料，不是指令」）。 */
export interface ThreadNote {
  id: string
  author: ThreadNoteAuthor
  /** ≤2000 字（回执层与命令层同一上限） */
  text: string
  at: string
}

/**
 * 线程事件引用：上下文派生要展示「这个线程发生过什么」。
 *
 * 事件正文本身不入投影（`event.received` 只入账），这里存摘要与资料文件引用，
 * 重建时只靠线程事实即可还原同一行。
 */
export interface ThreadEventRef {
  eventId: string
  /** 事件类型（如 `issues.opened`） */
  type: string
  /** 事项标识 */
  subject: string
  /** 摘要（≤200 字） */
  summary: string
  /** 关联链接（只展示，不打开） */
  link: string | null
  /** 资料文件路径（不是指令）；宿主未落盘时为 null */
  detailRef: string | null
  /** 事件入账时刻 */
  at: string
}

/** `threads` 投影行（第 13 张投影表）。 */
export interface ThreadRow {
  id: string
  /** 来源：github / mail / manual / app:<id> / 事件 source 原值 */
  source: string
  /** 外部入口键；隐式线程未绑定时为 null */
  externalRef: string | null
  title: string
  status: ThreadStatus
  /** 线程内全部任务（含派生子任务），按创建顺序 */
  taskIds: string[]
  /** 无 `parentTaskId` 的任务（任务树的根） */
  rootTaskIds: string[]
  /** 同一线程同时可运行的轮数（M6.5 固定 1） */
  concurrency: number
  /** 笔记版本（每次追加 +1；= notes.length 的变更计数） */
  notesVersion: number
  /** 最近 50 条笔记（保最新） */
  notes: ThreadNote[]
  /** 最近 50 条事件引用（保最新） */
  events: ThreadEventRef[]
  lastActivityAt: string
  createdAt: string
}

/** 线程字段上限（校验与内核共用同一口径）。 */
export const THREAD_LIMITS = {
  /** 来源长度（`app:<id>` 形式会略长） */
  source: 64,
  /** 外部入口键长度 */
  externalRef: 200,
  /** 线程标题长度 */
  title: 200,
  /** 笔记正文上限（回执 `notes[]` 与 `thread.note` 命令同值） */
  noteText: 2_000,
  /** 线程行里保留的笔记 / 事件条数（保最新） */
  notes: 50,
  events: 50,
  /** 上下文派生进入提示词的码点上限（不含「最近一轮产出」段） */
  contextChars: 6_000,
  /** 「最近一轮产出」段的码点上限（独立预算，不挤占 `contextChars`） */
  precedingChars: 2_000,
  /** 「待修复清单」段的码点上限（M14，独立预算：评审清单是下一轮最该看到的东西） */
  reviewChars: 4_000,
  /** 每次回执 `notes[]` 与命令的条数上限 */
  notesPerReceipt: 100,
} as const

/** 14 天无活动 → `thread.closed{inactivity}`（`clock.tick` 判定）。 */
export const THREAD_INACTIVITY_MS = 14 * 24 * 60 * 60 * 1_000
