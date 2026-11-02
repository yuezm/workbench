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
export type TaskMoveAction = 'approve' | 'reject' | 'next'

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
  id?: string
  name: string
  entryMode: EntryMode
  agentId?: string | null
  onCompleteStageId?: string | null
  onRejectStageId?: string | null
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

export interface AiWorkflowApi {
  runtimes: {
    list(): Promise<Runtime[]>
    create(input: RuntimeInput): Promise<Runtime>
    update(id: string, patch: Partial<RuntimeInput>): Promise<Runtime>
    remove(id: string): Promise<void>
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
    move(id: string, action: TaskMoveAction): Promise<Task>
    remove(id: string): Promise<void>
  }
  runs: {
    listByTask(taskId: string): Promise<Run[]>
  }
  /** 任意变更/运行进度后触发；返回取消订阅函数 */
  onChanged(cb: () => void): () => void
}

/** 单一 RPC 通道：preload -> main */
export const AI_WORKFLOW_CHANNEL = 'ai-workflow:invoke'
/** main -> renderer 变更通知 */
export const AI_WORKFLOW_CHANGED = 'ai-workflow:changed'
