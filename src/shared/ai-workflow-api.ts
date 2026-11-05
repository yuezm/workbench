/**
 * ai-workflow app 的跨进程契约（preload 与 renderer 共用）。
 * renderer 通过 window.aiWorkflow 调用，禁止直接 import electron。
 *
 * 采用单一 RPC 通道：preload 把方法名与参数发给主进程，主进程路由到具体 handler。
 *
 * 运行时模型对齐 Multica：运行时 = 「协议族 + 本机 CLI 启动方式 + 执行策略」的
 * 实例；进程间用版本化 JSONL 协议通信（dsh profile 的 --stdio），
 * 健康状态由 --probe 帧给出，执行结果归一为运行事件流 + 终态结果。
 */

import type {
  Agent,
  AgentInput,
  Card,
  Conversation as ChatConversation,
  DetectedRuntime,
  Message as ChatMessage,
  Run,
  RunEvent,
  Runtime,
  RuntimeInput,
  RuntimeModelOption,
  RuntimeProbe,
  Task,
  TaskInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../protocol/entities'

// ---------- 实体契约（五张投影表） ----------
// 行类型与输入类型定义在 protocol 层（kernel 只依赖 protocol），这里 re-export
// 供 preload / renderer 使用；字段与旧定义逐一对应，IPC 形状不变。
export type {
  Agent,
  AgentInput,
  Card,
  CardAnswerVia,
  CardDelivery,
  CardResolveReason,
  CardStatus,
  DetectedRuntime,
  EntryMode,
  PermissionMode,
  Runtime,
  RuntimeInput,
  RuntimeModelOption,
  RuntimeProbe,
  RuntimeProbeState,
  StageInput,
  Task,
  TaskInput,
  TaskStatus,
  Workflow,
  WorkflowInput,
  WorkflowStage,
  WorkflowWithStages,
} from '../protocol/entities'

// ---------- 运行时 ----------

/** 运行时的动态负载（不落库，按 runs 现算） */
export interface RuntimeStatus {
  runtimeId: string
  workload: {
    running: number
    queued: number
    maxConcurrent: number
  }
}

/**
 * 运行时表单可选的执行器（只读，来自插件注册表）。
 *
 * `command` / `profile` 是该插件 manifest 声明的表单默认值；新建运行时选执行器时
 * 用它预填，用户仍可改。数组顺序即注册表顺序（UI 下拉顺序）。
 */
export interface RuntimeExecutorChoice {
  key: string
  label: string
  command: string
  profile: string
}

/** 本机已安装的 agent CLI 探测结果（用于表单预填，不自动创建运行时）。
 *  字段定义在 `protocol/entities`（执行器插件 detect 的返回类型），这里只再导出。 */

// ---------- 运行 / 对话 ----------
// 契约搬到了 protocol/entities（kernel 与本层共用一份）：这里只 re-export，
// 旧的导出名（`Run` / `RunEvent` / `RunStatus` / `ChatConversation` / `ChatMessage`）
// 与字段逐一对应，IPC 形状不变；`waiting` 与 `executor_lost` 是 M2 新增的取值，
// 只增不改（旧值语义不变）。
export type {
  ChatRole,
  Conversation as ChatConversation,
  Message as ChatMessage,
  Run,
  RunErrorCode,
  RunEvent,
  RunEventType,
  RunPurpose,
  RunStatus,
  RunUsage,
} from '../protocol/entities'

/** 聊天流事件：本轮执行的增量事件与结束通知（结束时结果已落库） */
export interface ChatStreamEvent {
  conversationId: string
  type: 'event' | 'end'
  /** 仅 event 事件携带 */
  event?: RunEvent
}

// ---------- IPC 契约 ----------

export interface AiWorkflowApi {
  runtimes: {
    list(): Promise<Runtime[]>
    /** 创建前先探测；探测失败抛错且不落库 */
    create(input: RuntimeInput): Promise<Runtime>
    /** 保存后重新探测并落库最新结论（不抛探测错误） */
    update(id: string, patch: Partial<RuntimeInput>): Promise<Runtime>
    remove(id: string): Promise<void>
    /** 探测本机已安装的 agent CLI，供表单预填；只读，不创建记录 */
    detect(): Promise<DetectedRuntime[]>
    /** 可选执行器清单（来自插件注册表）；只读，供运行时表单下拉 */
    executors(): Promise<RuntimeExecutorChoice[]>
    /** 真实探测一次（--probe + 版本），并把结论写入运行时；不产生 run */
    probe(id: string): Promise<RuntimeProbe>
    /** 各运行时的实时负载 */
    statuses(): Promise<RuntimeStatus[]>
    /** 读取该运行时的模型目录（--list-models），失败抛错 */
    models(id: string): Promise<RuntimeModelOption[]>
  }
  agents: {
    list(): Promise<Agent[]>
    create(input: AgentInput): Promise<Agent>
    update(id: string, patch: Partial<AgentInput>): Promise<Agent>
    remove(id: string): Promise<void>
  }
  workflows: {
    list(): Promise<WorkflowWithStages[]>
    create(input: WorkflowInput): Promise<WorkflowWithStages>
    update(id: string, input: WorkflowInput): Promise<WorkflowWithStages>
    remove(id: string): Promise<void>
  }
  tasks: {
    list(workflowId: string): Promise<Task[]>
    create(input: TaskInput): Promise<Task>
    /** 看板拖拽：把任务直接放到目标阶段（执行中的阶段除外） */
    moveToStage(id: string, stageId: string): Promise<Task>
    /** 看板拖拽到「已完成」区：任务移出看板 */
    complete(id: string): Promise<Task>
    remove(id: string): Promise<void>
  }
  runs: {
    listByTask(taskId: string): Promise<Run[]>
    /** 该 run 的事件流（运行中可轮询增量） */
    events(runId: string): Promise<RunEvent[]>
  }
  /** 审批卡片（M4）：顶部待审批条读 open 卡、按钮回答 */
  cards: {
    /** 全部 open 卡，按 createdAt 升序 */
    open(): Promise<Card[]>
    /**
     * 回答一张卡（`via='ui'`，`commandId` 由宿主生成）。
     * 成功返回回答后的卡片行；重复回答 / 已关闭 / 选项越界由内核 reject，抛可读错误文案。
     */
    answer(cardId: string, optionIndex: number): Promise<Card | void>
  }
  /** 主动对话：独立于工作流与任务，选中智能体直接聊 */
  chat: {
    listConversations(): Promise<ChatConversation[]>
    createConversation(agentId: string): Promise<ChatConversation>
    removeConversation(id: string): Promise<void>
    listMessages(conversationId: string): Promise<ChatMessage[]>
    /** 发起一轮：先落用户消息，再异步执行；输出经 onEvent 推送 */
    send(conversationId: string, content: string): Promise<void>
    /** 中止该对话正在执行的一轮 */
    cancel(conversationId: string): Promise<void>
    /** 订阅流事件；返回取消订阅函数 */
    onEvent(cb: (event: ChatStreamEvent) => void): () => void
  }
  /** 任意变更/运行进度后触发；返回取消订阅函数 */
  onChanged(cb: () => void): () => void
}

/** 单一 RPC 通道：preload -> main */
export const AI_WORKFLOW_CHANNEL = 'ai-workflow:invoke'
/** main -> renderer 变更通知 */
export const AI_WORKFLOW_CHANGED = 'ai-workflow:changed'
/** main -> renderer 聊天流事件（增量输出 / 本轮结束） */
export const AI_WORKFLOW_CHAT = 'ai-workflow:chat'
