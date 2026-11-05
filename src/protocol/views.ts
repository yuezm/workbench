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
  DetectedRuntime,
  Message,
  Run,
  RunEvent,
  RunRow,
  Runtime,
  RuntimeExecutorChoice,
  RuntimeModelOption,
  RuntimeStatus,
  Task,
  WorkflowWithStages,
} from './entities'

/**
 * 视图 id 全集；新增视图必须先登记在这里，命令/宿主不得传任意字符串。
 * M5 追加 `tasks.executing`（「执行中」由内核给）、`runtimes.statuses`、`kernel.seq`
 * 与三个宿主视图（插件注册表 / CLI 探测 / 执行器模型目录）。
 */
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
  'tasks.executing',
  'runtimes.statuses',
  'kernel.seq',
  'runtimes.executors',
  'runtimes.detected',
  'runtimes.models',
] as const

/**
 * 宿主视图：由装配根注入的只读函数提供（插件注册表 / CLI 探测 / 执行器模型目录），
 * 不读投影、不写库、不发失效；与 DB 视图共用同一个 `query` 动词（M5 D4）。
 */
export const HOST_VIEW_IDS = ['runtimes.executors', 'runtimes.detected', 'runtimes.models'] as const

export type HostViewId = (typeof HOST_VIEW_IDS)[number]

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
  'runtimes.models': { runtimeId: string }
}

/**
 * 需要参数的视图 → 参数对象里的字段名（宿主在 `query` 入口按它校验形状：
 * 字段必填、字符串、长度上限与 id 一致；renderer 传的是不可信数据）。
 */
export const VIEW_PARAM_FIELDS: Partial<Record<ViewId, string>> = {
  'tasks.byWorkflow': 'workflowId',
  'task.byId': 'taskId',
  'runs.active-by-task': 'taskId',
  'messages.byConversation': 'conversationId',
  'runs.active-by-conversation': 'conversationId',
  'runs.byTask': 'taskId',
  'run.byId': 'runId',
  'run.events': 'runId',
  'run.last-event-seq': 'runId',
  'cards.byRun': 'runId',
  'runtimes.models': 'runtimeId',
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
  /** 存在 queued/running/waiting run 的 taskId 去重集合（看板 M5 只读它判断「执行中」） */
  'tasks.executing': string[]
  /** 各运行时实时负载（`runtimes.all` + `runtimes.workloads` 拼装，展示用） */
  'runtimes.statuses': RuntimeStatus[]
  /** 事实日志最大 seq（kernelStore 快照水位；无事实时为 0） */
  'kernel.seq': number
  /** 运行时表单可选执行器（宿主视图：插件注册表只读清单） */
  'runtimes.executors': RuntimeExecutorChoice[]
  /** 本机 CLI 探测结果（宿主视图：只读扫描，不写库） */
  'runtimes.detected': DetectedRuntime[]
  /** 某运行时的模型目录（宿主视图：执行器只读调用） */
  'runtimes.models': RuntimeModelOption[]
}

export type ViewParams<T extends ViewId> = T extends keyof ViewArgs ? ViewArgs[T] : undefined

export type ViewResult<T extends ViewId> = ViewResults[T]
