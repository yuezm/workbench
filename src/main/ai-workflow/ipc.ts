import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { Agent, Runtime, Task, WorkflowWithStages } from '../../protocol/entities'
import type {
  AgentInput,
  ChatConversation,
  DetectedRuntime,
  RuntimeExecutorChoice,
  RuntimeInput,
  RuntimeProbe,
  RuntimeStatus,
  TaskInput,
  WorkflowInput,
} from '../../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'
import type { Fact } from '../../kernel/types'
import type { FactType } from '../../protocol/facts'
import type { ExecutorPort } from '../../protocol/executor'
import type { Store } from '../../host/store/index'

/** 纯分发器：方法名 + 参数 → 结果；不含 electron 依赖，便于单测。 */
export type AiWorkflowHandler = (method: string, args: unknown[]) => unknown

/** 运行时配置的默认值（来自执行器插件 manifest；内核不写产品名） */
export interface ExecutorDefaults {
  executorKey: string
  command: string
  profile: string
}

export interface AiWorkflowIpcDeps {
  /** 唯一读入口：配置/任务/运行/聊天都读投影视图 */
  store: Store
  /**
   * 唯一写入口（装配根传 `effects.dispatch`）：提交事实并触发提交后分发。
   * 任务进入阶段的 `run.queued` 由内核产出，这里不再补写任何执行记录。
   */
  dispatch: Store['dispatch']
  /** 执行器端口工厂（装配根注入；未知 executorKey 返回 null） */
  executors: { forRuntime(runtime: Runtime): ExecutorPort | null }
  /** 执行器默认值（key 缺省取注册表首项；未知 key 抛可读错误） */
  executorDefaults: (key: string | undefined) => ExecutorDefaults
  /** 本机 CLI 探测（装配根传 `registry.detectAll`；测试注入固定清单） */
  detect: () => Promise<DetectedRuntime[]>
  /** 可选执行器清单（装配根传 registry 派生的只读清单） */
  executorChoices: () => readonly RuntimeExecutorChoice[]
  /** 命令幂等键生成器（默认随机 UUID；测试可注入确定性值） */
  newCommandId?: () => string
}

/**
 * 从刚提交的事实里取新实体 id（create 类命令用）。
 * 读投影也能拿到，但用事实更直接：同一事务里刚写的行就是它，不存在并发歧义。
 */
export function createdId(facts: readonly Fact[], type: FactType): string {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error('缺少事实: ' + type)
  switch (fact.type) {
    case 'runtime.created':
      return (fact.payload as { runtime: Runtime }).runtime.id
    case 'agent.created':
      return (fact.payload as { agent: Agent }).agent.id
    case 'workflow.created':
      return (fact.payload as { workflow: WorkflowWithStages }).workflow.id
    case 'task.created':
      return (fact.payload as { task: Task }).task.id
    default:
      throw new Error('事实不携带实体 id: ' + fact.type)
  }
}

/** 按 id 从投影视图取实体；取不到就抛可读错误（IPC 错误文案原样露给 UI）。 */
export function runtimeById(store: Store, id: string): Runtime {
  const runtime = store.query('runtimes.all').find((item) => item.id === id)
  if (!runtime) throw new Error('运行时不存在: ' + id)
  return runtime
}

export function agentById(store: Store, id: string): Agent {
  const agent = store.query('agents.all').find((item) => item.id === id)
  if (!agent) throw new Error('智能体不存在: ' + id)
  return agent
}

export function workflowById(store: Store, id: string): WorkflowWithStages {
  const workflow = store.query('workflows.all').find((item) => item.id === id)
  if (!workflow) throw new Error('工作流不存在: ' + id)
  return workflow
}

export function taskById(store: Store, id: string): Task {
  const task = store.query('task.byId', { taskId: id })
  if (!task) throw new Error('任务不存在: ' + id)
  return task
}

export function createAiWorkflowHandler(deps: AiWorkflowIpcDeps): AiWorkflowHandler {
  const { store, dispatch } = deps
  const nextCommandId = deps.newCommandId ?? (() => randomUUID())

  /** 运行时对应的执行器端口；配置引用了未注册的 key 时给可读错误（不静默降级）。 */
  const runtimePort = (runtime: Runtime): ExecutorPort => {
    const port = deps.executors.forRuntime(runtime)
    if (port === null) throw new Error('执行器插件未注册: ' + runtime.executorKey)
    return port
  }

  /** 按 manifest 默认值补全运行时草稿（创建前探测用；不落库）。 */
  const draftRuntime = (input: RuntimeInput, defaults: ExecutorDefaults): Runtime => ({
    id: 'draft',
    name: input.name.trim(),
    executorKey: input.executorKey ?? defaults.executorKey,
    command: input.command?.trim() || defaults.command,
    profile: input.profile?.trim() || defaults.profile,
    argsTemplate: input.argsTemplate ?? '',
    permissionMode: input.permissionMode ?? 'workspace-write',
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    workdir: input.workdir ?? null,
    maxConcurrent: input.maxConcurrent ?? 1,
    enabled: input.enabled !== false,
    createdAt: '',
    lastProbe: null,
  })

  /**
   * 取消一批执行中的 run（T15/T14b）：`run.cancel` 由内核记 `cancel_requested`，
   * 宿主按「abort → 宽限 → 强杀 → 兜底终态」收尾。删除/取消入口都先走它，
   * 避免投影删掉 run 后执行器进程成为孤儿。
   */
  const cancelActiveRuns = (runs: ReadonlyArray<{ id: string }>): void => {
    for (const run of runs) {
      try {
        dispatch({ type: 'run.cancel', runId: run.id })
      } catch {
        // run 在查询与取消之间刚好结束：删除/取消本身不因此失败（内核拒绝已终态的取消）
      }
    }
  }

  /** 任务（可多个）上的活跃 run：删除任务/工作流前调用 */
  const cancelRunsOf = (taskIds: readonly string[]): void => {
    for (const taskId of taskIds) {
      cancelActiveRuns(store.query('runs.active-by-task', { taskId }))
    }
  }

  /** 对话上的活跃聊天 run：删除对话 / 中止本轮前调用 */
  const cancelChatRunsOf = (conversationId: string): void => {
    cancelActiveRuns(store.query('runs.active-by-conversation', { conversationId }))
  }

  /** 探测并把结论入账（探测错误不抛：落库成 unavailable 行） */
  const probeAndSave = async (runtime: Runtime): Promise<RuntimeProbe> => {
    const port = runtimePort(runtime)
    if (port.probe === undefined) {
      throw new Error('执行器不支持探测: ' + runtime.executorKey)
    }
    const probe = await port.probe(runtime)
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
    // 创建前先探测：命令/profile 不通就不落库，避免留下不可用的记录。
    // 执行器键与默认命令/profile 来自执行器插件 manifest（M3）。
    'runtimes.create': async (a) => {
      const input = a[0] as RuntimeInput
      const defaults = deps.executorDefaults(input.executorKey)
      const draft = draftRuntime(input, defaults)
      const port = runtimePort(draft)
      if (port.probe === undefined) {
        throw new Error('执行器不支持探测: ' + draft.executorKey)
      }
      const probe = await port.probe(draft)
      if (probe.state !== 'ready') {
        throw new Error(`探测失败：${probe.error ?? '未知错误'}`)
      }
      const form: RuntimeInput = {
        ...input,
        executorKey: draft.executorKey,
        command: draft.command,
        profile: draft.profile,
        argsTemplate: draft.argsTemplate,
      }
      const facts = dispatch({
        type: 'runtime.create',
        commandId: nextCommandId(),
        input: form,
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
    // 只读探测：不 spawn、不写库；候选清单来自各执行器插件 detect() 的汇总（M3 T9）
    'runtimes.detect': () => deps.detect(),
    // 只读执行器清单：运行时表单的下拉选项来自插件注册表（D11）
    'runtimes.executors': () => deps.executorChoices(),
    // 真实探测：入账结论（探测不调用模型、不建 run）
    'runtimes.probe': async (a) => probeAndSave(runtimeById(store, a[0] as string)),
    // 实时负载：在跑/排队数按运行时现算
    'runtimes.statuses': () => {
      const workloads = new Map(
        store.query('runtimes.workloads').map((item) => [item.runtimeId, item]),
      )
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
      const port = runtimePort(runtime)
      return port.models === undefined ? Promise.resolve([]) : port.models(runtime)
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
      const id = a[0] as string
      // 先取消该工作流下所有执行中的 run，再删（删除会让它们在投影里直接消失）
      cancelRunsOf(store.query('tasks.byWorkflow', { workflowId: id }).map((task) => task.id))
      dispatch({ type: 'workflow.remove', commandId: nextCommandId(), id })
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
      const id = a[0] as string
      // 先取消任务上执行中的 run，再删（避免删除后进程成孤儿、看板残留「执行中」）
      cancelRunsOf([id])
      dispatch({ type: 'task.remove', commandId: nextCommandId(), id })
    },

    // 运行历史读投影：任务下的阶段 run 与事件流（聊天 run 不挂任务，不进 runs.byTask）
    'runs.listByTask': (a) => store.query('runs.byTask', { taskId: a[0] as string }),
    'runs.events': (a) => store.query('run.events', { runId: a[0] as string }),

    // 聊天全部走事实：读走投影视图，写走 dispatch（effects 统一通知 UI）
    'chat.listConversations': () => store.query('conversations.all'),
    'chat.createConversation': (a) => {
      const facts = dispatch({ type: 'conversation.create', agentId: a[0] as string }).facts
      const fact = facts.find((item) => item.type === 'conversation.created')
      if (!fact) throw new Error('缺少事实: conversation.created')
      return (fact.payload as { conversation: ChatConversation }).conversation
    },
    // 删除前先取消该对话进行中的一轮，再删对话（消息由 project 级联删除）
    'chat.removeConversation': (a) => {
      const conversationId = a[0] as string
      cancelChatRunsOf(conversationId)
      dispatch({ type: 'conversation.remove', conversationId })
    },
    'chat.listMessages': (a) =>
      store.query('messages.byConversation', { conversationId: a[0] as string }),
    // 发起一轮：内核校验内容/并发/运行时，reject（含 code）原样抛给 renderer；
    // 输出经 scheduler 的 AI_WORKFLOW_CHAT 旁路推送（事实仍是数据源）
    'chat.send': (a) => {
      dispatch({
        type: 'conversation.send',
        conversationId: a[0] as string,
        content: a[1] as string,
      })
    },
    // 中止该对话进行中的一轮：查活跃聊天 run 后逐条取消（无活跃 run 时无害）
    'chat.cancel': (a) => {
      cancelChatRunsOf(a[0] as string)
    },
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
