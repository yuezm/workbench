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
  Runtime,
  RuntimeInput,
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
  EntryMode,
  PermissionMode,
  Runtime,
  RuntimeInput,
  RuntimeProbe,
  RuntimeProbeState,
  RuntimeProtocolFamily,
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

/** 本机已安装的 agent CLI 探测结果（用于表单预填，不自动创建运行时） */
export interface DetectedRuntime {
  /** CLI 命令名，如 dsh / claude */
  command: string
  /** 展示名，如 "DeepSeek Harness" */
  label: string
  /** 可执行文件绝对路径 */
  path: string
  /** 当前版本是否可作为运行时接入（协议后端已实现） */
  supported: boolean
}

/** --list-models 投影出的模型选项 */
export interface RuntimeModelOption {
  /** provider/model 形式的 id，可直接写入 Runtime.model */
  id: string
  label: string
  provider: string
  /** 是否为 CLI 默认模型 */
  default: boolean
  /** 支持的推理强度（thinking level） */
  thinkingLevels: string[]
  defaultThinkingLevel: string | null
}

// ---------- 运行 ----------

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 运行失败归类：UI 按此给出可操作提示 */
export type RunErrorCode =
  | 'spawn_failed'
  | 'exit_nonzero'
  | 'run_failed'
  | 'timeout'
  | 'cancelled'
  | 'protocol_error'
  | 'no_result'
  | 'runtime_missing'
  | 'runtime_disabled'

export type RunEventType = 'status' | 'text' | 'thinking' | 'tool_call' | 'tool_result'

/** 运行过程中的一条事件（顺序由 seq 保证） */
export interface RunEvent {
  seq: number
  type: RunEventType
  /** text / thinking 的增量文本 */
  text?: string
  /** tool_call / tool_result 的工具名 */
  tool?: string
  /** tool_call / tool_result 的调用 id */
  callId?: string
  /** tool_call 的参数（JSON 字符串） */
  input?: string
  /** tool_result 的输出 */
  output?: string
  /** tool_result 是否失败 */
  isError?: boolean
  /** status 事件的阶段文案（如 running） */
  status?: string
}

/** 一次运行的 token 用量（按协议帧累加） */
export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface Run {
  id: string
  taskId: string
  stageId: string | null
  agentId: string | null
  /** 执行该 run 的运行时（运行时被删后置空） */
  runtimeId: string | null
  status: RunStatus
  prompt: string
  /** 最终文本输出（事件流的 text 汇总） */
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  /** CLI 进程退出码；未能启动或超时后强杀为 null */
  exitCode: number | null
  /** 协议会话 id（可用于续接） */
  sessionId: string | null
  usage: RunUsage | null
  /** 执行耗时（毫秒） */
  durationMs: number | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

// ---------- 聊天 ----------

export type ChatRole = 'user' | 'assistant'

/** 一段独立对话：绑定一个智能体，与工作流/任务无关 */
export interface ChatConversation {
  id: string
  title: string
  agentId: string
  /** 上一轮的协议会话 id；下一轮用它续接，避免整段历史重发 */
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: ChatRole
  content: string
  /** 该条助手消息的失败原因（非零退出 / 超时 / 取消）；成功与用户消息为 null */
  error: string | null
  createdAt: string
}

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
