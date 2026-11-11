/**
 * 命令路由（M5 D3）：renderer 只能发命令，宿主在这里做「校验 → 幂等 → 编排 → 落事实」。
 *
 * 大部分命令直接 `effects.dispatch` 交给内核决策；只有两类需要宿主编排：
 * 1. 需要执行器探测的 `runtime.create / runtime.update / runtime.probe`（副作用先做，再落事实）；
 * 2. 删除前必须取消活跃 run 的 `task.remove / workflow.remove / chat.remove`（进程不成孤儿）。
 *
 * 幂等：`store.commandFacts` 命中即返回原结果（不重复探测、不重复产事实）。
 * 读只走 `query`：DB 视图交给 store，宿主视图（插件注册表/CLI 探测/执行器模型目录）由装配根注入。
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Store } from './store/index'
import type { DispatchResult } from './store/index'
import type { Fact } from '../kernel/types'
import type { Runtime } from '../protocol/entities'
import type { Card } from '../protocol/entities'
import type { TaskComment } from '../protocol/task-comment'
import type { Command } from '../protocol/commands'
import type { Capability, PluginManifest } from '../protocol/manifest'
import type { PluginSetting, PluginSettingsView, PluginView } from '../protocol/plugins'
import type { DispatchResult as IpcDispatchResult, FactSummary } from '../protocol/ipc'
import type { ExecutorPort } from '../protocol/executor'
import { HOST_VIEW_IDS, type HostViewId, type ViewId, type ViewParams } from '../protocol/views'
import { validateCommand, validateQuery } from '../protocol/validate'
import { mergePluginSetting, type PluginSettingSeed } from '../kernel/plugins'
import { StoreError } from './store/errors'
import { reviewDocFileName, reviewMarkdown } from '../kernel/review'
import { writeProjectDoc } from './artifacts'
import type { ReviewReport } from '../protocol/review'
import { isDeclaredAppEvent } from '../shared/apps'

/** 运行时配置的默认值（来自执行器插件 manifest；内核不写产品名）。 */
export interface ExecutorDefaults {
  executorKey: string
  command: string
  profile: string
}

/** 只读宿主视图：由装配根注入（插件注册表 / CLI 探测 / 执行器模型目录 / 磁盘插件目录）。 */
export type HostViewResolver = (
  view: HostViewId,
  params: Record<string, string> | undefined,
) => unknown

/**
 * 插件命令的宿主依赖（M7）：磁盘目录（kind / 声明的能力 / config 默认值）、
 * 当前视图行、secret 读写。内核不认识插件目录，因此这些判断只能由宿主做。
 */
export interface PluginCommandDeps {
  /** 按 id 取磁盘上的插件条目；不存在返回 null */
  entry(id: string): { manifest: PluginManifest; builtin: boolean } | null
  /** 按 id 取 `plugins.all` 的视图行（设置改完后回给 UI）；不存在返回 null */
  view(id: string): PluginView | null
  /** 写 secret：`null` 表示删除；失败抛错（不落日志） */
  writeSecrets(pluginId: string, secrets: Record<string, string | null>): void
}

export interface CommandRouterDeps {
  store: Store
  /** 唯一写入口（effects.dispatch）：提交事实并触发提交后分发 */
  dispatch: (input: unknown) => DispatchResult
  /** 执行器端口工厂（未知 executorKey 返回 null） */
  executors: { forRuntime(runtime: Runtime): ExecutorPort | null }
  /** 执行器默认值（key 缺省取注册表首项；未知 key 抛可读错误） */
  executorDefaults: (key: string | undefined) => ExecutorDefaults
  /** 宿主视图解析（只读，不写库、不发失效） */
  hostView: HostViewResolver
  /** 插件命令依赖（M7）；未注入时 `plugin.set` 返回 unsupported */
  plugins?: PluginCommandDeps
  /** 幂等键生成器（默认随机 UUID；测试可注入确定性值） */
  newCommandId?: () => string
}

export interface CommandRouter {
  /** 唯一写入口：校验命令 → 幂等 → 编排 → 提交；返回事实摘要 + 实体值。 */
  dispatch(command: unknown): Promise<IpcDispatchResult<unknown>>
  /** 唯一读入口：视图 id / 参数校验后读 DB 视图或宿主视图。 */
  query(view: unknown, params?: unknown): Promise<unknown>
}

const summarize = (facts: readonly Fact[]): FactSummary[] =>
  facts.map((fact) => ({ seq: fact.seq, type: fact.type, at: fact.at }))

const entityIdOf = (facts: readonly Fact[], type: Fact['type']): string | null => {
  for (const fact of facts) {
    if (fact.type !== type) continue
    const payload = fact.payload as Record<string, unknown>
    for (const value of Object.values(payload)) {
      if (typeof value === 'object' && value !== null && 'id' in value) {
        const id = (value as { id: unknown }).id
        return typeof id === 'string' ? id : null
      }
    }
  }
  return null
}

export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const { store } = deps
  const nextCommandId = deps.newCommandId ?? (() => randomUUID())

  const runtimePort = (runtime: Runtime): ExecutorPort => {
    const port = deps.executors.forRuntime(runtime)
    if (port === null) throw new StoreError('not_found', '执行器插件未注册: ' + runtime.executorKey)
    return port
  }

  /** 按 manifest 默认值补全运行时草稿（创建前探测用；不落库）。 */
  const draftRuntime = (
    input: { executorKey?: string; name: string; command?: string; profile?: string },
    defaults: ExecutorDefaults,
  ): Runtime => ({
    id: 'draft',
    name: input.name.trim(),
    executorKey: input.executorKey ?? defaults.executorKey,
    command: input.command?.trim() || defaults.command,
    profile: input.profile?.trim() || defaults.profile,
    argsTemplate: '',
    enabled: true,
    createdAt: '',
    lastProbe: null,
  })

  const probeRuntime = async (port: ExecutorPort, runtime: Runtime) => {
    if (port.probe === undefined) {
      throw new StoreError('unsupported', '执行器不支持探测: ' + runtime.executorKey)
    }
    return port.probe(runtime)
  }

  /** 探测并入账（`runtime.probed` 是独立命令；这里只负责写事实）。 */
  const saveProbe = (
    runtimeId: string,
    probe: Awaited<ReturnType<typeof probeRuntime>>,
  ): Fact[] => {
    const result = deps.dispatch({
      type: 'runtime.probed',
      commandId: nextCommandId(),
      id: runtimeId,
      probe,
    })
    return result.facts
  }

  const runtimeById = (id: string): Runtime | null =>
    store.query('runtimes.all').find((runtime) => runtime.id === id) ?? null
  const agentById = (id: string) =>
    store.query('agents.all').find((agent) => agent.id === id) ?? null
  const workflowById = (id: string) =>
    store.query('workflows.all').find((workflow) => workflow.id === id) ?? null
  const taskById = (id: string) => store.query('task.byId', { taskId: id })

  /** 删除/移除前先取消活跃 run（避免投影删掉 run 后进程成孤儿；M4 行为不变）。 */
  const cancelRuns = (runs: ReadonlyArray<{ id: string }>): void => {
    for (const run of runs) {
      try {
        deps.dispatch({ type: 'run.cancel', runId: run.id })
      } catch {
        // run 在查询与取消之间刚好结束：删除本身不因此失败（内核拒绝终态取消）
      }
    }
  }

  const preflight = (command: Command): void => {
    if (command.type === 'app.event' && !isDeclaredAppEvent(command.appId, command.eventType)) {
      throw new StoreError(
        'invalid_input',
        `未声明的事件类型: ${command.appId}/${command.eventType}`,
      )
    }
    if (command.type === 'task.remove') {
      cancelRuns(store.query('runs.active-by-task', { taskId: command.id }))
      return
    }
    if (command.type === 'workflow.remove') {
      for (const task of store.query('tasks.byWorkflow', { workflowId: command.id })) {
        cancelRuns(store.query('runs.active-by-task', { taskId: task.id }))
      }
      return
    }
    if (command.type === 'chat.remove') {
      cancelRuns(
        store.query('runs.active-by-conversation', { conversationId: command.conversationId }),
      )
    }
  }

  /** 命令对应的实体值（调用方通常用它选中新建/更新的行）。 */
  const valueOf = (command: Command, facts: readonly Fact[]): unknown => {
    switch (command.type) {
      case 'workflow.create':
      case 'workflow.update': {
        const id =
          command.type === 'workflow.update' ? command.id : entityIdOf(facts, 'workflow.created')
        return id === null ? null : workflowById(id)
      }
      case 'agent.create':
      case 'agent.update': {
        const id = command.type === 'agent.update' ? command.id : entityIdOf(facts, 'agent.created')
        return id === null ? null : agentById(id)
      }
      case 'runtime.create':
      case 'runtime.update': {
        const id =
          command.type === 'runtime.update' ? command.id : entityIdOf(facts, 'runtime.created')
        return id === null ? null : runtimeById(id)
      }
      case 'runtime.probe': {
        const fact = facts.find((item) => item.type === 'runtime.probed')
        return fact === undefined ? null : (fact.payload as { runtime: Runtime }).runtime.lastProbe
      }
      case 'project.create':
      case 'project.update': {
        // M10：返回整行（UI 用它选中新建 / 改过的项目）
        const id =
          command.type === 'project.update' ? command.id : entityIdOf(facts, 'project.created')
        return id === null
          ? null
          : (store.query('projects.all').find((item) => item.id === id) ?? null)
      }
      case 'task.create':
      case 'task.move':
      case 'task.complete': {
        const id = command.type === 'task.create' ? entityIdOf(facts, 'task.created') : command.id
        return id === null ? null : taskById(id)
      }
      case 'card.answer':
      case 'card.resolve': {
        const fact = facts.find(
          (item) =>
            item.type === (command.type === 'card.answer' ? 'card.answered' : 'card.resolved'),
        )
        return fact === undefined ? null : (fact.payload as { card: Card }).card
      }
      case 'chat.create': {
        const id = entityIdOf(facts, 'conversation.created')
        return id === null
          ? null
          : (store.query('conversations.all').find((item) => item.id === id) ?? null)
      }
      case 'rules.replace':
        // 整批保存后立刻返回新版本与规则清单（IPC 可直接刷新，不必再发一次 rules.all）
        return store.query('rules.all')
      case 'rule.trigger': {
        // 手动运行：内核产 `task.created`（origin='rule'），返回值与 task.create 同口径
        const id = entityIdOf(facts, 'task.created')
        return id === null ? null : taskById(id)
      }
      case 'task.comment': {
        // M7.5：返回追加的评论行（UI 仍以 `comments.byTask` 为准，这里只保证契约有值）
        const fact = facts.find((item) => item.type === 'task.comment_added')
        return fact === undefined ? null : (fact.payload as { comment: TaskComment }).comment
      }
      case 'plugins.replace':
        // 整批保存后立刻返回新快照（IPC 可直接刷新，不必再发一次 plugins.settings）
        return store.query('plugins.settings')
      case 'plugin.set':
        // 编排命令：返回值在 `setPlugin` 里按 views 现算
        return null
      default:
        return null
    }
  }

  const executePlain = (command: Command): Fact[] => {
    preflight(command)
    return deps.dispatch(command).facts
  }

  /** 编排：创建运行时（先探测通过才落库）。 */
  const createRuntime = async (
    command: Extract<Command, { type: 'runtime.create' }>,
  ): Promise<IpcDispatchResult<unknown>> => {
    const defaults = deps.executorDefaults(command.input.executorKey)
    const draft = draftRuntime(command.input, defaults)
    const port = runtimePort(draft)
    const probe = await probeRuntime(port, draft)
    if (probe.state !== 'ready') {
      throw new StoreError('conflict', `探测失败：${probe.error ?? '未知错误'}`)
    }
    const created = deps.dispatch({
      type: 'runtime.create',
      commandId: command.commandId,
      input: {
        ...command.input,
        executorKey: draft.executorKey,
        command: draft.command,
        profile: draft.profile,
        argsTemplate: draft.argsTemplate,
      },
    })
    const runtimeId = entityIdOf(created.facts, 'runtime.created')
    if (runtimeId === null) throw new StoreError('unsupported', '缺少事实: runtime.created')
    const probed = saveProbe(runtimeId, probe)
    const facts = [...created.facts, ...probed]
    store.rememberCommand(command.commandId, facts)
    return { facts: summarize(facts), value: runtimeById(runtimeId) }
  }

  /** 编排：更新运行时（保存后重探，探测结论入账）。 */
  const updateRuntime = async (
    command: Extract<Command, { type: 'runtime.update' }>,
  ): Promise<IpcDispatchResult<unknown>> => {
    const updated = deps.dispatch({
      type: 'runtime.update',
      commandId: command.commandId,
      id: command.id,
      patch: command.patch,
    })
    const runtime = runtimeById(command.id)
    if (runtime === null) throw new StoreError('not_found', '运行时不存在: ' + command.id)
    const probe = await probeRuntime(runtimePort(runtime), runtime)
    const probed = saveProbe(runtime.id, probe)
    const facts = [...updated.facts, ...probed]
    store.rememberCommand(command.commandId, facts)
    return { facts: summarize(facts), value: runtimeById(command.id) }
  }

  /** 编排：只探测（「测试」按钮），探测结论单独入账。 */
  const probeOnly = async (
    command: Extract<Command, { type: 'runtime.probe' }>,
  ): Promise<IpcDispatchResult<unknown>> => {
    const runtime = runtimeById(command.id)
    if (runtime === null) throw new StoreError('not_found', '运行时不存在: ' + command.id)
    const probe = await probeRuntime(runtimePort(runtime), runtime)
    const facts = saveProbe(runtime.id, probe)
    store.rememberCommand(command.commandId, facts)
    return { facts: summarize(facts), value: probe }
  }

  /**
   * 编排：把评审报告提升为项目文档（M14）。
   *
   * 内核只做归属校验（零事实），这里做真正的事：定位报告 → 读任务与项目 → 生成 markdown →
   * 写到 `<项目>/docs/reviews/<文件名>`。写盘失败直接抛（用户显式点的动作，不能悄悄失败）。
   */
  const exportReview = (
    command: Extract<Command, { type: 'review.export' }>,
  ): IpcDispatchResult<unknown> => {
    const facts = deps.dispatch(command).facts
    const reports: ReviewReport[] = store.query('reviews.byTask', { taskId: command.taskId })
    const report =
      command.reportId === undefined
        ? reports[reports.length - 1]
        : reports.find((item) => item.id === command.reportId)
    if (report === undefined) {
      throw new StoreError('not_found', '报告不存在: ' + (command.reportId ?? '（最新）'))
    }
    const task = taskById(command.taskId)
    if (task === null) throw new StoreError('not_found', '任务不存在: ' + command.taskId)
    const project =
      task.projectId === null
        ? null
        : (store.query('projects.all').find((item) => item.id === task.projectId) ?? null)
    if (project === null) throw new StoreError('conflict', '任务未归属项目，无法落到 docs/reviews')
    const target = writeProjectDoc(
      path.join(project.path, 'docs', 'reviews'),
      reviewDocFileName(task.title, task.id, report.rev),
      reviewMarkdown(task.title, report),
    )
    return { facts: summarize(facts), value: { path: target } }
  }
  /** manifest 的非 secret 默认值（新插件还没有设置行时用它当 seed）。 */
  const defaultPluginConfig = (manifest: PluginManifest): PluginSetting['config'] => {
    const config: PluginSetting['config'] = {}
    for (const field of manifest.config ?? []) {
      if (field.type === 'secret') continue
      if (field.default !== undefined) config[field.key] = field.default
    }
    return config
  }

  /**
   * 编排：改一条插件设置（M7）。
   *
   * 步骤：磁盘条目 → 当前快照 → seed（新插件按 manifest 默认值）→ 合并 patch →
   * 宿主侧语义校验（授权 ⊆ 声明能力、secret 键 ⊆ 声明的 secret 字段）→
   * `plugins.replace` 整批落事实 → 写非投影 secret 表 → 返回该插件视图行。
   */
  const setPlugin = (
    command: Extract<Command, { type: 'plugin.set' }>,
  ): IpcDispatchResult<unknown> => {
    const pluginDeps = deps.plugins
    if (pluginDeps === undefined) throw new StoreError('unsupported', '插件设置未装配')
    const entry = pluginDeps.entry(command.pluginId)
    if (entry === null) throw new StoreError('not_found', '插件不存在: ' + command.pluginId)
    const current: PluginSettingsView = store.query('plugins.settings')
    const existing = current.settings.find((setting) => setting.id === command.pluginId)
    const seed: PluginSettingSeed = existing ?? {
      id: command.pluginId,
      kind: entry.manifest.kind,
      enabled: entry.builtin,
      granted: entry.builtin ? [...entry.manifest.capabilities] : [],
      config: defaultPluginConfig(entry.manifest),
    }
    const merged = mergePluginSetting(seed, command)
    const declared = entry.manifest.capabilities
    const undeclared = merged.granted.find(
      (capability: Capability) => !declared.includes(capability),
    )
    if (undeclared !== undefined) {
      throw new StoreError('invalid_input', '插件未声明该能力: ' + undeclared)
    }
    if (command.secrets !== undefined) {
      const allowed = new Set(
        (entry.manifest.config ?? [])
          .filter((field) => field.type === 'secret')
          .map((field) => field.key),
      )
      const unknown = Object.keys(command.secrets).find((key) => !allowed.has(key))
      if (unknown !== undefined) {
        throw new StoreError('invalid_input', '插件未声明该 secret 字段: ' + unknown)
      }
    }
    const settings = [...current.settings.filter((setting) => setting.id !== merged.id), merged]
    deps.dispatch({ type: 'plugins.replace', commandId: command.commandId, settings })
    if (command.secrets !== undefined) pluginDeps.writeSecrets(command.pluginId, command.secrets)
    return {
      facts: summarize(store.commandFacts(command.commandId) ?? []),
      value: pluginDeps.view(command.pluginId),
    }
  }

  return {
    dispatch: async (command) => {
      const validated = validateCommand(command)
      if (!validated.ok) throw new StoreError('invalid_input', validated.message)
      const parsed = validated.command

      // 幂等：同一 commandId 的重复提交返回原事实，不再探测、不再决策
      const replay = store.commandFacts(parsed.commandId)
      if (replay !== null) {
        return { facts: summarize(replay), value: valueOf(parsed, replay) }
      }

      if (parsed.type === 'runtime.create') return createRuntime(parsed)
      if (parsed.type === 'runtime.update') return updateRuntime(parsed)
      if (parsed.type === 'runtime.probe') return probeOnly(parsed)
      if (parsed.type === 'plugin.set') return setPlugin(parsed)
      if (parsed.type === 'review.export') return exportReview(parsed)

      const facts = executePlain(parsed)
      return { facts: summarize(facts), value: valueOf(parsed, facts) }
    },
    query: async (view, params) => {
      const validated = validateQuery(view, params)
      if (!validated.ok) throw new StoreError('invalid_input', validated.message)
      if ((HOST_VIEW_IDS as readonly string[]).includes(validated.view)) {
        return deps.hostView(validated.view as HostViewId, validated.params)
      }
      return store.query(validated.view as ViewId, validated.params as ViewParams<ViewId>)
    },
  }
}
