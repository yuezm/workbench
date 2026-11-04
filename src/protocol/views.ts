/**
 * M1 视图契约：宿主按 `viewSpec` 装载投影切片，`query(view, params)` 返回。
 *
 * 只落内核侧 `decide` 与看板当前需要的最小集；M5 的完整视图清单
 * （threads / cards / timeline 等）届时在此扩展。
 */
import type { Agent, Conversation, Message, Runtime, Task, WorkflowWithStages } from './entities'

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

/** 需要参数的视图 → 参数形状；无参数视图不出现在这里。 */
export interface ViewArgs {
  'tasks.byWorkflow': { workflowId: string }
  'task.byId': { taskId: string }
  'runs.active-by-task': { taskId: string }
  'messages.byConversation': { conversationId: string }
  'runs.active-by-conversation': { conversationId: string }
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
}

export type ViewParams<T extends ViewId> = T extends keyof ViewArgs ? ViewArgs[T] : undefined

export type ViewResult<T extends ViewId> = ViewResults[T]
