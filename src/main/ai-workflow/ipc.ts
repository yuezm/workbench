import { ipcMain } from 'electron'
import type {
  AgentInput,
  Runtime,
  RuntimeInput,
  RuntimeProbe,
  RuntimeProtocolFamily,
  RuntimeStatus,
  TaskInput,
  WorkflowInput,
} from '../../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'
import type { ChatService } from './chat'
import { completeTask, enterTaskStage, moveTaskToStage, type Enqueue } from './engine'
import type { Repository } from './repository'
import { detectInstalledRuntimes } from './runtime/detect'
import type { RuntimeBackend } from './runtime/registry'

/** 纯分发器：方法名 + 参数 → 结果；不含 electron 依赖，便于单测。 */
export type AiWorkflowHandler = (method: string, args: unknown[]) => unknown

export interface AiWorkflowIpcDeps {
  repo: Repository
  notifyChanged: () => void
  onQueue?: Enqueue
  /** 聊天执行服务；缺省时 chat.* 明确报错，避免静默无输出 */
  chat?: ChatService
  /** 协议后端（装配时注入；测试用假实现） */
  backendFor: (family: RuntimeProtocolFamily) => RuntimeBackend
}

/** 运行时配置里参与启动的部分（探测/模型目录只关心命令与 profile） */
function targetOf(runtime: Pick<Runtime, 'command' | 'profile'>): {
  command: string
  profile: string
} {
  return { command: runtime.command, profile: runtime.profile }
}

export function createAiWorkflowHandler(deps: AiWorkflowIpcDeps): AiWorkflowHandler {
  const { repo, notifyChanged, onQueue = () => {}, backendFor } = deps

  const mutate = (fn: () => unknown): unknown => {
    const result = fn()
    notifyChanged()
    return result
  }

  const chat = (): ChatService => {
    if (!deps.chat) throw new Error('聊天服务未就绪')
    return deps.chat
  }

  /** 探测并把结论写回运行时（探测错误不抛：落库成 unavailable） */
  const probeAndSave = async (runtime: Runtime): Promise<RuntimeProbe> => {
    const probe = await backendFor(runtime.protocolFamily).probe(targetOf(runtime))
    repo.runtimeSetProbe(runtime.id, probe)
    return probe
  }

  const table: Record<string, (a: unknown[]) => unknown> = {
    'runtimes.list': () => repo.runtimesList(),
    // 创建前先探测：命令/profile 不通就不落库，避免留下不可用的记录
    'runtimes.create': async (a) => {
      const input = a[0] as RuntimeInput
      const probe = await backendFor(input.protocolFamily ?? 'dsh').probe({
        command: input.command?.trim() || 'dsh',
        profile: input.profile?.trim() || 'multica',
      })
      if (probe.state !== 'ready') {
        throw new Error(`探测失败：${probe.error ?? '未知错误'}`)
      }
      const runtime = repo.runtimeCreate(input)
      const saved = repo.runtimeSetProbe(runtime.id, probe)
      notifyChanged()
      return saved
    },
    // 保存后重新探测：配置可能暂时不可用，结论落库由 UI 呈现
    'runtimes.update': async (a) => {
      const runtime = repo.runtimeUpdate(a[0] as string, a[1] as Partial<RuntimeInput>)
      const probe = await probeAndSave(runtime)
      notifyChanged()
      return { ...runtime, lastProbe: probe }
    },
    'runtimes.remove': (a) => mutate(() => repo.runtimeRemove(a[0] as string)),
    // 只读探测：不 spawn、不写库
    'runtimes.detect': () => detectInstalledRuntimes(),
    // 真实探测：写回结论（探测不调用模型、不建 run）
    'runtimes.probe': async (a) => {
      const probe = await probeAndSave(repo.runtimeGet(a[0] as string))
      notifyChanged()
      return probe
    },
    // 实时负载：在跑/排队数按运行时现算
    'runtimes.statuses': () => {
      const workloads = new Map(repo.runtimeWorkloads().map((w) => [w.runtimeId, w]))
      return repo.runtimesList().map((runtime): RuntimeStatus => ({
        runtimeId: runtime.id,
        workload: {
          running: workloads.get(runtime.id)?.running ?? 0,
          queued: workloads.get(runtime.id)?.queued ?? 0,
          maxConcurrent: runtime.maxConcurrent,
        },
      }))
    },
    'runtimes.models': (a) => {
      const runtime = repo.runtimeGet(a[0] as string)
      return backendFor(runtime.protocolFamily).models(targetOf(runtime))
    },

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
    'runs.events': (a) => repo.runEventsList(a[0] as string),

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
