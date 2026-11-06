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
  Card,
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
import type { TaskComment } from '../protocol/task-comment'
import type { EventReceivedPayload, FactPayload, FactType } from '../protocol/facts'
import type { Input, Receipt } from '../protocol/inputs'
import type { Actor, Decision, Environment, FactDraft, Id, Iso, Reason, View } from './types'
import type { SettledRun } from './run'
import { chatPrompt, laterPrompt, titleFromContent } from './prompt'
import { answerFacts, cardsFromReceipt, resolveFacts, resumedRun } from './cards'
import { entryRunFacts, ACCESS_BY_PERMISSION } from './task-effects'
import { cronTaskFacts, eventThreadFacts, manualTriggerFacts, validateRuleBatch } from './rules'
import { replacedPluginSettings, validatePluginSettings } from './plugins'
import {
  boundFacts,
  closeIfAllDone,
  closedFacts,
  findThreadByKey,
  inactivityFacts,
  makeNote,
  noteFacts,
  openThreadRow,
  openedFacts,
  taskAttachedFacts,
  threadOfTask,
  withBinding,
  withNote,
  withStatus,
  withTask,
} from './threads'
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
import { handoffOnExit, validateStageHandoffs } from './handoff'
import type { StageEvent } from './workflow/stage-machine'
import { completeTask, moveTask, moveTaskToStage } from './workflow/stage-machine'
import { validateStageSet } from './workflow/stage-validation'

/**
 * 权限模式白名单：`src/protocol/entities.ts` 里的常量是唯一真相源，
 * 内核只允许依赖协议层的类型（不引运行期值），所以这里按同一份取值做运行期校验。
 * 执行器键不在这里校验取值：内核不认识任何执行器（也不认识产品名），
 * 合法性由宿主入口按插件注册表判断（M3 D2）。
 */
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

/** 通道投递回写：通道 hub 回报 `card.delivered` / `card.delivery_failed`（D9）。 */
const HOST_CHANNEL: Actor = { kind: 'host', via: 'channel' }

/**
 * 通道投递回写（D2/D9）：只对「当前仍存在的卡片 + 版本一致」生效。
 *
 * - 版本不一致（卡片已更新到新版本）/ 卡片已删除：迟到投递，零事实；
 * - delivered 幂等：同一版本已 delivered 再报 → 零事实；failed 可被后续 delivered 覆盖；
 * - 已 delivered 的版本不再降级为 failed（已送达至少一个通道），同版本重复 failed 也幂等；
 * - 整行事实：只改 `delivery` / `deliveryRef` / `updatedAt`，其余字段原样，重建不回查。
 */
function deliveryFacts(
  view: View,
  input: { cardId: Id; version: number },
  patch: { kind: 'delivered'; ref: string } | { kind: 'failed'; error: string },
  now: Iso,
): FactDraft[] {
  const card = view.cards.get(input.cardId)
  if (!card || card.version !== input.version) return []
  if (patch.kind === 'delivered') {
    if (card.delivery === 'delivered') return []
    const next: Card = { ...card, delivery: 'delivered', deliveryRef: patch.ref, updatedAt: now }
    return [
      {
        type: 'card.delivered',
        actor: HOST_CHANNEL,
        at: now,
        payload: { card: next, ref: patch.ref },
      },
    ]
  }
  if (card.delivery === 'delivered' || card.delivery === 'failed') return []
  const next: Card = { ...card, delivery: 'failed', deliveryRef: null, updatedAt: now }
  return [
    {
      type: 'card.delivery_failed',
      actor: HOST_CHANNEL,
      at: now,
      payload: { card: next, error: patch.error },
    },
  ]
}

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
    // M7：交接目标按 id 直存（跨工作流，不能用本批下标表达）
    handoffWorkflowId: stage.handoffWorkflowId ?? null,
    handoffStageId: stage.handoffStageId ?? null,
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
    a.onRejectStageId === b.onRejectStageId &&
    // M7：交接两列一变就要落 stage.updated，否则更新被静默吞掉
    a.handoffWorkflowId === b.handoffWorkflowId &&
    a.handoffStageId === b.handoffStageId
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
    executorKey: runtime.executorKey,
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
 *
 * M7：成功且向前离开阶段时，在 `task.moved` / `task.completed` **之前**追加交接事实
 * （目标工作流建任务），保证同一批重建顺序稳定。
 */
function stageTransitionFacts(
  view: View,
  run: SettledRun,
  now: Iso,
  env: Environment,
): FactDraft[] {
  if (run.status === 'cancelled' || run.taskId === null) return []
  const task = view.tasks.get(run.taskId)
  if (!task || task.status === 'completed') return []
  const workflow = view.workflows.get(task.workflowId)
  if (!workflow) return []
  const flow = workflowWithStages(view, workflow)
  const current = flow.stages.find((stage) => stage.id === task.currentStageId)
  if (!current) return []
  const succeeded = run.status === 'succeeded'
  const event: StageEvent = succeeded
    ? { type: 'RUN_SUCCEEDED', runId: run.id }
    : { type: 'RUN_FAILED', runId: run.id }
  const next = moveTask(task, event, flow).task
  if (next.status === 'completed') {
    return [
      ...handoffOnExit(view, task, current, null, succeeded, now, env, HOST_SCHEDULER),
      hostDraft('task.completed', { task: { ...next, updatedAt: now } }, now),
    ]
  }
  if (next.currentStageId !== null && next.currentStageId !== task.currentStageId) {
    const target = flow.stages.find((stage) => stage.id === next.currentStageId)
    return [
      // 目标阶段找不到属于脏投影：不当作「完成」，宁可不交接
      ...(target === undefined
        ? []
        : handoffOnExit(view, task, current, target, succeeded, now, env, HOST_SCHEDULER)),
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

/** 摘要截断：按码点取前 200 字（与 `protocol/validate` 的 `summary` 上限一致）。 */
function truncateSummary(summary: string): string {
  const chars = Array.from(summary)
  return chars.length > 200 ? chars.slice(0, 200).join('') : summary
}

/**
 * 回执派生事件（D8）：M4 只入账、不派活。每条事件一个 `event.received`，
 * `hops = 父 run.hops + 1`、`originRunId` 是派生出它的 run、`summary` ≤200 字；
 * `detail` 全文由宿主落资料文件，这里的 `detailRef` 先留 null。
 * `hops > maxHops` 时只写一条 `event.dropped`（熔断，不派活、不建卡）。
 */
function eventFacts(run: RunRow, receipt: Receipt, now: Iso, env: Environment): FactDraft[] {
  const events = receipt.events ?? []
  if (events.length === 0) return []
  const hops = run.hops + 1
  return events.map((event) => {
    const eventId = env.nextId('event')
    if (hops > env.limits.maxHops) {
      return {
        type: 'event.dropped',
        actor: HOST_SCHEDULER,
        at: now,
        payload: { eventId, hops, reason: 'max_hops' },
      }
    }
    return {
      type: 'event.received',
      actor: HOST_SCHEDULER,
      at: now,
      payload: {
        eventId,
        source: event.source,
        type: event.type,
        subject: event.subject,
        summary: truncateSummary(event.summary ?? ''),
        detailRef: null,
        link: event.link ?? null,
        hops,
        originRunId: run.id,
        dedupeKey: event.dedupeKey ?? null,
      },
    }
  })
}

/**
 * 外部事件入账 + 规则匹配（M6）：产一条 `event.received`，超过跳数上限只产
 * `event.dropped`（熔断，不建任务）；否则立即按当前规则集建任务。
 *
 * 入账与建任务在同一批事实里，重建按 seq 顺序 fold 结果一致。
 */
function receivedEventFacts(
  view: View,
  event: {
    source: string
    type: string
    subject: string
    summary?: string | null
    detailRef: string | null
    link: string | null
    hops: number
    originRunId: string | null
    dedupeKey: string | null
  },
  now: Iso,
  env: Environment,
  actor: Actor,
): FactDraft[] {
  const eventId = env.nextId('event')
  if (event.hops > env.limits.maxHops) {
    return [
      {
        type: 'event.dropped',
        actor,
        at: now,
        payload: { eventId, hops: event.hops, reason: 'max_hops' },
      },
    ]
  }
  const payload = {
    eventId,
    source: event.source,
    type: event.type,
    subject: event.subject,
    summary: truncateSummary(event.summary ?? ''),
    detailRef: event.detailRef,
    link: event.link,
    hops: event.hops,
    originRunId: event.originRunId,
    dedupeKey: event.dedupeKey,
  }
  return [
    { type: 'event.received', actor, at: now, payload },
    ...eventThreadFacts(view, payload, view.rulesVersion, now, env),
  ]
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
      // 执行器键与启动命令的缺省值来自执行器插件 manifest（宿主入口补齐），
      // 内核只要求「已确定」，不认识具体产品（M3 D2）。
      const executorKey = form.executorKey?.trim() ?? ''
      if (!executorKey) return reject('invalid_input', '运行时缺少执行器键（executorKey）')
      const command = form.command?.trim() ?? ''
      if (!command) return reject('invalid_input', '运行时缺少启动命令（command）')
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
        executorKey,
        command,
        profile: form.profile?.trim() ?? '',
        argsTemplate: form.argsTemplate ?? '',
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
      const executorKey =
        patch.executorKey === undefined ? current.executorKey : patch.executorKey.trim()
      if (!executorKey) return reject('invalid_input', '运行时缺少执行器键（executorKey）')
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
        executorKey,
        permissionMode,
        command: patch.command?.trim() || current.command,
        profile: patch.profile !== undefined ? patch.profile.trim() : current.profile,
        argsTemplate: patch.argsTemplate !== undefined ? patch.argsTemplate : current.argsTemplate,
        model: patch.model !== undefined ? patch.model : current.model,
        reasoningEffort:
          patch.reasoningEffort !== undefined ? patch.reasoningEffort : current.reasoningEffort,
        workdir: patch.workdir !== undefined ? patch.workdir : current.workdir,
        maxConcurrent,
        enabled: patch.enabled !== undefined ? patch.enabled === true : current.enabled,
      }
      return done([draft('runtime.updated', { runtime })])
    }

    case 'runtime.probe':
      // M5 编排命令：探测需要执行器端口，由宿主命令路由处理（内核不碰副作用）。
      // 直接进 decide 说明绕过了路由，明确拒绝而不是静默零事实。
      return reject('unsupported', 'runtime.probe 由宿主编排（探测后落 runtime.probed）')

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
      // M7：交接目标必须存在且 ≠ 自身、目标阶段属于目标工作流（保存时校验，读时再防御）
      const handoffError = validateStageHandoffs(view, workflowId, form.stages)
      if (handoffError) return reject('invalid_input', handoffError)
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
      // M7：交接目标工作流 / 阶段的存在与从属（自指在保存时就拒绝）
      const handoffError = validateStageHandoffs(view, current.id, form.stages)
      if (handoffError) return reject('invalid_input', handoffError)

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
      // M6.5：手工任务自动挂隐式线程（source='manual'），之后可用 thread.bind 绑定入口
      const thread = openThreadRow(env, {
        source: 'manual',
        externalRef: null,
        title,
        now,
      })
      const task: Task = {
        id: env.nextId('task'),
        title,
        description: form.description ?? '',
        workflowId: workflow.id,
        currentStageId: requested ?? stages[0]?.id ?? null,
        status: 'active',
        origin: 'manual',
        ruleId: null,
        externalRef: null,
        labels: [],
        threadId: thread.id,
        parentTaskId: null,
        handoffFromTaskId: null,
        handoffFromStageId: null,
        createdAt: now,
        updatedAt: now,
      }
      const attached = withTask(thread, task, now)
      const facts: FactDraft[] = [
        ...openedFacts(thread, OWNER, now),
        ...taskAttachedFacts(attached, task, null, OWNER, now),
        draft('task.created', { task }),
      ]
      // 进入效果：首阶段是 agent 时立刻入队一条 run（与旧宿主 applyStageEffects 同口径）
      facts.push(
        ...entryRunFacts(view, task, now, env, OWNER, undefined, { thread: attached, turn: 1 }),
      )
      return done(facts)
    }

    case 'task.move': {
      const task = view.tasks.get(input.id)
      if (!task) return reject('not_found', '任务不存在: ' + input.id)
      const workflow = view.workflows.get(task.workflowId)
      if (!workflow) return reject('not_found', '工作流不存在: ' + task.workflowId)
      const flow = workflowWithStages(view, workflow)
      const fromStage = flow.stages.find((stage) => stage.id === task.currentStageId)
      if (!fromStage) return reject('conflict', '任务当前阶段无效')
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
      // M7：拖到更后阶段 = 向前离开，触发交接；拖回更前阶段不触发
      facts.push(...handoffOnExit(view, task, fromStage, target, true, now, env, OWNER))
      return done(facts)
    }

    case 'task.complete': {
      const task = view.tasks.get(input.id)
      if (!task) return reject('not_found', '任务不存在: ' + input.id)
      const workflow = view.workflows.get(task.workflowId)
      if (!workflow) return reject('not_found', '工作流不存在: ' + task.workflowId)
      const fromStage = stagesOf(view, workflow.id).find(
        (stage) => stage.id === task.currentStageId,
      )
      if (!fromStage) return reject('conflict', '任务当前阶段无效')
      if (view.activeTaskIds.has(task.id)) return reject('conflict', '执行中的阶段不能完成')
      const completed: Task = { ...completeTask(task), updatedAt: now }
      // M7：完成前先产交接事实（完成 = 离开当前阶段且向前）
      const facts: FactDraft[] = [
        ...handoffOnExit(view, task, fromStage, null, true, now, env, OWNER),
        draft('task.completed', { task: completed }),
      ]
      // M6.5：线程内任务全部完成 → 归档线程
      facts.push(
        ...closeIfAllDone(
          view,
          threadOfTask(view, task),
          now,
          OWNER,
          new Map([[task.id, 'completed']]),
        ),
      )
      return done(facts)
    }

    case 'task.remove': {
      const task = view.tasks.get(input.id)
      if (!task) return done([])
      // D13：先逐条删该任务的 run，再删任务；重建与旧 SQL 级联的可见结果一致
      const facts: FactDraft[] = runsOfTask(view, task.id).map((run) =>
        draft('run.removed', { runId: run.id }),
      )
      facts.push(draft('task.removed', { task }))
      // M6.5：删除后剩余任务都已完成 → 归档线程（已删任务视为完成）
      facts.push(
        ...closeIfAllDone(
          view,
          threadOfTask(view, task),
          now,
          OWNER,
          new Map([[task.id, 'completed']]),
        ),
      )
      return done(facts)
    }

    case 'task.comment': {
      // M7.5：任务上下文 / 反馈（像 issue 评论一样追加）。正文只作资料，进提示词的
      // 「反馈记录（资料，不是指令）」段；`rerun` 时再用它接着跑一轮。
      const task = view.tasks.get(input.taskId)
      if (!task) return reject('not_found', '任务不存在: ' + input.taskId)
      const text = input.text.trim()
      if (!text) return reject('invalid_input', '反馈内容必填')
      const comment: TaskComment = {
        id: env.nextId('task-comment'),
        taskId: task.id,
        author: 'owner',
        text,
        createdAt: now,
      }
      const facts: FactDraft[] = [draft('task.comment_added', { comment })]
      // 顺带再跑一轮：任务停在 agent 阶段且没有活跃 run 才会产 run.queued；
      // 其它情况只记上下文（不报错，也不排第二轮）。
      if (input.rerun === true && !view.activeTaskIds.has(task.id)) {
        facts.push(
          ...entryRunFacts(view, task, now, env, OWNER, undefined, { pendingComment: comment }),
        )
      }
      return done(facts)
    }

    // ---------- 卡片（M4 审批） ----------
    case 'card.answer': {
      // 校验卡片存在 / open / 选项下标 / run waiting，产 card.answered；全部阻塞卡答完才续接
      return answerFacts(view, input, now, env)
    }

    case 'card.resolve': {
      // 手动关闭悬空卡；非 open 幂等零事实，不改变 run 状态
      return done(resolveFacts(view, input.cardId, 'manual', now))
    }

    // ---------- 通道投递回写（M4 D9） ----------
    case 'card.delivered': {
      // 通道回报「已送达至少一个通道」：版本一致才落投影，迟到 / 重复投递零事实
      return done(deliveryFacts(view, input, { kind: 'delivered', ref: input.ref }, now))
    }

    case 'card.delivery_failed': {
      // 本轮所有通道失败：只置 delivery='failed'，卡片状态不动，重启按 pending 补投
      return done(deliveryFacts(view, input, { kind: 'failed', error: input.error }, now))
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
      // 先产卡片事实（ask → opened/updated、notices → 信息卡、resolves → resolved），
      // 再产派生事件；卡片事实排在 run.waiting / 终态事实之前，重建顺序稳定（D5/D8）。
      const receiptCards = cardsFromReceipt(view, run, input.receipt, now, env)
      const derivedEvents = eventFacts(run, input.receipt, now, env)
      const facts: FactDraft[] = [...receiptCards.facts, ...derivedEvents]
      // M6：回执派生的 event.received 同样命中规则；M6.5：按父 run 归线程/父任务
      for (const derived of derivedEvents) {
        if (derived.type !== 'event.received') continue
        facts.push(
          ...eventThreadFacts(
            view,
            derived.payload as EventReceivedPayload,
            view.rulesVersion,
            now,
            env,
          ),
        )
      }
      // M6.5：回执 notes[] → 线程笔记（run 没挂线程 / 线程不存在时忽略；笔记只作资料、不阻塞）
      const receiptNotes = input.receipt.notes
      if (run.threadId !== null && receiptNotes !== undefined && receiptNotes.length > 0) {
        const thread = view.threads.get(run.threadId)
        if (thread !== undefined) {
          let current = thread
          for (const text of receiptNotes) {
            const note = makeNote(env, 'agent', text, now)
            current = withNote(current, note, now)
            facts.push(...noteFacts(current, note, HOST_SCHEDULER, now))
          }
        }
      }
      // 回执带 ask：先建卡再挂起等回答，释放租约与并发位，不落终态（D5/D12）
      if ((input.receipt.ask?.length ?? 0) > 0) {
        facts.push(
          ...waitingFacts(
            waitingRun(run, input.receipt),
            receiptCards.cardIds,
            now,
            HOST_SCHEDULER,
          ),
        )
        return done(facts)
      }
      // 只有 later（无 ask/notices）时不落终态：回 queued 到点复查，不重建会话（D7）
      if (input.receipt.later && (input.receipt.notices?.length ?? 0) === 0) {
        facts.push({
          type: 'run.queued',
          actor: HOST_SCHEDULER,
          at: now,
          payload: { run: resumedRun(run, laterPrompt(), input.receipt.later) },
        })
        return done(facts)
      }
      const settled = settledRun(run, input.receipt, now)
      facts.push(...settlementFacts(settled, now, HOST_SCHEDULER))
      if (run.purpose === 'stage') {
        const transition = stageTransitionFacts(view, settled, now, env)
        facts.push(...transition)
        // 进入效果：流转到目标阶段后若目标阶段是 agent 入口，立刻入队下一轮（形成链条）
        for (const fact of transition) {
          if (fact.type === 'task.moved') {
            const movedTask = (fact.payload as { task: Task }).task
            facts.push(...entryRunFacts(view, movedTask, now, env, HOST_SCHEDULER))
          }
          // M6.5：阶段流转把任务完成时，若线程内任务已全部完成 → 归档线程
          if (fact.type === 'task.completed') {
            const done = (fact.payload as { task: Task }).task
            const thread = done.threadId === null ? undefined : view.threads.get(done.threadId)
            facts.push(
              ...closeIfAllDone(
                view,
                thread,
                now,
                HOST_SCHEDULER,
                new Map([[done.id, 'completed']]),
              ),
            )
          }
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
      // 唯一定时器到点：先判整体超时（终态），再看租约过期（放弃 / 重试），最后 cron 规则。
      const facts: FactDraft[] = []
      for (const run of view.runs.values()) {
        if (deadlineReached(run, now)) {
          facts.push(...timeoutFacts(run, now, HOST_TIMEOUT))
        } else if (leaseExpired(run, now)) {
          facts.push(...abandonedFacts(run, now, env.limits, HOST_TIMER))
        }
      }
      // M6：cron 规则到点建任务（同刻只触发一次；停机错过只补最近一次）
      facts.push(...cronTaskFacts(view, now, env, env.timezone))
      // M6.5：14 天无活动的 open 线程归档（只影响 UI 检索，不改任务/运行）
      facts.push(...inactivityFacts(view, now, HOST_TIMER))
      return done(facts)
    }

    // ---------- 对话（聊天并入 purpose='chat' 的统一执行路径，T14a；M5 命令化） ----------
    case 'chat.create': {
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

    case 'chat.send': {
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

    case 'chat.remove': {
      const conversation = view.conversations.get(input.conversationId)
      if (!conversation) return done([])
      // tombstone：消息随对话一起删除由 project 级联；历史 run 保留 conversationId 作为引用
      return done([draft('conversation.removed', { conversation })])
    }

    case 'chat.cancel': {
      // 中止该对话进行中的一轮：逐条产取消请求（与 run.cancel 同一收尾链路），
      // 已请求过取消的跳过（重复取消幂等），无活跃 run 时零事实。
      const conversation = view.conversations.get(input.conversationId)
      if (!conversation) return reject('not_found', '对话不存在: ' + input.conversationId)
      const facts: FactDraft[] = []
      for (const run of view.runs.values()) {
        if (run.conversationId !== conversation.id) continue
        if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting')
          continue
        if (run.cancelRequested) continue
        facts.push(
          draft('run.cancel_requested', { run: { ...run, cancelRequested: true }, by: 'owner' }),
        )
      }
      return done(facts)
    }

    case 'app.event': {
      // app 插件事件（M5 只入账，M6 起命中规则建任务）：类型白名单由宿主入口先校验。
      // `hops=1`（无父 run）、`originRunId=null`（外部来源）、`detailRef=null`（不落资料文件）。
      return done(
        receivedEventFacts(
          view,
          {
            source: 'app',
            type: input.eventType,
            subject: input.subject,
            summary: input.summary,
            detailRef: null,
            link: input.link ?? null,
            hops: 1,
            originRunId: null,
            dedupeKey: input.dedupeKey ?? null,
          },
          now,
          env,
          OWNER,
        ),
      )
    }

    case 'event.received': {
      // source 插件 / 宿主注入的外部事件（M6）：入账后立即匹配规则建任务。
      return done(
        receivedEventFacts(
          view,
          {
            source: input.event.source,
            type: input.event.type,
            subject: input.event.subject,
            summary: input.event.summary,
            detailRef: input.detailRef ?? null,
            link: input.event.link ?? null,
            hops: input.hops ?? 1,
            originRunId: input.originRunId ?? null,
            dedupeKey: input.event.dedupeKey ?? null,
          },
          now,
          env,
          HOST_SCHEDULER,
        ),
      )
    }

    // ---------- 自动化规则（M6） ----------
    case 'rules.replace': {
      // 整批替换：任一条非法 → 整批 reject（零事实），旧版继续生效；版本由内核 +1。
      const result = validateRuleBatch(view, input.rules)
      if ('error' in result) return reject('invalid_input', result.error)
      return done([
        draft('rules.replaced', {
          ruleSet: {
            id: 'current',
            version: result.version,
            replacedAt: now,
            rules: result.rules,
          },
        }),
      ])
    }

    case 'rule.trigger': {
      // 规则页「立即运行」：直接按规则建任务，不依赖事件、不写 rule.fired
      return manualTriggerFacts(view, input.ruleId, now, env)
    }

    case 'plugins.replace': {
      // 整批替换：任一条非法 → 整批 reject（零事实），旧版继续生效；版本由内核 +1。
      // secret 不在这条命令里（宿主写到非投影表），因此本事实可以整行重建。
      const result = validatePluginSettings(input.settings)
      if ('error' in result) return reject('invalid_input', result.error)
      return done([
        draft('plugins.replaced', {
          pluginSettings: replacedPluginSettings(
            result.settings,
            view.pluginSettingsVersion + 1,
            now,
          ),
        }),
      ])
    }

    case 'plugin.set':
      // 编排命令：宿主读当前快照 + 磁盘 manifest 后合并，再转 `plugins.replace`。
      // 直接进 decide 说明绕过了路由，明确拒绝而不是静默零事实。
      return reject('unsupported', 'plugin.set 由宿主编排（合并后落 plugins.replaced）')

    // ---------- 线程（M6.5） ----------
    case 'thread.note': {
      const thread = view.threads.get(input.threadId)
      if (!thread) return reject('not_found', '线程不存在: ' + input.threadId)
      const note = makeNote(env, 'owner', input.text.trim(), now)
      const next = withNote(thread, note, now)
      return done(noteFacts(next, note, OWNER, now))
    }

    case 'thread.close': {
      // 人工归档：幂等（已关闭零事实）；新事件到达会自动重开
      const thread = view.threads.get(input.threadId)
      if (!thread) return reject('not_found', '线程不存在: ' + input.threadId)
      if (thread.status === 'closed') return done([])
      return done(closedFacts(withStatus(thread, 'closed', now), 'manual', OWNER, now))
    }

    case 'thread.bind': {
      // 把隐式线程绑定到外部入口：目标键不能被别的线程占用（身份唯一）
      const thread = view.threads.get(input.threadId)
      if (!thread) return reject('not_found', '线程不存在: ' + input.threadId)
      const source = input.source.trim()
      const externalRef = input.externalRef.trim()
      const existing = findThreadByKey(view, source, externalRef)
      if (existing !== undefined && existing.id !== thread.id) {
        return reject('conflict', '入口已被线程占用: ' + source + '/' + externalRef)
      }
      const bound = withBinding(thread, source, externalRef, now)
      return done(boundFacts(bound, source, externalRef, OWNER, now))
    }
  }
}
