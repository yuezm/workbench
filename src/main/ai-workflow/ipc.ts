import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type {
  Agent,
  AgentInput,
  Runtime,
  RuntimeInput,
  RuntimeProbe,
  RuntimeProtocolFamily,
  RuntimeStatus,
  Task,
  TaskInput,
  Workflow,
  WorkflowInput,
  WorkflowWithStages,
} from '../../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'
import type { Fact } from '../../kernel/types'
import type { FactType } from '../../protocol/facts'
import type { Store } from '../../host/store/index'
import { applyTaskEffects, type TaskEffectsDeps } from '../../host/task-effects'
import type { ChatService } from './chat'
import type { Repository } from './repository'
import { detectInstalledRuntimes } from './runtime/detect'
import type { RuntimeBackend } from './runtime/registry'

/** 通知调度器有新 run 可以跑（runner.enqueue）。 */
export type Enqueue = (runId: string) => void

/** 纯分发器：方法名 + 参数 → 结果；不含 electron 依赖，便于单测。 */
export type AiWorkflowHandler = (method: string, args: unknown[]) => unknown

export interface AiWorkflowIpcDeps {
  /** 唯一写入口：配置/任务命令与业务视图都走它 */
  store: Store
  /** 运行侧与聊天仍直接读写（不在 M1 投影集内） */
  repo: Repository
  notifyChanged: () => void
  onQueue?: Enqueue
  /** 聊天执行服务；缺省时 chat.* 明确报错，避免静默无输出 */
  chat?: ChatService
  /** 协议后端（装配时注入；测试用假实现） */
  backendFor: (family: RuntimeProtocolFamily) => RuntimeBackend
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

/**
 * 从刚提交的事实里取新实体 id（create 类命令用）。
 * 读投影也能拿到，但用事实更直接：同一事务里刚写的行就是它，不存在并发歧义。
 */
function createdId(facts: readonly Fact[], type: FactType): string {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error('缺少事实: ' + type)
  switch (fact.type) {
    case 'runtime.created':
      return (fact.payload as { runtime: Runtime }).runtime.id
    case 'agent.created':
      return (fact.payload as { agent: Agent }).agent.id
    case 'workflow.created':
      return (fact.payload as { workflow: Workflow }).workflow.id
    case 'task.created':
      return (fact.payload as { task: Task }).task.id
    default:
      throw new Error('事实不携带实体 id: ' + fact.type)
  }
}

export function createAiWorkflowHandler(deps: AiWorkflowIpcDeps): AiWorkflowHandler {
  const { repo, store, notifyChanged, onQueue = () => {}, backendFor } = deps
  const nextCommandId = deps.newCommandId ?? (() => randomUUID())

  const mutate = (fn: () => unknown): unknown => {
    const result = fn()
    notifyChanged()
    return result
  }

  const chat = (): ChatService => {
    if (!deps.chat) throw new Error('聊天服务未就绪')
    return deps.chat
  }

  /** 读投影：store 是业务表的唯一读路径（runs / 聊天仍走 repo）。 */
  const runtimeById = (id: string): Runtime => {
    const runtime = store.query('runtimes.all').find((item) => item.id === id)
    if (!runtime) throw new Error('运行时不存在: ' + id)
    return runtime
  }
  const agentById = (id: string): Agent => {
    const agent = store.query('agents.all').find((item) => item.id === id)
    if (!agent) throw new Error('智能体不存在: ' + id)
    return agent
  }
  const workflowById = (id: string): WorkflowWithStages => {
    const workflow = store.query('workflows.all').find((item) => item.id === id)
    if (!workflow) throw new Error('工作流不存在: ' + id)
    return workflow
  }
  const taskById = (id: string): Task => {
    const task = store.query('task.byId', { taskId: id })
    if (!task) throw new Error('任务不存在: ' + id)
    return task
  }

  const effectsDeps = (): TaskEffectsDeps => ({ store, repo, onQueue, commandId: nextCommandId })

  /** 探测并把结论入账（探测错误不抛：落库成 unavailable 行） */
  const probeAndSave = async (runtime: Runtime): Promise<RuntimeProbe> => {
    const probe = await backendFor(runtime.protocolFamily).probe(targetOf(runtime))
    store.dispatch({
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
      const facts = store.dispatch({
        type: 'runtime.create',
        commandId: nextCommandId(),
        input,
      }).facts
      const runtimeId = createdId(facts, 'runtime.created')
      store.dispatch({
        type: 'runtime.probed',
        commandId: nextCommandId(),
        id: runtimeId,
        probe,
      })
      notifyChanged()
      return runtimeById(runtimeId)
    },
    // 保存后重新探测：配置可能暂时不可用，结论入账由 UI 呈现
    'runtimes.update': async (a) => {
      const id = a[0] as string
      store.dispatch({
        type: 'runtime.update',
        commandId: nextCommandId(),
        id,
        patch: a[1] as Partial<RuntimeInput>,
      })
      const runtime = runtimeById(id)
      await probeAndSave(runtime)
      notifyChanged()
      return runtimeById(id)
    },
    'runtimes.remove': (a) =>
      mutate(() => {
        store.dispatch({ type: 'runtime.remove', commandId: nextCommandId(), id: a[0] as string })
      }),
    // 只读探测：不 spawn、不写库
    'runtimes.detect': () => detectInstalledRuntimes(),
    // 真实探测：入账结论（探测不调用模型、不建 run）
    'runtimes.probe': async (a) => {
      const probe = await probeAndSave(runtimeById(a[0] as string))
      notifyChanged()
      return probe
    },
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
      const runtime = runtimeById(a[0] as string)
      return backendFor(runtime.protocolFamily).models(targetOf(runtime))
    },

    'agents.list': () => store.query('agents.all'),
    'agents.create': (a) =>
      mutate(() => {
        const facts = store.dispatch({
          type: 'agent.create',
          commandId: nextCommandId(),
          input: a[0] as AgentInput,
        }).facts
        return agentById(createdId(facts, 'agent.created'))
      }),
    'agents.update': (a) =>
      mutate(() => {
        const id = a[0] as string
        store.dispatch({
          type: 'agent.update',
          commandId: nextCommandId(),
          id,
          patch: a[1] as Partial<AgentInput>,
        })
        return agentById(id)
      }),
    'agents.remove': (a) =>
      mutate(() => {
        store.dispatch({ type: 'agent.remove', commandId: nextCommandId(), id: a[0] as string })
      }),

    'workflows.list': () => store.query('workflows.all'),
    'workflows.create': (a) =>
      mutate(() => {
        const facts = store.dispatch({
          type: 'workflow.create',
          commandId: nextCommandId(),
          input: a[0] as WorkflowInput,
        }).facts
        return workflowById(createdId(facts, 'workflow.created'))
      }),
    'workflows.update': (a) =>
      mutate(() => {
        const id = a[0] as string
        store.dispatch({
          type: 'workflow.update',
          commandId: nextCommandId(),
          id,
          input: a[1] as WorkflowInput,
        })
        return workflowById(id)
      }),
    'workflows.remove': (a) =>
      mutate(() => {
        store.dispatch({ type: 'workflow.remove', commandId: nextCommandId(), id: a[0] as string })
      }),

    'tasks.list': (a) => store.query('tasks.byWorkflow', { workflowId: a[0] as string }),
    // 提交成功后执行进入效果：agent 阶段入队一条 run
    'tasks.create': (a) =>
      mutate(() => {
        const facts = store.dispatch({
          type: 'task.create',
          commandId: nextCommandId(),
          input: a[0] as TaskInput,
        }).facts
        applyTaskEffects(effectsDeps(), facts)
        return taskById(createdId(facts, 'task.created'))
      }),
    // 看板拖拽：落点即目标阶段，进入效果照常执行
    'tasks.moveToStage': (a) =>
      mutate(() => {
        const id = a[0] as string
        const facts = store.dispatch({
          type: 'task.move',
          commandId: nextCommandId(),
          id,
          stageId: a[1] as string,
        }).facts
        applyTaskEffects(effectsDeps(), facts)
        return taskById(id)
      }),
    // 看板拖到「已完成」区
    'tasks.complete': (a) =>
      mutate(() => {
        const id = a[0] as string
        store.dispatch({ type: 'task.complete', commandId: nextCommandId(), id })
        return taskById(id)
      }),
    'tasks.remove': (a) =>
      mutate(() => {
        store.dispatch({ type: 'task.remove', commandId: nextCommandId(), id: a[0] as string })
      }),

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
