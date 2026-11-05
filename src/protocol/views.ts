/**
 * 视图契约：宿主按 `viewSpec` 装载投影切片交给内核，`query(view, params)` 供 IPC / 装配根读取。
 *
 * 读视图只覆盖「前端与装配根当前需要的形状」：实体读路径、运行历史（`runs.byTask` /
 * `run.events` / `run.last-event-seq`）、运行时负载与启动对账（`runs.stale-chat`）、
 * 卡片审批（`cards.open` / `cards.byRun`，M4）。
 * M5 的完整视图清单（threads / timeline 等）届时在此扩展。
 */
import type {
  Agent,
  Card,
  Conversation,
  Message,
  Run,
  RunEvent,
  RunRow,
  Runtime,
  Task,
  WorkflowWithStages,
} from './entities'

/** 视图 id 全集；新增视图必须先登记在这里，命令/宿主不得传任意字符串。 */
export const VIEW_IDS = [
  'workflows.all',
  'agents.all',
  'runtimes.all',
  'tasks.byWorkflow',
  'task.byId',
  'runs.active-by-task',
  'conversations.all',
  'messages.byConversation',
  'runs.active-by-conversation',
  'runs.byTask',
  'run.byId',
  'run.events',
  'run.last-event-seq',
  'runtimes.workloads',
  'runs.stale-chat',
  'cards.open',
  'cards.byRun',
  'runs.waiting',
] as const

export type ViewId = (typeof VIEW_IDS)[number]

/**
 * 活跃 run 的最小投影：内核用它判断「该任务是否执行中」，看板用它展示进行中的运行。
 * `waiting` 是挂起等回答的运行（已释放并发位，但仍算执行中，D12）。
 * 聊天 run 不挂任务（`taskId` 为 null），由 `runs.active-by-conversation` 按对话取。
 */
export interface ActiveRun {
  id: string
  taskId: string | null
  stageId: string | null
  status: 'queued' | 'running' | 'waiting'
}

/** 运行时实时负载：在跑 / 排队数（`runtimes.statuses` 与调度器共用的口径）。 */
export interface RuntimeWorkload {
  runtimeId: string
  running: number
  queued: number
}

/** 启动对账要兜底终态的中断聊天 run（`purpose='chat'` + `running`）。 */
export interface StaleChatRun {
  id: string
  leaseId: string | null
  turn: number
}

/**
 * 启动对账要检查的 waiting run（M4 D13）：`hasOpenCard` 由宿主按 `cards.run_id` join 得出。
 * 有 open 卡的 waiting 不能兜底取消（有人可答）；无卡的由对账补 `run.host_settled{cancelled}`。
 */
export interface WaitingRun {
  runId: string
  leaseId: string | null
  turn: number
  hasOpenCard: boolean
}

/** 需要参数的视图 → 参数形状；无参数视图不出现在这里。 */
export interface ViewArgs {
  'tasks.byWorkflow': { workflowId: string }
  'task.byId': { taskId: string }
  'runs.active-by-task': { taskId: string }
  'messages.byConversation': { conversationId: string }
  'runs.active-by-conversation': { conversationId: string }
  'runs.byTask': { taskId: string }
  'run.byId': { runId: string }
  'run.events': { runId: string }
  'run.last-event-seq': { runId: string }
  'cards.byRun': { runId: string }
}

/** 视图 id → 返回类型。 */
export interface ViewResults {
  'workflows.all': WorkflowWithStages[]
  'agents.all': Agent[]
  'runtimes.all': Runtime[]
  'tasks.byWorkflow': Task[]
  'task.byId': Task | null
  'runs.active-by-task': ActiveRun[]
  'conversations.all': Conversation[]
  'messages.byConversation': Message[]
  'runs.active-by-conversation': ActiveRun[]
  'runs.byTask': Run[]
  'run.byId': RunRow | null
  'run.events': RunEvent[]
  'run.last-event-seq': number
  'runtimes.workloads': RuntimeWorkload[]
  'runs.stale-chat': StaleChatRun[]
  /** 全部 open 卡，按 `createdAt` 升序（M4 顶部待审批条） */
  'cards.open': Card[]
  /** 某个 run 的卡片（含已答/已关闭），按 `createdAt` 升序 */
  'cards.byRun': Card[]
  /** 全部 waiting run 及其是否有 open 卡（启动对账 D13 用；无参数） */
  'runs.waiting': WaitingRun[]
}

export type ViewParams<T extends ViewId> = T extends keyof ViewArgs ? ViewArgs[T] : undefined

export type ViewResult<T extends ViewId> = ViewResults[T]
