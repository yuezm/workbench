/**
 * 唯一决策入口：命令 + 视图切片 → 事实草稿（或 `reject`）。
 *
 * 纯函数：不读时钟/随机数/文件/DB——`now`、id 生成器、视图切片都由宿主在边界注入。
 * 非法输入一律返回 `reject { code, message }`，不抛异常；文案沿用旧 `repository` /
 * `engine` 的措辞（「运行时不存在: id」「执行中的阶段不能拖动」等），便于 IPC 与 UI
 * 在迁移期零改动。
 *
 * 阶段规则只复用 `kernel/workflow/{stage-machine,stage-validation}.ts`：拖拽落点即目标、
 * 打回原地零效果等判定不在这里另写一份。进入阶段的**效果**（建 run）也由内核产事实：
 * `task.created` / `task.moved` / 回执流转到 agent 阶段时直接追加 `run.queued`，
 * 宿主只负责领取与执行，不再在提交后补写。
 *
 * M2 起入参放宽为 `protocol/inputs` 的 `Input`（命令 + 宿主内部输入）。T5–T7 实现
 * `run.claim` / `run.heartbeat` / `run.frames` / `run.receipt` / `run.cancel` /
 * `run.host_settled` / `clock.tick`，T14a 实现 `conversation.*`（聊天并入
 * `purpose='chat'` 的统一执行路径）；14 条命令的行为与文案不变。
 */
import type {
  Agent,
  Conversation,
  Message,
  RunRow,
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
import type { SettledRun } from './run'
import { chatPrompt, taskPrompt, titleFromContent } from './prompt'
import {
  abandonedFacts,
  claimFacts,
  deadlineReached,
  heartbeatFacts,
  hostSettledFacts,
  leaseExpired,
  pickClaims,
  receiptRejection,
  rejectedReceiptFacts,
  settledRun,
  settlementFacts,
  timeoutFacts,
  waitingFacts,
  waitingRun,
} from './run'
import type { StageEvent } from './workflow/stage-machine'
import { completeTask, moveTask, moveTaskToStage } from './workflow/stage-machine'
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

/** 唯一定时器（`clock.tick`）：租约过期 / 退避由 timer 触发。 */
const HOST_TIMER: Actor = { kind: 'host', via: 'timer' }

/** 运行超时：`deadlineAt` 到期由 timeout 触发（D5）。 */
const HOST_TIMEOUT: Actor = { kind: 'host', via: 'timeout' }

/** 宿主兜底取消：`run.host_settled{status:'cancelled'}`。 */
const HOST_CANCEL: Actor = { kind: 'host', via: 'cancel' }

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

/**
 * 任务下的全部 run，按入队序排（`queueSeq` → `createdAt` → `id`）。
 * 删除任务时按这个顺序产 `run.removed`，让事实序列可复现（D13）。
 */
function runsOfTask(view: View, taskId: Id): RunRow[] {
  const runs: RunRow[] = []
  for (const run of view.runs.values()) {
    if (run.taskId === taskId) runs.push(run)
  }
  return runs.sort(
    (a, b) =>
      a.queueSeq - b.queueSeq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
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

/** 对话下的消息，按创建时间排序（同毫秒按 id 兜底），供首轮提示词拼历史。 */
function messagesOf(view: View, conversationId: Id): Message[] {
  const messages: Message[] = []
  for (const message of view.messages.values()) {
    if (message.conversationId === conversationId) messages.push(message)
  }
  return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** 同一对话同时只跑一轮：存在 queued/running/waiting 的 run 即视为忙。 */
function conversationBusy(view: View, conversationId: Id): boolean {
  for (const run of view.runs.values()) {
    if (run.conversationId !== conversationId) continue
    if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting') {
      return true
    }
  }
  return false
}

/** 对话下已有的 run 数（聊天 run 的 `turn` = 已有轮次 + 1）。 */
function conversationRunCount(view: View, conversationId: Id): number {
  let count = 0
  for (const run of view.runs.values()) {
    if (run.conversationId === conversationId) count += 1
  }
  return count
}

/** 聊天 run 的完整投影行：purpose='chat'，执行配置来自对话绑定的智能体/运行时。 */
function chatRunRow(
  conversation: Conversation,
  agent: Agent,
  runtime: Runtime,
  runId: Id,
  prompt: string,
  turn: number,
  now: Iso,
): RunRow {
  return {
    id: runId,
    purpose: 'chat',
    taskId: null,
    conversationId: conversation.id,
    stageId: null,
    agentId: agent.id,
    runtimeId: runtime.id,
    ruleId: null,
    rulesVersion: 0,
    executorKey: runtime.protocolFamily,
    threadId: null,
    cwd: runtime.workdir ?? '',
    access: ACCESS_BY_PERMISSION[runtime.permissionMode],
    skill: null,
    promptRef: null,
    eventIds: [],
    hops: 0,
    turn,
    resumeSessionId: conversation.sessionId,
    threadContextRef: null,
    queueSeq: 0,
    status: 'queued',
    prompt,
    output: '',
    error: null,
    errorCode: null,
    exitCode: null,
    sessionId: null,
    usage: null,
    durationMs: null,
    leaseId: null,
    attempt: 0,
    attempts: 0,
    leaseUntil: null,
    notBefore: null,
    deadlineAt: null,
    cancelRequested: false,
    startedAt: null,
    endedAt: null,
    createdAt: now,
  }
}

/** 宿主侧事实草稿：回执由宿主转交，actor 统一标成调度器。 */
const hostDraft = <T extends FactType>(
  type: T,
  payload: FactPayload<T>,
  now: Iso,
): FactDraft<T> => ({ type, actor: HOST_SCHEDULER, at: now, payload })

/**
 * 阶段 run 终态 → 阶段流转事实：成功进下一阶段（无下一阶段则完成），失败按
 * `on_reject` 打回；打回原地 / 任务已完成 / 阶段无效 / 任务已删时零事实，取消不推进。
 * 目标阶段的进入效果（建下一条 run）由 `run.receipt` 分支在拿到 `task.moved` 后补。
 */
function stageTransitionFacts(view: View, run: SettledRun, now: Iso): FactDraft[] {
  if (run.status === 'cancelled' || run.taskId === null) return []
  const task = view.tasks.get(run.taskId)
  if (!task || task.status === 'completed') return []
  const workflow = view.workflows.get(task.workflowId)
  if (!workflow) return []
  const flow = workflowWithStages(view, workflow)
  if (!flow.stages.some((stage) => stage.id === task.currentStageId)) return []
  const event: StageEvent =
    run.status === 'succeeded'
      ? { type: 'RUN_SUCCEEDED', runId: run.id }
      : { type: 'RUN_FAILED', runId: run.id }
  const next = moveTask(task, event, flow).task
  if (next.status === 'completed') {
    return [hostDraft('task.completed', { task: { ...next, updatedAt: now } }, now)]
  }
  if (next.currentStageId !== null && next.currentStageId !== task.currentStageId) {
    return [
      hostDraft(
        'task.moved',
        {
          task: { ...next, updatedAt: now },
          from: task.currentStageId,
          to: next.currentStageId,
        },
        now,
      ),
    ]
  }
  return []
}

/**
 * 聊天 run 终态 → 一条 assistant 消息；用户消息由 `conversation.send` 产（T14）。
 * 对话在执行期间被删除时不再落消息（旧 ChatService 同样容忍：消息无处可落，本轮照常结束）。
 */
function chatMessageFacts(
  view: View,
  run: RunRow,
  settled: SettledRun,
  now: Iso,
  env: Environment,
): FactDraft[] {
  if (run.conversationId === null) return []
  if (!view.conversations.has(run.conversationId)) return []
  return [
    hostDraft(
      'message.appended',
      {
        conversationId: run.conversationId,
        messageId: env.nextId('message'),
        role: 'assistant',
        content: settled.output,
        runId: run.id,
        error: settled.error,
      },
      now,
    ),
  ]
}

/** 权限模式 → 协议帧的 access 级别（SPEC-plugins「Turn」）。 */
const ACCESS_BY_PERMISSION: Record<Runtime['permissionMode'], RunRow['access']> = {
  'read-only': 'read',
  'workspace-write': 'edit',
  'danger-full-access': 'full',
}

/**
 * 进入阶段的效果：落点阶段 `entryMode='agent'` 且智能体 / 运行时都在时，产一条
 * `run.queued`（完整 RunRow，宿主直接领取执行）。
 *
 * 每次进入都触发（人工拖拽、建任务、回执流转到目标阶段都重新建 run）；以下零事实：
 * - 阶段是 `user` / `none`（等人或仅停留）；
 * - 任务已完成 / 无当前阶段；
 * - 阶段没有绑定智能体，或智能体 / 运行时已不存在（旧 `applyStageEffects` 同口径：
 *   缺配置时只建任务，不建 run）。
 */
function entryRunFacts(
  view: View,
  task: Task,
  now: Iso,
  env: Environment,
  actor: Actor,
): FactDraft<'run.queued'>[] {
  if (task.status !== 'active' || task.currentStageId === null) return []
  const stage = view.stages.get(task.currentStageId)
  if (!stage || stage.entryMode !== 'agent') return []
  const agent = stage.agentId === null ? undefined : view.agents.get(stage.agentId)
  if (!agent) return []
  const runtime = view.runtimes.get(agent.runtimeId)
  if (!runtime) return []
  const run: RunRow = {
    id: env.nextId('run'),
    purpose: 'stage',
    taskId: task.id,
    conversationId: null,
    stageId: stage.id,
    agentId: agent.id,
    runtimeId: runtime.id,
    ruleId: null,
    rulesVersion: 0,
    executorKey: runtime.protocolFamily,
    threadId: null,
    cwd: runtime.workdir ?? '',
    access: ACCESS_BY_PERMISSION[runtime.permissionMode],
    skill: null,
    promptRef: null,
    eventIds: [],
    hops: 0,
    turn: 1,
    resumeSessionId: null,
    threadContextRef: null,
    queueSeq: 0,
    status: 'queued',
    prompt: taskPrompt(agent, task, stage.name),
    output: '',
    error: null,
    errorCode: null,
    exitCode: null,
    sessionId: null,
    usage: null,
    durationMs: null,
    leaseId: null,
    attempt: 0,
    attempts: 0,
    leaseUntil: null,
    notBefore: null,
    deadlineAt: null,
    cancelRequested: false,
    startedAt: null,
    endedAt: null,
    createdAt: now,
  }
  return [{ type: 'run.queued', actor, at: now, payload: { run } }]
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
        // 校验保证 input.stages 至少一个阶段，rows 非空：下标一定落在合法位置
        const target = rows[Math.min(previous.position, rows.length - 1)]
        facts.push(
          draft('task.moved', {
            task: { ...task, currentStageId: target.id },
            from: stageId,
            to: target.id,
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
        // D13：run 删除必须由事实显式表达（重建时外键级联不可用），先删 run 再删任务
        for (const run of runsOfTask(view, task.id)) {
          facts.push(draft('run.removed', { runId: run.id }))
        }
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
      const facts: FactDraft[] = [draft('task.created', { task })]
      // 进入效果：首阶段是 agent 时立刻入队一条 run（与旧宿主 applyStageEffects 同口径）
      facts.push(...entryRunFacts(view, task, now, env, OWNER))
      return done(facts)
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
      const facts: FactDraft[] = [
        draft('task.moved', { task: moved, from: task.currentStageId, to: moved.currentStageId }),
      ]
      // 进入效果：落点阶段的 agent 入口每次进入都重新建 run；原地（from=to）不重建
      if (moved.currentStageId !== task.currentStageId) {
        facts.push(...entryRunFacts(view, moved, now, env, OWNER))
      }
      return done(facts)
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
      // D13：先逐条删该任务的 run，再删任务；重建与旧 SQL 级联的可见结果一致
      const facts: FactDraft[] = runsOfTask(view, task.id).map((run) =>
        draft('run.removed', { runId: run.id }),
      )
      facts.push(draft('task.removed', { task }))
      return done(facts)
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

    case 'run.frames': {
      const run = view.runs.get(input.runId)
      // run 已终态 / 已删 / 轮次变了：帧无处可写，静默丢弃（数据源仍是 run.frames 事实，
      // 丢了也不影响终态；不产 reject，避免宿主 flush 时把 run 判死）
      if (!run || run.status !== 'running' || run.turn !== input.turn) return done([])
      return done([
        {
          type: 'run.frames',
          actor: HOST_SCHEDULER,
          at: now,
          payload: { runId: input.runId, turn: input.turn, frames: input.frames },
        },
      ])
    }

    case 'run.receipt': {
      const run = view.runs.get(input.runId)
      // 回执对不上任何 run（任务已删 / 宿主重放）：报 not_found，不伪造审计事实
      if (!run) return reject('not_found', '运行不存在: ' + input.runId)
      const rejection = receiptRejection(run, input.receipt)
      if (rejection !== null) {
        return done(rejectedReceiptFacts(run, input.receipt, rejection, now, HOST_SCHEDULER))
      }
      // 回执带 ask：挂起等回答，释放租约与并发位，不落终态（D12）
      if ((input.receipt.ask?.length ?? 0) > 0) {
        return done(waitingFacts(waitingRun(run, input.receipt), now, HOST_SCHEDULER))
      }
      const settled = settledRun(run, input.receipt, now)
      const facts: FactDraft[] = [...settlementFacts(settled, now, HOST_SCHEDULER)]
      if (run.purpose === 'stage') {
        const transition = stageTransitionFacts(view, settled, now)
        facts.push(...transition)
        // 进入效果：流转到目标阶段后若目标阶段是 agent 入口，立刻入队下一轮（形成链条）
        for (const fact of transition) {
          if (fact.type !== 'task.moved') continue
          const movedTask = (fact.payload as { task: Task }).task
          facts.push(...entryRunFacts(view, movedTask, now, env, HOST_SCHEDULER))
        }
      }
      if (run.purpose === 'chat') {
        facts.push(...chatMessageFacts(view, run, settled, now, env))
        // 续接会话 id 记到对话上：下一轮直接用它续接，避免整段历史重发（D8）
        const conversation =
          run.conversationId === null ? undefined : view.conversations.get(run.conversationId)
        if (conversation && settled.sessionId !== null) {
          facts.push(
            hostDraft(
              'conversation.updated',
              { conversation: { ...conversation, sessionId: settled.sessionId, updatedAt: now } },
              now,
            ),
          )
        }
      }
      return done(facts)
    }

    case 'run.cancel': {
      const run = view.runs.get(input.runId)
      if (!run) return reject('not_found', '运行不存在: ' + input.runId)
      if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') {
        return reject('conflict', '运行已结束，无法取消: ' + input.runId)
      }
      // 重复取消幂等：已请求过就零事实，等宿主按取消时序落终态
      if (run.cancelRequested) return done([])
      return done([
        draft('run.cancel_requested', { run: { ...run, cancelRequested: true }, by: 'owner' }),
      ])
    }

    case 'run.host_settled': {
      const run = view.runs.get(input.runId)
      if (!run) return reject('not_found', '运行不存在: ' + input.runId)
      const actor = input.status === 'cancelled' ? HOST_CANCEL : HOST_SCHEDULER
      const facts: FactDraft[] = hostSettledFacts(run, input, now, actor)
      // 聊天 run 由宿主兜底落终态时同样补一条 assistant 消息（中断/取消/超时都要可见），
      // 阶段 run 的兜底不推进阶段（与旧 runner 的失败口径一致）。
      if (run.purpose === 'chat') {
        for (const fact of facts) {
          if (fact.type !== 'run.failed' && fact.type !== 'run.cancelled') continue
          const settled = (fact.payload as { run: RunRow }).run as SettledRun
          facts.push(...chatMessageFacts(view, settled, settled, now, env))
        }
      }
      return done(facts)
    }

    case 'clock.tick': {
      // 唯一定时器到点：先判整体超时（终态），再看租约过期（放弃 / 重试）
      const facts: FactDraft[] = []
      for (const run of view.runs.values()) {
        if (deadlineReached(run, now)) {
          facts.push(...timeoutFacts(run, now, HOST_TIMEOUT))
        } else if (leaseExpired(run, now)) {
          facts.push(...abandonedFacts(run, now, env.limits, HOST_TIMER))
        }
      }
      return done(facts)
    }

    // ---------- 对话（聊天并入 purpose='chat' 的统一执行路径，T14a） ----------
    case 'conversation.create': {
      const agent = view.agents.get(input.agentId)
      if (!agent) return reject('not_found', '智能体不存在: ' + input.agentId)
      const conversation: Conversation = {
        id: env.nextId('conversation'),
        title: input.title?.trim() || '新对话',
        agentId: agent.id,
        sessionId: null,
        createdAt: now,
        updatedAt: now,
      }
      return done([draft('conversation.created', { conversation })])
    }

    case 'conversation.send': {
      const conversation = view.conversations.get(input.conversationId)
      if (!conversation) return reject('not_found', '对话不存在: ' + input.conversationId)
      const agent = view.agents.get(conversation.agentId)
      if (!agent) return reject('not_found', '智能体不存在: ' + conversation.agentId)
      const runtime = view.runtimes.get(agent.runtimeId)
      if (!runtime) return reject('not_found', '运行时不存在: ' + agent.runtimeId)
      if (!runtime.enabled) return reject('conflict', '运行时已停用，请先在设置里启用')
      const content = input.content.trim()
      if (!content) return reject('invalid_input', '消息内容不能为空')
      // 同一对话同时只跑一轮：被拒绝时不落任何消息
      if (conversationBusy(view, conversation.id)) {
        return reject('conflict', '该对话正在执行中，请先等待或中止')
      }

      const history = messagesOf(view, conversation.id)
      const messageId = env.nextId('message')
      const runId = env.nextId('run')
      const userMessage: Message = {
        id: messageId,
        conversationId: conversation.id,
        role: 'user',
        content,
        error: null,
        createdAt: now,
      }
      // 首轮带完整历史与 systemPrompt；续接轮只发新消息（执行器用 resumeSessionId 续接）
      const prompt =
        conversation.sessionId === null ? chatPrompt(agent, [...history, userMessage]) : content
      const turn = conversationRunCount(view, conversation.id) + 1
      const facts: FactDraft[] = [
        draft('message.appended', {
          conversationId: conversation.id,
          messageId,
          role: 'user',
          content,
          runId,
        }),
      ]
      // 首条消息（或标题为空）给对话命名（旧 ChatService 同口径：取首行、24 码点截断）
      if (history.length === 0 || conversation.title.trim() === '') {
        facts.push(
          draft('conversation.updated', {
            conversation: { ...conversation, title: titleFromContent(content), updatedAt: now },
          }),
        )
      }
      facts.push(
        draft('run.queued', {
          run: chatRunRow(conversation, agent, runtime, runId, prompt, turn, now),
        }),
      )
      return done(facts)
    }

    case 'conversation.rename': {
      const conversation = view.conversations.get(input.conversationId)
      if (!conversation) return reject('not_found', '对话不存在: ' + input.conversationId)
      const title = input.title.trim()
      if (!title) return reject('invalid_input', '对话标题必填')
      return done([
        draft('conversation.updated', {
          conversation: { ...conversation, title, updatedAt: now },
        }),
      ])
    }

    case 'conversation.remove': {
      const conversation = view.conversations.get(input.conversationId)
      if (!conversation) return done([])
      // tombstone：消息随对话一起删除由 project 级联；历史 run 保留 conversationId 作为引用
      return done([draft('conversation.removed', { conversation })])
    }
  }
}
