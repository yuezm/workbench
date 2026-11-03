/**
 * ai-workflow app 的跨进程契约（preload 与 renderer 共用）。
 * renderer 通过 window.aiWorkflow 调用，禁止直接 import electron。
 *
 * 采用单一 RPC 通道：preload 把方法名与参数发给主进程，主进程路由到具体 handler。
 */

export type RuntimeKind = 'deepseek-harness'
export type PromptMode = 'stdin' | 'arg'
export type EntryMode = 'none' | 'agent' | 'user'
export type TaskStatus = 'active' | 'completed'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface Runtime {
  id: string
  name: string
  kind: RuntimeKind
  command: string
  args: string[]
  promptMode: PromptMode
  workdir: string | null
  createdAt: string
}

export interface RuntimeInput {
  name: string
  kind?: RuntimeKind
  command: string
  args?: string[]
  promptMode?: PromptMode
  workdir?: string | null
}

/** 本机已安装的 agent CLI 探测结果（用于表单预填，不自动创建运行时） */
export interface DetectedRuntime {
  /** CLI 命令名，如 dsh / claude */
  command: string
  /** 展示名，如 "DeepSeek Harness" */
  label: string
  /** 可执行文件绝对路径 */
  path: string
}

/** 运行时连通性测试结果（只读探测：不写库、不建 run、不触发 changed） */
export interface RuntimeTestResult {
  /** 命令能启动、正常退出（退出码 0）且未超时 */
  ok: boolean
  /** 进程退出码；没能启动或超时为 null */
  code: number | null
  /** 从发起探测到结束的耗时（毫秒） */
  elapsedMs: number
  /** 输出尾部（已截断），供失败排查 */
  output: string
  /** 失败原因：超时 / 退出码 / 启动失败；成功为 null */
  error: string | null
}

export interface Agent {
  id: string
  name: string
  description: string
  runtimeId: string
  systemPrompt: string
  createdAt: string
}

export interface AgentInput {
  name: string
  description?: string
  runtimeId: string
  systemPrompt?: string
}

export interface WorkflowStage {
  id: string
  workflowId: string
  name: string
  position: number
  entryMode: EntryMode
  agentId: string | null
  onCompleteStageId: string | null
  onRejectStageId: string | null
}

export interface StageInput {
  name: string
  entryMode: EntryMode
  agentId?: string | null
  /** 完成后进入：目标阶段在 stages 数组中的下标；null/undefined = 默认（下一阶段 / 终端） */
  onCompleteIndex?: number | null
  /** 打回时退回到：目标阶段下标；null/undefined = 默认（上一阶段 / 原地） */
  onRejectIndex?: number | null
}

export interface Workflow {
  id: string
  name: string
  description: string
  createdAt: string
}

export interface WorkflowWithStages extends Workflow {
  stages: WorkflowStage[]
}

export interface WorkflowInput {
  name: string
  description?: string
  stages: StageInput[]
}

export interface Task {
  id: string
  title: string
  description: string
  workflowId: string
  currentStageId: string | null
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface TaskInput {
  title: string
  description?: string
  workflowId: string
  /** 起始阶段；缺省为首阶段 */
  stageId?: string
}

export interface Run {
  id: string
  taskId: string
  stageId: string | null
  agentId: string | null
  status: RunStatus
  prompt: string
  output: string
  error: string | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

export type ChatRole = 'user' | 'assistant'

/** 一段独立对话：绑定一个智能体，与工作流/任务无关 */
export interface ChatConversation {
  id: string
  title: string
  agentId: string
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

/** 聊天流事件：本轮执行的增量输出与结束通知（结束时结果已落库） */
export interface ChatStreamEvent {
  conversationId: string
  type: 'chunk' | 'end'
  /** 仅 chunk 事件携带 */
  chunk?: string
}

export interface AiWorkflowApi {
  runtimes: {
    list(): Promise<Runtime[]>
    create(input: RuntimeInput): Promise<Runtime>
    update(id: string, patch: Partial<RuntimeInput>): Promise<Runtime>
    remove(id: string): Promise<void>
    /** 探测本机已安装的 agent CLI，供表单预填；只读，不创建记录 */
    detect(): Promise<DetectedRuntime[]>
    /** 连通性测试：真实调用一次该运行时，不写库、不建 run */
    test(id: string): Promise<RuntimeTestResult>
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
