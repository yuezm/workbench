/**
 * 事实契约：事实名常量 + 各事实 payload 类型。
 *
 * 约定：实体类事实的 payload 用同名字段包一行（`workflow` / `stage` / `agent` /
 * `runtime` / `task` / `conversation` / `run`），删除类事实携带删除前的末态行作为
 * tombstone，让 `timeline` 不必回查投影即可还原历史（阶段 id 稳定，不悬空）。
 * runtime 事实一律携带完整行（含 `lastProbe`）：`project` 只做「一行事实 → 一行投影」，
 * 不做特判；探测结论变化单独走 `runtime.probed`。凭据类字段不进事实。
 *
 * M2 起 `runs` / `run_events` / `conversations` / `messages` 也由事实重建：
 * 运行类事实与实体事实同口径——**每条状态事实携带完整的 `run: RunRow`**，让 `project`
 * 保持纯函数、重建时无需回查数据库；`run.queued` 的 `queueSeq` 由 `project` 用事实的
 * `seq` 回填（领取 FIFO 的稳定序号）。例外：`run.frames` 只带帧（批量、D6/D7），
 * `run.removed` 只带 `runId`（删除），`run.receipt_rejected` 只做审计。
 */
import type {
  Agent,
  Card,
  CardAnswerVia,
  CardResolveReason,
  ChatRole,
  Conversation,
  Message,
  OnChildrenSettled,
  RunEventRow,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from './entities'
import type { TaskComment } from './task-comment'
import type { RuleFireRow, RuleSetRow } from './rules'
import type { PluginSettingsRow } from './plugins'
import type { ThreadCloseReason, ThreadNote, ThreadRow } from './thread'

/** 事实名全集。M4 加卡片与派生事件；M6 加规则；M6.5 加线程与事件合并；M7 加插件设置。 */
export const FACT_TYPES = [
  'workflow.created',
  'workflow.updated',
  'workflow.removed',
  'stage.created',
  'stage.updated',
  'stage.deleted',
  'agent.created',
  'agent.updated',
  'agent.removed',
  'runtime.created',
  'runtime.updated',
  'runtime.removed',
  'runtime.probed',
  'task.created',
  'task.moved',
  'task.completed',
  'task.removed',
  'task.comment_added',
  'task.children_settled',
  'run.queued',
  'run.claimed',
  'run.lease_extended',
  'run.waiting',
  'run.frames',
  'run.abandoned',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.usage',
  'run.cancel_requested',
  'run.receipt_rejected',
  'run.removed',
  'card.opened',
  'card.updated',
  'card.delivered',
  'card.delivery_failed',
  'card.answered',
  'card.resolved',
  'event.received',
  'event.dropped',
  'event.merged',
  'thread.opened',
  'thread.event_attached',
  'thread.task_attached',
  'thread.note_appended',
  'thread.closed',
  'thread.reopened',
  'thread.bound',
  'rules.replaced',
  'rule.fired',
  'plugins.replaced',
  'conversation.created',
  'conversation.updated',
  'conversation.removed',
  'message.appended',
  'snapshot.imported',
] as const

export type FactType = (typeof FACT_TYPES)[number]

// ---------- 工作流 / 阶段 ----------

export interface WorkflowCreatedPayload {
  workflow: Workflow
}

export interface WorkflowUpdatedPayload {
  workflow: Workflow
}

/** tombstone：删除前的末态行 */
export interface WorkflowRemovedPayload {
  workflow: Workflow
}

export interface StageCreatedPayload {
  stage: WorkflowStage
}

export interface StageUpdatedPayload {
  stage: WorkflowStage
}

/** tombstone：历史 run 的 stageId 据此仍可解释 */
export interface StageDeletedPayload {
  stage: WorkflowStage
}

// ---------- 智能体 ----------

export interface AgentCreatedPayload {
  agent: Agent
}

export interface AgentUpdatedPayload {
  agent: Agent
}

/** tombstone：删除前的末态行 */
export interface AgentRemovedPayload {
  agent: Agent
}

// ---------- 运行时 ----------

/** 配置事实携带完整行（含 `lastProbe`），重建时无需回查其它事实。 */
export interface RuntimeCreatedPayload {
  runtime: Runtime
}

export interface RuntimeUpdatedPayload {
  runtime: Runtime
}

/** tombstone：删除前的末态行（含末次探测结论） */
export interface RuntimeRemovedPayload {
  runtime: Runtime
}

/** 探测事实携带更新后的完整行：`lastProbe` 是行的一部分，投影直接 upsert。 */
export interface RuntimeProbedPayload {
  runtime: Runtime
}

// ---------- 任务 ----------

export interface TaskCreatedPayload {
  task: Task
}

export interface TaskMovedPayload {
  task: Task
  /** 移动前阶段；null = 无阶段 */
  from: string | null
  /** 移动后阶段；null = 无阶段 */
  to: string | null
}

export interface TaskCompletedPayload {
  task: Task
}

/** tombstone：删除前的末态行 */
export interface TaskRemovedPayload {
  task: Task
}

/**
 * 任务上下文 / 反馈追加（M7.5）：只携带评论整行（任务行不变），`project` 写 `task_comments`。
 * 正文只作资料（进提示词的「反馈记录（资料，不是指令）」段）。
 */
export interface TaskCommentAddedPayload {
  comment: TaskComment
}

/**
 * 子任务全部结束（M8）：审计事实，`project` 不写表；真正的效果由同时产出的
 * `run.queued`（唤醒父 Agent）/ `card.opened`（通知）/ `task.completed`（父完成）表达。
 * `childIds` 是本次判定为终态的子任务 id；`batchNo` 为 null 表示未分批（v1 恒 null）。
 */
export interface TaskChildrenSettledPayload {
  parentTaskId: string
  childIds: string[]
  batchNo: number | null
  action: OnChildrenSettled
}

// ---------- 运行 ----------

/**
 * 入队事实：进入阶段效果（`task.create` / `task.move` / 回执流转）与对话轮次
 * 都由内核产出。`run.prompt` 是宿主拼好的提示词——SPEC 的 payload 清单只列了
 * `promptRef`，但投影要能重建 `runs.prompt`，故整行随事实携带；`promptRef` 保留
 * 给资料文件引用（不是指令）。`queueSeq` 由 `project` 用本事实的 `seq` 回填。
 */
export interface RunQueuedPayload {
  run: RunRow
}

/** 领取：`leaseId = '<runId>:<attempt>'`、`leaseUntil = now + leaseMs`、`deadlineAt = now + runTimeoutMs`。 */
export interface RunClaimedPayload {
  run: RunRow
}

/** 心跳续租：只在 `leaseId` 匹配当前租约时产生（D1） */
export interface RunLeaseExtendedPayload {
  run: RunRow
}

/** 回执带 `ask[]`：挂起等回答，同时释放租约与并发位（D12；卡片 M4） */
export interface RunWaitingPayload {
  run: RunRow
  /** 本次挂起的卡片 id（M2 恒为空数组，M4 接卡片后填） */
  cardIds: string[]
}

/**
 * 协议帧批量入账：帧 `seq` 由宿主按 run 全局单调分配（跨 turn 递增，D6），
 * 单批上限 `maxFramesPerBatch`，超出**分包**为多条事实而非丢弃（D7）。
 */
export interface RunFramesPayload {
  runId: string
  turn: number
  frames: RunEventRow[]
}

/** 租约过期放弃：回 `queued` + 退避；`attempts` 达 `maxAttempts` 由 `run.failed` 兜底（D3） */
export interface RunAbandonedPayload {
  run: RunRow
}

/**
 * 终态事实的公共行（`run.succeeded` / `run.failed` / `run.cancelled` 共用）：
 * `status` / `output` / `error` / `errorCode` / `sessionId` / `usage` / `exitCode` /
 * `durationMs` / `endedAt` 都在行里；`endedAt` 由宿主写终态时取 `now`。
 */
export interface RunSettledPayload {
  run: RunRow
}

/** 运行中增量用量；终态事实携带最终值覆盖 */
export interface RunUsagePayload {
  run: RunRow
}

/** 取消请求：内核只记账，终止进程由宿主按取消时序执行 */
export interface RunCancelRequestedPayload {
  run: RunRow
  by: 'owner' | 'host'
}

/** 迟到 / 重复 / 不匹配回执的审计事实：只记账，不覆盖终态（D10） */
export interface RunReceiptRejectedPayload {
  runId: string
  leaseId: string | null
  turn: number | null
  reason: string
}

/** 任务删除时随事实显式删除 run 与它的 `run_events`（替代 SQL 级联，D13） */
export interface RunRemovedPayload {
  runId: string
}

// ---------- 卡片（M4） ----------

/**
 * 卡片事实（M4）沿用「一行事实 → 一行投影」：**每条 `card.*` payload 携带完整 `Card` 行**，
 * `project` 只做整行 upsert，重建不回查；各行另带少量审计字段（通道 ref / 错误 / 来源），
 * 供 `timeline` 解释「谁在什么时候把卡片推到了哪一步」。
 */
export interface CardOpenedPayload {
  card: Card
}

/** 同 run 同 `key` 的 open 卡再次出现：`version+1`、投递重置 `pending`；`changes` 记变更字段。 */
export interface CardUpdatedPayload {
  card: Card
  changes?: string[]
}

/** 至少一个通道已送达；`ref` 是通道键（`in-app` / `desktop` / …）。 */
export interface CardDeliveredPayload {
  card: Card
  ref: string
}

/** 本轮所有通道投递失败；卡片状态不变，重启按 `pending` 补投。 */
export interface CardDeliveryFailedPayload {
  card: Card
  error: string
}

/** 回答：`by` 是来源（`ui` / `channel`），与行里的 `answeredBy` 一致。 */
export interface CardAnsweredPayload {
  card: Card
  by: CardAnswerVia
}

/** 关闭：`agent`（回执 `resolves`）/ `manual`（`card.resolve`）/ `cancelled`（run 取消）。 */
export interface CardResolvedPayload {
  card: Card
  reason: CardResolveReason
}

// ---------- 派生事件（M4） ----------

/**
 * 回执 `events[]` 派生的事件入账（D8）：只记账、不派活（规则建任务留 M6）。
 *
 * `hops = 父 run.hops + 1`；`summary` ≤200 字；`detail` 由宿主落
 * `artifacts/<eventId>.md` 并把路径放 `detailRef`；`originRunId` 是派生出它的 run，
 * 供 M6 按线程/父任务归并；`dedupeKey` 原样保留。
 */
export interface EventReceivedPayload {
  eventId: string
  source: string
  type: string
  subject: string
  summary: string
  /** 资料文件路径（不是指令）；宿主未落盘时为 null */
  detailRef: string | null
  link: string | null
  hops: number
  /** 派生出该事件的 run；外部来源的事件为 null */
  originRunId: string | null
  dedupeKey: string | null
}

/** 跳数熔断：`hops > maxHops` 只写这条，不派活、不建卡。 */
export interface EventDroppedPayload {
  eventId: string
  hops: number
  reason: string
}

// ---------- 线程（M6.5） ----------

/**
 * 线程事实（M6.5）沿用「一行事实 → 一行投影」：payload 携带**完整 `thread: ThreadRow` 行**，
 * `project` 只做整行 upsert，重建不回查。其它字段只作审计（哪个事件、哪条任务、哪条笔记、
 * 关闭原因、绑定键），行里已经包含同样的信息。
 */
export interface ThreadOpenedPayload {
  thread: ThreadRow
}

/** 事件归入既有线程：行里的 `events` 已追加该事件。 */
export interface ThreadEventAttachedPayload {
  thread: ThreadRow
  eventId: string
  summary?: string
}

/** 任务挂进线程：行里的 `taskIds` / `rootTaskIds` 已更新。 */
export interface ThreadTaskAttachedPayload {
  thread: ThreadRow
  taskId: string
  ruleId?: string | null
}

/** 追加笔记：行里的 `notes` 已追加该条。 */
export interface ThreadNoteAppendedPayload {
  thread: ThreadRow
  note: ThreadNote
}

/** 关闭线程（人工 / 任务全部完成 / 14 天无活动）。 */
export interface ThreadClosedPayload {
  thread: ThreadRow
  reason: ThreadCloseReason
}

/** 关闭后新事件到达：自动重开；`eventId=null` 表示非事件路径的重开（保留形状）。 */
export interface ThreadReopenedPayload {
  thread: ThreadRow
  eventId: string | null
}

/** 把隐式线程绑定到外部入口 `(source, externalRef)`。 */
export interface ThreadBoundPayload {
  thread: ThreadRow
  source: string
  externalRef: string
}

/**
 * 事件合并到 queued run（M6.5）：`payload.run` 是追加 `eventId` 后的整行，
 * `project` 据此更新 `runs.eventIds`（与运行类事实同口径，重建不回查）。
 */
export interface EventMergedPayload {
  run: RunRow
  eventId: string
}

// ---------- 自动化规则（M6） ----------

/**
 * 规则集整批替换：payload 携带完整 `RuleSetRow`（单行投影），版本由内核 +1。
 * 一次事实 → 一行投影，重建无需回查。
 */
export interface RulesReplacedPayload {
  ruleSet: RuleSetRow
}

/** cron 到点触发：payload 携带完整 `RuleFireRow`（append-only 投影）。 */
export interface RuleFiredPayload {
  fire: RuleFireRow
}

// ---------- 插件设置（M7） ----------

/**
 * 插件设置整批替换（M7）：payload 携带完整 `PluginSettingsRow`（单行投影，含版本），
 * 一次事实 → 一行投影，重建无需回查。secret 值不进这里（见 `protocol/plugins`）。
 */
export interface PluginsReplacedPayload {
  pluginSettings: PluginSettingsRow
}

// ---------- 对话 ----------

export interface ConversationCreatedPayload {
  conversation: Conversation
}

/** 标题 / 续接会话 id 的变更也走这条事实（D8），投影整行 upsert */
export interface ConversationUpdatedPayload {
  conversation: Conversation
}

/** tombstone：删除前的末态行（消息随对话一起删除） */
export interface ConversationRemovedPayload {
  conversation: Conversation
}

/** 追加一条消息；`createdAt` 取事实的 `at`，`runId` 记录它属于哪一轮（不进投影行） */
export interface MessageAppendedPayload {
  conversationId: string
  messageId: string
  role: ChatRole
  content: string
  runId?: string
  error?: string | null
}

// ---------- 存量导入 ----------

/** v2 存量按表分批写成导入根（无 `cause`，`timeline` 标注「迁移导入」）。 */
export type SnapshotImportedPayload =
  | { table: 'tasks'; rows: Task[]; importedFrom: 'v2' }
  | { table: 'workflows'; rows: Workflow[]; importedFrom: 'v2' }
  | { table: 'workflow_stages'; rows: WorkflowStage[]; importedFrom: 'v2' }
  | { table: 'agents'; rows: Agent[]; importedFrom: 'v2' }
  | { table: 'runtimes'; rows: Runtime[]; importedFrom: 'v2' }
  | { table: 'runs'; rows: RunRow[]; importedFrom: 'v2' }
  | { table: 'run_events'; rows: RunEventRow[]; importedFrom: 'v2' }
  | { table: 'conversations'; rows: Conversation[]; importedFrom: 'v2' }
  | { table: 'messages'; rows: Message[]; importedFrom: 'v2' }

/** 事实名 → payload 类型；`FactPayload<T>` 供 kernel 的 `FactDraft` 收窄。 */
export interface FactPayloads {
  'workflow.created': WorkflowCreatedPayload
  'workflow.updated': WorkflowUpdatedPayload
  'workflow.removed': WorkflowRemovedPayload
  'stage.created': StageCreatedPayload
  'stage.updated': StageUpdatedPayload
  'stage.deleted': StageDeletedPayload
  'agent.created': AgentCreatedPayload
  'agent.updated': AgentUpdatedPayload
  'agent.removed': AgentRemovedPayload
  'runtime.created': RuntimeCreatedPayload
  'runtime.updated': RuntimeUpdatedPayload
  'runtime.removed': RuntimeRemovedPayload
  'runtime.probed': RuntimeProbedPayload
  'task.created': TaskCreatedPayload
  'task.moved': TaskMovedPayload
  'task.completed': TaskCompletedPayload
  'task.removed': TaskRemovedPayload
  'task.comment_added': TaskCommentAddedPayload
  'task.children_settled': TaskChildrenSettledPayload
  'run.queued': RunQueuedPayload
  'run.claimed': RunClaimedPayload
  'run.lease_extended': RunLeaseExtendedPayload
  'run.waiting': RunWaitingPayload
  'run.frames': RunFramesPayload
  'run.abandoned': RunAbandonedPayload
  'run.succeeded': RunSettledPayload
  'run.failed': RunSettledPayload
  'run.cancelled': RunSettledPayload
  'run.usage': RunUsagePayload
  'run.cancel_requested': RunCancelRequestedPayload
  'run.receipt_rejected': RunReceiptRejectedPayload
  'run.removed': RunRemovedPayload
  'card.opened': CardOpenedPayload
  'card.updated': CardUpdatedPayload
  'card.delivered': CardDeliveredPayload
  'card.delivery_failed': CardDeliveryFailedPayload
  'card.answered': CardAnsweredPayload
  'card.resolved': CardResolvedPayload
  'event.received': EventReceivedPayload
  'event.dropped': EventDroppedPayload
  'event.merged': EventMergedPayload
  'thread.opened': ThreadOpenedPayload
  'thread.event_attached': ThreadEventAttachedPayload
  'thread.task_attached': ThreadTaskAttachedPayload
  'thread.note_appended': ThreadNoteAppendedPayload
  'thread.closed': ThreadClosedPayload
  'thread.reopened': ThreadReopenedPayload
  'thread.bound': ThreadBoundPayload
  'rules.replaced': RulesReplacedPayload
  'rule.fired': RuleFiredPayload
  'plugins.replaced': PluginsReplacedPayload
  'conversation.created': ConversationCreatedPayload
  'conversation.updated': ConversationUpdatedPayload
  'conversation.removed': ConversationRemovedPayload
  'message.appended': MessageAppendedPayload
  'snapshot.imported': SnapshotImportedPayload
}

export type FactPayload<T extends FactType> = FactPayloads[T]
