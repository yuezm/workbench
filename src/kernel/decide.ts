/**
 * 唯一决策入口：命令 + 视图切片 → 事实草稿（或 `reject`）。
 *
 * 纯函数：不读时钟/随机数/文件/DB——`now`、id 生成器、视图切片都由宿主在边界注入。
 * 非法输入一律返回 `reject { code, message }`，不抛异常；文案沿用旧 `repository` /
 * `engine` 的措辞（「运行时不存在: id」「执行中的阶段不能拖动」等），便于 IPC 与 UI
 * 在迁移期零改动。
 *
 * 阶段规则只复用 `kernel/workflow/{stage-machine,stage-validation}.ts`：拖拽落点即目标、
 * 打回原地零效果等判定不在这里另写一份。进入阶段的效果（建 run / 等人）由宿主在
 * 提交成功后按新视图执行，`decide` 只产事实。
 *
 * M2 起入参放宽为 `protocol/inputs` 的 `Input`（命令 + 宿主内部输入）。T5 只实现
 * `run.claim` / `run.heartbeat`，其余宿主输入暂以 `reject('unsupported')` 兜底，
 * 由 T6/T7/T14 逐个补齐；14 条命令的行为与文案不变。
 */
import type {
  Agent,
  Runtime,
  StageInput,
  Task,
  Workflow,
  WorkflowStage,
  WorkflowWithStages,
} from '../protocol/entities'
import type { FactPayload, FactType } from '../protocol/facts'
import type { Input } from '../protocol/inputs'
import type { Actor, Decision, Environment, FactDraft, Id, Iso, Reason, View } from './types'
import { claimFacts, heartbeatFacts, pickClaims } from './run'
import { completeTask, moveTaskToStage } from './workflow/stage-machine'
import { validateStageSet } from './workflow/stage-validation'

/**
 * 协议族 / 权限模式白名单：`src/protocol/entities.ts` 里的常量是唯一真相源，
 * 内核只允许依赖协议层的类型（不引运行期值），所以这里按同一份取值做运行期校验。
 */
const PROTOCOL_FAMILIES: readonly Runtime['protocolFamily'][] = ['dsh']
const PERMISSION_MODES: readonly Runtime['permissionMode'][] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/** 并发上限：至少 1，最多 8（本地单机没必要更多） */
const CONCURRENCY_FLOOR = 1
const CONCURRENCY_CAP = 8

/** M1 的命令全部来自 owner（renderer 经宿主派发），事实的 actor 不带来源推导。 */
const OWNER: Actor = { kind: 'owner', via: 'ui' }

/** 宿主调度器发起的领取 / 续租：actor 标明来源，便于 why 链区分。 */
const HOST_SCHEDULER: Actor = { kind: 'host', via: 'scheduler' }

const done = (facts: FactDraft[]): Decision => ({ facts })

const reject = (code: Reason, message: string): Decision => ({
  facts: [],
  reject: { code, message },
})

/** 工作流下的阶段，按 position 升序（投影表里 position 唯一）。 */
function stagesOf(view: View, workflowId: Id): WorkflowStage[] {
  const stages: WorkflowStage[] = []
  for (const stage of view.stages.values()) {
    if (stage.workflowId === workflowId) stages.push(stage)
  }
  return stages.sort((a, b) => a.position - b.position)
}

function workflowWithStages(view: View, workflow: Workflow): WorkflowWithStages {
  return { ...workflow, stages: stagesOf(view, workflow.id) }
}

/** 任务按创建时间排序（同毫秒用 id 兜底），保证同一视图产出的顺序稳定。 */
function tasksOf(view: View, workflowId: Id): Task[] {
  const tasks: Task[] = []
  for (const task of view.tasks.values()) {
    if (task.workflowId === workflowId) tasks.push(task)
  }
  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

function stageRow(workflowId: Id, ids: Id[], stage: StageInput, position: number): WorkflowStage {
  return {
    id: ids[position],
    workflowId,
    name: stage.name.trim(),
    position,
    entryMode: stage.entryMode,
    agentId: stage.agentId ?? null,
    onCompleteStageId: indexTarget(ids, stage.onCompleteIndex),
    onRejectStageId: indexTarget(ids, stage.onRejectIndex),
  }
}

/** 下标 → 阶段 id；`validateStageSet` 已保证下标在范围内。 */
function indexTarget(ids: Id[], index: number | null | undefined): Id | null {
  if (index === null || index === undefined) return null
  return ids[index] ?? null
}

function sameStage(a: WorkflowStage, b: WorkflowStage): boolean {
  return (
    a.id === b.id &&
    a.workflowId === b.workflowId &&
    a.name === b.name &&
    a.position === b.position &&
    a.entryMode === b.entryMode &&
    a.agentId === b.agentId &&
    a.onCompleteStageId === b.onCompleteStageId &&
    a.onRejectStageId === b.onRejectStageId
  )
}

/** 阶段绑定的智能体是否都能在视图里找到（旧实现靠外键，M1 由内核前置校验）。 */
function missingAgentId(view: View, stages: StageInput[]): Id | null {
  for (const stage of stages) {
    if (stage.agentId && !view.agents.has(stage.agentId)) return stage.agentId
  }
  return null
}

function runtimeNamed(view: View, name: string, exceptId: Id): Runtime | undefined {
  for (const runtime of view.runtimes.values()) {
    if (runtime.name === name && runtime.id !== exceptId) return runtime
  }
  return undefined
}

function agentUsingRuntime(view: View, runtimeId: Id): Agent | undefined {
  for (const agent of view.agents.values()) {
    if (agent.runtimeId === runtimeId) return agent
  }
  return undefined
}

function stageUsingAgent(view: View, agentId: Id): WorkflowStage | undefined {
  for (const stage of view.stages.values()) {
    if (stage.agentId === agentId) return stage
  }
  return undefined
}

function protocolFamilyOf(value: string): Runtime['protocolFamily'] | null {
  return (PROTOCOL_FAMILIES as readonly string[]).includes(value)
    ? (value as Runtime['protocolFamily'])
    : null
}

function permissionModeOf(value: string): Runtime['permissionMode'] | null {
  return (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as Runtime['permissionMode'])
    : null
}

/** 并发上限归一：未给沿用 fallback；非正整数返回 null（交给调用方拒绝）；超过 8 按 8。 */
function normalizeConcurrency(value: number | undefined, fallback: number): number | null {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < CONCURRENCY_FLOOR) return null
  return Math.min(value, CONCURRENCY_CAP)
}

/** 命中该工作流的活跃 run（「执行中」只认 queued/running）。 */
function hasActiveRun(view: View, workflowId: Id): boolean {
  for (const task of view.tasks.values()) {
    if (task.workflowId === workflowId && view.activeTaskIds.has(task.id)) return true
  }
  return false
}

export function decide(view: View, input: Input, now: Iso, env: Environment): Decision {
  const draft = <T extends FactType>(type: T, payload: FactPayload<T>): FactDraft<T> => ({
    type,
    actor: OWNER,
    at: now,
    payload,
  })

  switch (input.type) {
    // ---------- 运行时 ----------
    case 'runtime.create': {
      const form = input.input
      const name = form.name?.trim()
      if (!name) return reject('invalid_input', '运行时名称必填')
      const protocolFamily = protocolFamilyOf(form.protocolFamily ?? 'dsh')
      if (!protocolFamily) {
        return reject('invalid_input', '不支持的协议族: ' + String(form.protocolFamily))
      }
      const permissionMode = permissionModeOf(form.permissionMode ?? 'workspace-write')
      if (!permissionMode) {
        return reject('invalid_input', '不支持的权限模式: ' + String(form.permissionMode))
      }
      const maxConcurrent = normalizeConcurrency(form.maxConcurrent, 1)
      if (maxConcurrent === null) return reject('invalid_input', '并发上限必须是正整数')
      if (runtimeNamed(view, name, '')) return reject('conflict', '运行时名称已存在: ' + name)
      const runtime: Runtime = {
        id: env.nextId('runtime'),
        name,
        protocolFamily,
        command: form.command?.trim() || 'dsh',
        profile: form.profile?.trim() || 'multica',
        permissionMode,
        model: form.model ?? null,
        reasoningEffort: form.reasoningEffort ?? null,
        workdir: form.workdir ?? null,
        maxConcurrent,
        enabled: form.enabled !== false,
        createdAt: now,
        lastProbe: null,
      }
      return done([draft('runtime.created', { runtime })])
    }

    case 'runtime.update': {
      const current = view.runtimes.get(input.id)
      if (!current) return reject('not_found', '运行时不存在: ' + input.id)
      const patch = input.patch
      const protocolFamily =
        patch.protocolFamily === undefined
          ? current.protocolFamily
          : protocolFamilyOf(patch.protocolFamily)
      if (!protocolFamily) {
        return reject('invalid_input', '不支持的协议族: ' + String(patch.protocolFamily))
      }
      const permissionMode =
        patch.permissionMode === undefined
          ? current.permissionMode
          : permissionModeOf(patch.permissionMode)
      if (!permissionMode) {
        return reject('invalid_input', '不支持的权限模式: ' + String(patch.permissionMode))
      }
      const maxConcurrent = normalizeConcurrency(patch.maxConcurrent, current.maxConcurrent)
      if (maxConcurrent === null) return reject('invalid_input', '并发上限必须是正整数')
      const name = patch.name?.trim() || current.name
      if (name !== current.name && runtimeNamed(view, name, current.id)) {
        return reject('conflict', '运行时名称已存在: ' + name)
      }
      const runtime: Runtime = {
        ...current,
        name,
        protocolFamily,
        permissionMode,
        command: patch.command?.trim() || current.command,
        profile: patch.profile?.trim() || current.profile,
        model: patch.model !== undefined ? patch.model : current.model,
        reasoningEffort:
          patch.reasoningEffort !== undefined ? patch.reasoningEffort : current.reasoningEffort,
        workdir: patch.workdir !== undefined ? patch.workdir : current.workdir,
        maxConcurrent,
        enabled: patch.enabled !== undefined ? patch.enabled === true : current.enabled,
      }
      return done([draft('runtime.updated', { runtime })])
    }

    case 'runtime.probed': {
      const current = view.runtimes.get(input.id)
      if (!current) return reject('not_found', '运行时不存在: ' + input.id)
      const runtime: Runtime = { ...current, lastProbe: input.probe }
      return done([draft('runtime.probed', { runtime })])
    }

    case 'runtime.remove': {
      const current = view.runtimes.get(input.id)
      // 旧实现 DELETE 0 行同样静默成功；删除不存在的实体不算非法输入
      if (!current) return done([])
      if (agentUsingRuntime(view, current.id)) {
        return reject('conflict', '运行时被智能体引用，无法删除: ' + current.id)
      }
      return done([draft('runtime.removed', { runtime: current })])
    }

    // ---------- 智能体 ----------
    case 'agent.create': {
      const form = input.input
      const name = form.name?.trim()
      if (!name) return reject('invalid_input', '智能体名称必填')
      if (!view.runtimes.has(form.runtimeId)) {
        return reject('not_found', '运行时不存在: ' + form.runtimeId)
      }
      const agent: Agent = {
        id: env.nextId('agent'),
        name,
        description: form.description ?? '',
        runtimeId: form.runtimeId,
        systemPrompt: form.systemPrompt ?? '',
        createdAt: now,
      }
      return done([draft('agent.created', { agent })])
    }

    case 'agent.update': {
      const current = view.agents.get(input.id)
      if (!current) return reject('not_found', '智能体不存在: ' + input.id)
      const patch = input.patch
      const runtimeId = patch.runtimeId ? patch.runtimeId : current.runtimeId
      if (patch.runtimeId && !view.runtimes.has(patch.runtimeId)) {
        return reject('not_found', '运行时不存在: ' + patch.runtimeId)
      }
      const agent: Agent = {
        ...current,
        name: patch.name?.trim() ?? current.name,
        description: patch.description ?? current.description,
        runtimeId,
        systemPrompt: patch.systemPrompt ?? current.systemPrompt,
      }
      return done([draft('agent.updated', { agent })])
    }

    case 'agent.remove': {
      const current = view.agents.get(input.id)
      if (!current) return done([])
      if (stageUsingAgent(view, current.id)) {
        return reject('conflict', '智能体被工作流阶段或对话引用，无法删除: ' + current.id)
      }
      return done([draft('agent.removed', { agent: current })])
    }

    // ---------- 工作流 ----------
    case 'workflow.create': {
      const form = input.input
      const name = form.name?.trim()
      if (!name) return reject('invalid_input', '工作流名称必填')
      const invalid = validateStageSet(form.stages)
      if (invalid) return reject('invalid_input', invalid)
      const missingAgent = missingAgentId(view, form.stages)
      if (missingAgent) return reject('not_found', '智能体不存在: ' + missingAgent)
      const workflowId = env.nextId('workflow')
      const stageIds = form.stages.map(() => env.nextId('stage'))
      const workflow: Workflow = {
        id: workflowId,
        name,
        description: form.description ?? '',
        createdAt: now,
      }
      const facts: FactDraft[] = [draft('workflow.created', { workflow })]
      form.stages.forEach((stage, position) => {
        facts.push(
          draft('stage.created', { stage: stageRow(workflowId, stageIds, stage, position) }),
        )
      })
      return done(facts)
    }

    case 'workflow.update': {
      const form = input.input
      const name = form.name?.trim()
      if (!name) return reject('invalid_input', '工作流名称必填')
      const invalid = validateStageSet(form.stages)
      if (invalid) return reject('invalid_input', invalid)
      const current = view.workflows.get(input.id)
      if (!current) return reject('not_found', '工作流不存在: ' + input.id)
      if (hasActiveRun(view, current.id)) {
        return reject('conflict', '工作流有执行中的任务，无法修改阶段: ' + current.id)
      }
      const missingAgent = missingAgentId(view, form.stages)
      if (missingAgent) return reject('not_found', '智能体不存在: ' + missingAgent)

      // 阶段 id 差量：回传的 id 保留，缺省 id 拿新 id，未出现在提交集合里的旧阶段 tombstone。
      const existing = stagesOf(view, current.id)
      const existingById = new Map(existing.map((stage) => [stage.id, stage]))
      const refs: Array<Id | null> = []
      const claimed = new Set<Id>()
      for (const stage of form.stages) {
        const ref = stage.id?.trim() || null
        if (ref !== null) {
          if (claimed.has(ref)) return reject('conflict', '阶段 id 重复: ' + ref)
          if (!existingById.has(ref)) return reject('conflict', '阶段 id 不存在: ' + ref)
          claimed.add(ref)
        }
        refs.push(ref)
      }
      const ids = refs.map((ref) => ref ?? env.nextId('stage'))
      const rows = form.stages.map((stage, position) => stageRow(current.id, ids, stage, position))
      const nextIds = new Set(ids)
      const removed = existing.filter((stage) => !nextIds.has(stage.id))

      const workflow: Workflow = {
        id: current.id,
        name,
        description: form.description ?? '',
        createdAt: current.createdAt,
      }
      const facts: FactDraft[] = [draft('workflow.updated', { workflow })]
      // 先删旧阶段腾出 position：`workflow_stages` 有 UNIQUE(workflow_id, position)
      for (const stage of removed) facts.push(draft('stage.deleted', { stage }))
      for (const row of rows) {
        const previous = existingById.get(row.id)
        if (previous && !sameStage(previous, row)) {
          facts.push(draft('stage.updated', { stage: row }))
        }
      }
      for (const row of rows) {
        if (!existingById.has(row.id)) facts.push(draft('stage.created', { stage: row }))
      }
      // 被删阶段上的任务按旧 position 重挂到新阶段集合（与旧 repository 的语义一致）
      const removedById = new Map(removed.map((stage) => [stage.id, stage]))
      for (const task of tasksOf(view, current.id)) {
        const stageId = task.currentStageId
        if (stageId === null) continue
        const previous = removedById.get(stageId)
        if (!previous) continue
        const target = rows.at(Math.min(previous.position, rows.length - 1))
        facts.push(
          draft('task.moved', {
            task: { ...task, currentStageId: target?.id ?? null },
            from: stageId,
            to: target?.id ?? null,
          }),
        )
      }
      return done(facts)
    }

    case 'workflow.remove': {
      const current = view.workflows.get(input.id)
      if (!current) return done([])
      const facts: FactDraft[] = [draft('workflow.removed', { workflow: current })]
      // 不依赖 SQL 级联：重建时会临时关外键，级联删除必须由事实显式表达
      for (const stage of stagesOf(view, current.id)) {
        facts.push(draft('stage.deleted', { stage }))
      }
      for (const task of tasksOf(view, current.id)) {
        facts.push(draft('task.removed', { task }))
      }
      return done(facts)
    }

    // ---------- 任务 ----------
    case 'task.create': {
      const form = input.input
      const title = form.title?.trim()
      if (!title) return reject('invalid_input', '任务标题必填')
      const workflow = view.workflows.get(form.workflowId)
      if (!workflow) return reject('not_found', '工作流不存在: ' + form.workflowId)
      const stages = stagesOf(view, workflow.id)
      const requested = form.stageId || null
      if (requested !== null && !stages.some((stage) => stage.id === requested)) {
        return reject('not_found', '起始阶段不属于该工作流: ' + requested)
      }
      const task: Task = {
        id: env.nextId('task'),
        title,
        description: form.description ?? '',
        workflowId: workflow.id,
        currentStageId: requested ?? stages[0]?.id ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      return done([draft('task.created', { task })])
    }

    case 'task.move': {
      const task = view.tasks.get(input.id)
      if (!task) return reject('not_found', '任务不存在: ' + input.id)
      const workflow = view.workflows.get(task.workflowId)
      if (!workflow) return reject('not_found', '工作流不存在: ' + task.workflowId)
      const flow = workflowWithStages(view, workflow)
      if (!flow.stages.some((stage) => stage.id === task.currentStageId)) {
        return reject('conflict', '任务当前阶段无效')
      }
      if (view.activeTaskIds.has(task.id)) return reject('conflict', '执行中的阶段不能拖动')
      const target = flow.stages.find((stage) => stage.id === input.stageId)
      if (!target) return reject('not_found', '目标阶段无效: ' + input.stageId)
      const next = moveTaskToStage(task, target.id, flow).task
      const moved: Task = { ...next, updatedAt: now }
      return done([
        draft('task.moved', { task: moved, from: task.currentStageId, to: moved.currentStageId }),
      ])
    }

    case 'task.complete': {
      const task = view.tasks.get(input.id)
      if (!task) return reject('not_found', '任务不存在: ' + input.id)
      const workflow = view.workflows.get(task.workflowId)
      if (!workflow) return reject('not_found', '工作流不存在: ' + task.workflowId)
      if (!stagesOf(view, workflow.id).some((stage) => stage.id === task.currentStageId)) {
        return reject('conflict', '任务当前阶段无效')
      }
      if (view.activeTaskIds.has(task.id)) return reject('conflict', '执行中的阶段不能完成')
      const completed: Task = { ...completeTask(task), updatedAt: now }
      return done([draft('task.completed', { task: completed })])
    }

    case 'task.remove': {
      const task = view.tasks.get(input.id)
      if (!task) return done([])
      return done([draft('task.removed', { task })])
    }

    // ---------- 运行（宿主内部输入） ----------
    case 'run.claim': {
      const runtime = view.runtimes.get(input.runtimeId)
      if (!runtime) return reject('not_found', '运行时不存在: ' + input.runtimeId)
      if (!runtime.enabled) return reject('conflict', '运行时未启用: ' + input.runtimeId)
      if (
        !Number.isInteger(input.capacity) ||
        input.capacity < CONCURRENCY_FLOOR ||
        input.capacity > CONCURRENCY_CAP
      ) {
        return reject('invalid_input', '领取数量必须是 1–8 的整数')
      }
      const claimed = pickClaims(view, runtime, input.capacity, now)
      return done(claimFacts(claimed, now, env.limits, HOST_SCHEDULER))
    }

    case 'run.heartbeat': {
      // 租约不匹配只静默丢弃：心跳由调度器定时发，产 reject 只会变成噪音（D1）
      return done(heartbeatFacts(view, input.runId, input.leaseId, now, env.limits, HOST_SCHEDULER))
    }

    // T6/T7/T14 逐个补齐；在补齐前显式拒绝，避免未知输入被静默当成零事实
    case 'run.receipt':
    case 'run.host_settled':
    case 'run.cancel':
    case 'clock.tick':
    case 'conversation.create':
    case 'conversation.send':
    case 'conversation.rename':
    case 'conversation.remove':
      return reject('unsupported', '输入暂未支持: ' + input.type)
  }
}
