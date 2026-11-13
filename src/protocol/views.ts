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
  Project,
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
import type { RuleSetView } from './rules'
import type { PluginSettingsView, PluginView } from './plugins'
import type { ThreadRow } from './thread'
import type { ReviewReport } from './review'
import type { TaskComment } from './task-comment'

/**
 * 视图 id 全集；新增视图必须先登记在这里，命令/宿主不得传任意字符串。
 * M5 追加 `tasks.executing`（「执行中」由内核给）、`runtimes.statuses`、`kernel.seq`
 * 与三个宿主视图（插件注册表 / CLI 探测 / 执行器模型目录）。
 */
export const VIEW_IDS = [
  'workflows.all',
  'agents.all',
  'runtimes.all',
  'projects.all',
  'tasks.byProject',
  'tasks.unassigned',
  'tasks.byWorkflow',
  'tasks.byParent',
  'task.byId',
  'runs.active-by-task',
  'conversations.all',
  'conversations.byProject',
  'conversations.unassigned',
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
  'rules.all',
  'plugins.settings',
  'plugins.all',
  'thread.byId',
  'comments.byTask',
  'reviews.byTask',
  'run.approvals',
  'runtimes.default-workdir',
  'workflow.stage-metrics',
] as const

/**
 * 宿主视图：由装配根注入的只读函数提供（插件注册表 / CLI 探测 / 执行器模型目录 /
 * 磁盘插件目录 / 会话日志里的提权记录），不读投影、不写库、不发失效；
 * 与 DB 视图共用同一个 `query` 动词（M5 D4）。
 */
export const HOST_VIEW_IDS = [
  'runtimes.executors',
  'runtimes.detected',
  'runtimes.models',
  'plugins.all',
  'run.approvals',
  'runtimes.default-workdir',
] as const

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

/**
 * 一次沙箱提权请求（`run.approvals`）：来自该 run 的 dsh 会话日志
 * 里的 `approval/asked` / `approval/decided` 事件，只读解析、不入库、不进事件流。
 *
 * 为什么要有它：运行时对提权请求的回答是自动的（dsh 桥接层恒回 `allowed-once`），
 * 界面上原本没有任何痕迹。这里把「谁在什么时候要求了什么权限、理由是什么、结果如何」
 * 摆到任务详情里，让自动放行至少可复核。
 */
export interface RunApproval {
  /** 授权请求 id（`approval/asked` 的 `data.id`） */
  id: string
  /** 请求时刻（ISO；取自会话日志 `time`） */
  at: string
  /** 发起提权的工具名（如 `pwsh` / `bash`） */
  tool: string
  /** 工具调用 id（与事件流对齐用；日志缺省时 null） */
  callId: string | null
  /** 模型给出的理由（自由文本，可能为空） */
  reason: string
  /** 结果：`allowed-once` / `rejected` / `cancelled` / `unavailable`；尚未落定时 null */
  outcome: string | null
}

/** 需要参数的视图 → 参数形状；无参数视图不出现在这里。 */
export interface ViewArgs {
  'workflow.stage-metrics': { workflowId: string }
  'tasks.byProject': { projectId: string }
  'tasks.byWorkflow': { workflowId: string }
  'tasks.byParent': { taskId: string }
  'task.byId': { taskId: string }
  'runs.active-by-task': { taskId: string }
  'conversations.byProject': { projectId: string }
  'messages.byConversation': { conversationId: string }
  'runs.active-by-conversation': { conversationId: string }
  'runs.byTask': { taskId: string }
  'run.byId': { runId: string }
  'run.events': { runId: string }
  'run.last-event-seq': { runId: string }
  'cards.byRun': { runId: string }
  'runtimes.models': { runtimeId: string }
  'thread.byId': { threadId: string }
  'comments.byTask': { taskId: string }
  'reviews.byTask': { taskId: string }
  'run.approvals': { runId: string }
}

/**
 * 线程详情（`thread.byId`）：线程行 + 线程内任务（按创建顺序）+ 每个智能体最近的会话 id。
 *
 * `sessions` 由 `runs` 现算（不落线程行）：同一智能体在线程内最近一次终态 run 的会话 id。
 */
export interface ThreadDetail {
  thread: ThreadRow
  tasks: Task[]
  sessions: Record<string, string>
}

/**
 * 一个阶段的运行指标（M23）：全部由投影**现算**，不新增表。
 *
 * 用途是「先放后收」的判定依据——哪条流程真的在自动跑、哪条总是卡在人手里。
 * 这里的口径都取近似可算的那一种（评论按任务当前阶段归属），不做归因推断。
 */
export interface StageMetric {
  stageId: string
  stageName: string
  /** 该阶段跑过多少轮 stage run */
  runs: number
  /** 闸门结论计数（M34）：该阶段评审报告的 `verdict`；非闸门阶段恒 0 */
  verdicts: { pass: number; fail: number }
  /** 任务标签里带 `gate:degraded` 且停在该阶段的条数 */
  degraded: number
  /** 该阶段 run 上发出的 ask 卡数量 */
  asks: number
  /** 该阶段任务上的人写评论数 */
  humanComments: number
}

/** 工作流阶段指标（`workflow.stage-metrics`）：按阶段 position 排序。 */
export interface WorkflowStageMetrics {
  workflowId: string
  stages: StageMetric[]
}

/**
 * 需要参数的视图 → 参数对象里的字段名（宿主在 `query` 入口按它校验形状：
 * 字段必填、字符串、长度上限与 id 一致；renderer 传的是不可信数据）。
 */
export const VIEW_PARAM_FIELDS: Partial<Record<ViewId, string>> = {
  'workflow.stage-metrics': 'workflowId',
  'tasks.byProject': 'projectId',
  'tasks.byWorkflow': 'workflowId',
  'tasks.byParent': 'taskId',
  'task.byId': 'taskId',
  'runs.active-by-task': 'taskId',
  'conversations.byProject': 'projectId',
  'messages.byConversation': 'conversationId',
  'runs.active-by-conversation': 'conversationId',
  'runs.byTask': 'taskId',
  'run.byId': 'runId',
  'run.events': 'runId',
  'run.last-event-seq': 'runId',
  'cards.byRun': 'runId',
  'runtimes.models': 'runtimeId',
  'thread.byId': 'threadId',
  'comments.byTask': 'taskId',
  'reviews.byTask': 'taskId',
  'run.approvals': 'runId',
}

/** 视图 id → 返回类型。 */
export interface ViewResults {
  'workflows.all': WorkflowWithStages[]
  'agents.all': Agent[]
  'runtimes.all': Runtime[]
  /** 全部项目（M10），按创建时间升序；项目是任务的容器与执行工作目录 */
  'projects.all': Project[]
  /** 某项目下的任务（M10），按创建时间升序；看板再按工作流过滤，并按最近活动倒序铺开 */
  'tasks.byProject': Task[]
  /**
   * 没有项目的任务（M10）：v2 存量、老规则建的任务。界面归入「未归属」，
   * 不随项目删除而消失（项目删除要求项目下没有任务）。
   */
  'tasks.unassigned': Task[]
  'tasks.byWorkflow': Task[]
  'tasks.byParent': Task[]
  'task.byId': Task | null
  'runs.active-by-task': ActiveRun[]
  'conversations.all': Conversation[]
  /**
   * 某项目下的对话（M11）：聊天清单按当前项目过滤，口径与 `tasks.byProject` 一致。
   * 项目是聊天与任务共用的顶层上下文。
   */
  'conversations.byProject': Conversation[]
  /** 没有项目的对话（M11）：归入「默认目录」，老事实 / 存量行同样落这里 */
  'conversations.unassigned': Conversation[]
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
  /** 当前规则集（M6）：版本 + 规则清单；无规则时为 `{version:0, rules:[]}` */
  'rules.all': RuleSetView
  /** 插件设置快照（M7）：版本 + 设置清单；无快照时为 `{version:0, replacedAt:null, settings:[]}` */
  'plugins.settings': PluginSettingsView
  /** 磁盘插件目录 + 设置 + 运行状态（M7 宿主视图；secret 只回键名） */
  'plugins.all': PluginView[]
  /** 线程详情（M6.5）：线程行 + 任务树来源 + 各智能体最近会话 id；不存在时为 null */
  'thread.byId': ThreadDetail | null
  /** 任务上下文 / 反馈（M7.5）：按追加顺序（`createdAt` 升序） */
  'comments.byTask': TaskComment[]
  /** 任务的评审报告（M14）：按 `rev` 升序；没有任何评审时为空数组 */
  'reviews.byTask': ReviewReport[]
  /**
   * 该 run 的沙箱提权记录（宿主视图，只读会话日志）：
   * 按请求时刻升序，最多 50 条；没有记录 / 会话日志缺席时为空数组。
   */
  'run.approvals': RunApproval[]
  /**
   * 默认工作目录（宿主视图，无参数）：运行时 `workdir` 留空时执行器用的绝对路径。
   * 解析口径 = `WORKBENCH_WORKDIR` 环境变量 > `~/.workbench`，启动时确保目录存在。
   */
  'runtimes.default-workdir': string
  /** 工作流各阶段的运行指标（M23，只读派生）：用于判断「哪条流程真的在自动跑」 */
  'workflow.stage-metrics': WorkflowStageMetrics
}

export type ViewParams<T extends ViewId> = T extends keyof ViewArgs ? ViewArgs[T] : undefined

export type ViewResult<T extends ViewId> = ViewResults[T]
