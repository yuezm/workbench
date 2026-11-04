import { randomUUID } from 'node:crypto'
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
import type { Store } from '../../host/store/index'
import type { ChatService } from './chat'
import { agentById, createdId, runtimeById, taskById, workflowById } from './projection-lookup'
import type { Repository } from './repository'
import { detectInstalledRuntimes } from './runtime/detect'
import type { RuntimeBackend } from './runtime/registry'

/** 纯分发器：方法名 + 参数 → 结果；不含 electron 依赖，便于单测。 */
export type AiWorkflowHandler = (method: string, args: unknown[]) => unknown

export interface AiWorkflowIpcDeps {
  /** 唯一读入口：配置/任务/运行都读投影 */
  store: Store
  /**
   * 唯一写入口（装配根传 `effects.dispatch`）：提交事实并触发提交后分发。
   * 任务进入阶段的 `run.queued` 由内核产出，这里不再补写任何执行记录。
   */
  dispatch: Store['dispatch']
  /** 运行侧写路径已收口到事实，这里只保留聊天（T14 前仍是旧表）的读写 */
  repo: Repository
  /** 聊天执行服务；缺省时 chat.* 明确报错，避免静默无输出 */
  chat?: ChatService
  /** 协议后端（装配时注入；测试用假实现） */
  backendFor: (family: RuntimeProtocolFamily) => RuntimeBackend
  /**
   * 聊天写路径的变更通知：T14 前聊天仍直写旧表（不经事实），需要显式通知 UI；
   * 其余写操作由 ffects.dispatch 统一通知。
   */
  notifyChanged?: () => void
  /** 命令幂等键生成器（默认随机 UUID；测试可注入确定性值） */
  newCommandId?: () => string
}

/** 运行时配置里参与启动的部分（探测/模型目录只关心命令与 profile） */
function targetOf(runtime: Pick<Runtime, 'command' | 'profile'>): {
  command: string
  profile: string
} {
  return { command: runtime.command, profile: runtime.profile }
}

export function createAiWorkflowHandler(deps: AiWorkflowIpcDeps): AiWorkflowHandler {
  const { repo, store, dispatch, backendFor } = deps
  const nextCommandId = deps.newCommandId ?? (() => randomUUID())

  const notify = (): void => deps.notifyChanged?.()

  const chat = (): ChatService => {
    if (!deps.chat) throw new Error('聊天服务未就绪')
    return deps.chat
  }

  /** 探测并把结论入账（探测错误不抛：落库成 unavailable 行） */
  const probeAndSave = async (runtime: Runtime): Promise<RuntimeProbe> => {
    const probe = await backendFor(runtime.protocolFamily).probe(targetOf(runtime))
    dispatch({
      type: 'runtime.probed',
      commandId: nextCommandId(),
      id: runtime.id,
      probe,
    })
    return probe
  }

  const table: Record<string, (a: unknown[]) => unknown> = {
    'runtimes.list': () => store.query('runtimes.all'),
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
      const facts = dispatch({
        type: 'runtime.create',
        commandId: nextCommandId(),
        input,
      }).facts
      const runtimeId = createdId(facts, 'runtime.created')
      dispatch({
        type: 'runtime.probed',
        commandId: nextCommandId(),
        id: runtimeId,
        probe,
      })
      return runtimeById(store, runtimeId)
    },
    // 保存后重新探测：配置可能暂时不可用，结论入账由 UI 呈现
    'runtimes.update': async (a) => {
      const id = a[0] as string
      dispatch({
        type: 'runtime.update',
        commandId: nextCommandId(),
        id,
        patch: a[1] as Partial<RuntimeInput>,
      })
      const runtime = runtimeById(store, id)
      await probeAndSave(runtime)
      return runtimeById(store, id)
    },
    'runtimes.remove': (a) => {
      dispatch({ type: 'runtime.remove', commandId: nextCommandId(), id: a[0] as string })
    },
    // 只读探测：不 spawn、不写库
    'runtimes.detect': () => detectInstalledRuntimes(),
    // 真实探测：入账结论（探测不调用模型、不建 run）
    'runtimes.probe': async (a) => probeAndSave(runtimeById(store, a[0] as string)),
    // 实时负载：在跑/排队数按运行时现算
    'runtimes.statuses': () => {
      const workloads = new Map(repo.runtimeWorkloads().map((w) => [w.runtimeId, w]))
      return store.query('runtimes.all').map((runtime): RuntimeStatus => ({
        runtimeId: runtime.id,
        workload: {
          running: workloads.get(runtime.id)?.running ?? 0,
          queued: workloads.get(runtime.id)?.queued ?? 0,
          maxConcurrent: runtime.maxConcurrent,
        },
      }))
    },
    'runtimes.models': (a) => {
      const runtime = runtimeById(store, a[0] as string)
      return backendFor(runtime.protocolFamily).models(targetOf(runtime))
    },

    'agents.list': () => store.query('agents.all'),
    'agents.create': (a) => {
      const facts = dispatch({
        type: 'agent.create',
        commandId: nextCommandId(),
        input: a[0] as AgentInput,
      }).facts
      return agentById(store, createdId(facts, 'agent.created'))
    },
    'agents.update': (a) => {
      const id = a[0] as string
      dispatch({
        type: 'agent.update',
        commandId: nextCommandId(),
        id,
        patch: a[1] as Partial<AgentInput>,
      })
      return agentById(store, id)
    },
    'agents.remove': (a) => {
      dispatch({ type: 'agent.remove', commandId: nextCommandId(), id: a[0] as string })
    },

    'workflows.list': () => store.query('workflows.all'),
    'workflows.create': (a) => {
      const facts = dispatch({
        type: 'workflow.create',
        commandId: nextCommandId(),
        input: a[0] as WorkflowInput,
      }).facts
      return workflowById(store, createdId(facts, 'workflow.created'))
    },
    'workflows.update': (a) => {
      const id = a[0] as string
      dispatch({
        type: 'workflow.update',
        commandId: nextCommandId(),
        id,
        input: a[1] as WorkflowInput,
      })
      return workflowById(store, id)
    },
    'workflows.remove': (a) => {
      dispatch({ type: 'workflow.remove', commandId: nextCommandId(), id: a[0] as string })
    },

    'tasks.list': (a) => store.query('tasks.byWorkflow', { workflowId: a[0] as string }),
    // 任务进入 agent 阶段的 run.queued 由内核产事实（进入效果入内核，T10），这里不再补写
    'tasks.create': (a) => {
      const facts = dispatch({
        type: 'task.create',
        commandId: nextCommandId(),
        input: a[0] as TaskInput,
      }).facts
      return taskById(store, createdId(facts, 'task.created'))
    },
    // 看板拖拽：落点即目标阶段，进入效果由内核产 run.queued
    'tasks.moveToStage': (a) => {
      const id = a[0] as string
      dispatch({
        type: 'task.move',
        commandId: nextCommandId(),
        id,
        stageId: a[1] as string,
      })
      return taskById(store, id)
    },
    // 看板拖到「已完成」区
    'tasks.complete': (a) => {
      const id = a[0] as string
      dispatch({ type: 'task.complete', commandId: nextCommandId(), id })
      return taskById(store, id)
    },
    'tasks.remove': (a) => {
      dispatch({ type: 'task.remove', commandId: nextCommandId(), id: a[0] as string })
    },

    'runs.listByTask': (a) => repo.runsListByTask(a[0] as string),
    'runs.events': (a) => repo.runEventsList(a[0] as string),

    'chat.listConversations': () => repo.chatConversationsList(),
    'chat.createConversation': (a) => {
      const conversation = repo.chatConversationCreate(a[0] as string)
      notify()
      return conversation
    },
    'chat.removeConversation': (a) => {
      repo.chatConversationRemove(a[0] as string)
      notify()
    },
    'chat.listMessages': (a) => repo.chatMessagesList(a[0] as string),
    // 发起一轮：用户消息已落库后返回，输出走 AI_WORKFLOW_CHAT 流事件（T14 前仍是旧路径）
    'chat.send': (a) => {
      const sending = chat().send(a[0] as string, a[1] as string)
      notify()
      return sending
    },
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
