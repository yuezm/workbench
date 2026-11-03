import { ipcMain } from 'electron'
import type {
  AgentInput,
  Runtime,
  RuntimeInput,
  RuntimeTestResult,
  TaskInput,
  WorkflowInput,
} from '../../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'
import type { ChatService } from './chat'
import { completeTask, enterTaskStage, moveTaskToStage, type Enqueue } from './engine'
import type { Repository } from './repository'
import { detectInstalledRuntimes } from './runtime/detect'
import { probeRuntime } from './runtime/probe'

/** 纯分发器：方法名 + 参数 → 结果；不含 electron 依赖，便于单测。 */
export type AiWorkflowHandler = (method: string, args: unknown[]) => unknown

export interface AiWorkflowIpcDeps {
  repo: Repository
  notifyChanged: () => void
  onQueue?: Enqueue
  /** 聊天执行服务；缺省时 chat.* 明确报错，避免静默无输出 */
  chat?: ChatService
  /** 运行时连通性探测；可注入假实现用于单测（缺省真实 spawn） */
  probeRuntime?: (runtime: Runtime) => Promise<RuntimeTestResult>
}

export function createAiWorkflowHandler(deps: AiWorkflowIpcDeps): AiWorkflowHandler {
  const { repo, notifyChanged, onQueue = () => {} } = deps
  const probe = deps.probeRuntime ?? ((runtime: Runtime) => probeRuntime(runtime))

  const mutate = (fn: () => unknown): unknown => {
    const result = fn()
    notifyChanged()
    return result
  }

  const chat = (): ChatService => {
    if (!deps.chat) throw new Error('聊天服务未就绪')
    return deps.chat
  }

  const table: Record<string, (a: unknown[]) => unknown> = {
    'runtimes.list': () => repo.runtimesList(),
    'runtimes.create': (a) => mutate(() => repo.runtimeCreate(a[0] as RuntimeInput)),
    'runtimes.update': (a) =>
      mutate(() => repo.runtimeUpdate(a[0] as string, a[1] as Partial<RuntimeInput>)),
    'runtimes.remove': (a) => mutate(() => repo.runtimeRemove(a[0] as string)),
    // 只读探测：不写库、不触发 changed
    'runtimes.detect': () => detectInstalledRuntimes(),
    // 连通性测试：真实调用一次运行时，但不建 run、不写库
    'runtimes.test': (a) => probe(repo.runtimeGet(a[0] as string)),

    'agents.list': () => repo.agentsList(),
    'agents.create': (a) => mutate(() => repo.agentCreate(a[0] as AgentInput)),
    'agents.update': (a) =>
      mutate(() => repo.agentUpdate(a[0] as string, a[1] as Partial<AgentInput>)),
    'agents.remove': (a) => mutate(() => repo.agentRemove(a[0] as string)),

    'workflows.list': () => repo.workflowsList(),
    'workflows.create': (a) => mutate(() => repo.workflowCreate(a[0] as WorkflowInput)),
    'workflows.update': (a) =>
      mutate(() => repo.workflowUpdate(a[0] as string, a[1] as WorkflowInput)),
    'workflows.remove': (a) => mutate(() => repo.workflowRemove(a[0] as string)),

    'tasks.list': (a) => repo.tasksList(a[0] as string),
    'tasks.create': (a) =>
      mutate(() => {
        const task = repo.taskCreate(a[0] as TaskInput)
        return enterTaskStage(repo, task, onQueue)
      }),
    // 看板拖拽：直接落到目标阶段
    'tasks.moveToStage': (a) =>
      mutate(() => moveTaskToStage(repo, a[0] as string, a[1] as string, onQueue)),
    // 看板拖到「已完成」区
    'tasks.complete': (a) => mutate(() => completeTask(repo, a[0] as string)),
    'tasks.remove': (a) => mutate(() => repo.taskRemove(a[0] as string)),

    'runs.listByTask': (a) => repo.runsListByTask(a[0] as string),

    'chat.listConversations': () => repo.chatConversationsList(),
    'chat.createConversation': (a) => mutate(() => repo.chatConversationCreate(a[0] as string)),
    'chat.removeConversation': (a) => mutate(() => repo.chatConversationRemove(a[0] as string)),
    'chat.listMessages': (a) => repo.chatMessagesList(a[0] as string),
    // 发起一轮：用户消息已落库后返回，输出走 AI_WORKFLOW_CHAT 流事件
    'chat.send': (a) => mutate(() => chat().send(a[0] as string, a[1] as string)),
    'chat.cancel': (a) => chat().cancel(a[0] as string),
  }

  return (method, args) => {
    const fn = table[method]
    if (!fn) throw new Error('未知方法: ' + method)
    return fn(args)
  }
}

export function registerAiWorkflowIpc(deps: AiWorkflowIpcDeps): void {
  const handler = createAiWorkflowHandler(deps)
  ipcMain.handle(AI_WORKFLOW_CHANNEL, (_event, method: string, args: unknown[]) =>
    handler(method, args),
  )
}
