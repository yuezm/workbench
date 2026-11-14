/**
 * 内核命令处理的公共原件（R2 从 `decide.ts` 拆出，行为不变）。
 *
 * 只放跨命令域复用的纯函数、演员常量与派生事实；时间 / ID / 随机仍由宿主在边界注入。
 */
import type {
  PermissionMode,
  RunRow,
  Task,
  Workflow,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../protocol/entities'
import type { FactPayload, FactType } from '../../../protocol/facts'
import type {
  Actor,
  Decision,
  Environment,
  FactDraft,
  Id,
  Iso,
  Reason,
  View,
} from '../../core/types'
import type { SettledRun } from '../run'
import { eventThreadFacts, skippedRuleFacts } from '../rules'

/** 命令全部来自 owner（renderer 经宿主派发），事实的 actor 不带来源推导。 */
export const OWNER: Actor = { kind: 'owner', via: 'ui' }

/** 宿主调度器发起的领取 / 续租：actor 标明来源，便于 why 链区分。 */
export const HOST_SCHEDULER: Actor = { kind: 'host', via: 'scheduler' }

/** 唯一定时器（`clock.tick`）：租约过期 / 退避由 timer 触发。 */
export const HOST_TIMER: Actor = { kind: 'host', via: 'timer' }

/** 运行超时：`deadlineAt` 到期由 timeout 触发（D5）。 */
export const HOST_TIMEOUT: Actor = { kind: 'host', via: 'timeout' }

/** 宿主兜底取消：`run.host_settled{status:'cancelled'}`。 */
export const HOST_CANCEL: Actor = { kind: 'host', via: 'cancel' }

/** 通道投递回写：通道 hub 回报 `card.delivered` / `card.delivery_failed`（D9）。 */
export const HOST_CHANNEL: Actor = { kind: 'host', via: 'channel' }

/** 并发上限：至少 1，最多 8（本地单机没必要更多）。 */
export const CONCURRENCY_FLOOR = 1
export const CONCURRENCY_CAP = 8

/** 权限模式白名单：形状与取值以 `protocol/entities` 为准，内核只做本地校验。 */
const PERMISSION_MODES: readonly PermissionMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/** 权限模式归一：不认识的值返回 null，由调用方拒绝。 */
export function permissionModeOf(value: string): PermissionMode | null {
  return (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : null
}

/** 并发上限归一：未给沿用 fallback；非正整数返回 null（交给调用方拒绝）；超过上限按上限。 */
export function normalizeConcurrency(value: number | undefined, fallback: number): number | null {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < CONCURRENCY_FLOOR) return null
  return Math.min(value, CONCURRENCY_CAP)
}

/** 智能体环境变量归一：只收字符串值（形状与上限由 `protocol/validate` 把关）。 */
export function normalizeEnv(value: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value ?? {})) {
    if (typeof item === 'string') env[key] = item
  }
  return env
}

export const done = (facts: FactDraft[]): Decision => ({ facts })

export const reject = (code: Reason, message: string): Decision => ({
  facts: [],
  reject: { code, message },
})

/** owner 命令的事实草稿（actor 固定 OWNER）。 */
export const ownerDraft = <T extends FactType>(
  type: T,
  payload: FactPayload<T>,
  now: Iso,
): FactDraft<T> => ({ type, actor: OWNER, at: now, payload })

/** 宿主侧事实草稿：回执由宿主转交，actor 统一标成调度器。 */
export const hostDraft = <T extends FactType>(
  type: T,
  payload: FactPayload<T>,
  now: Iso,
): FactDraft<T> => ({ type, actor: HOST_SCHEDULER, at: now, payload })

/** 工作流下的阶段，按 position 升序（投影表里 position 唯一）。 */
export function stagesOf(view: View, workflowId: Id): WorkflowStage[] {
  const stages: WorkflowStage[] = []
  for (const stage of view.stages.values()) {
    if (stage.workflowId === workflowId) stages.push(stage)
  }
  return stages.sort((a, b) => a.position - b.position)
}

export function workflowWithStages(view: View, workflow: Workflow): WorkflowWithStages {
  return { ...workflow, stages: stagesOf(view, workflow.id) }
}

/** 任务按创建时间排序（同毫秒用 id 兜底），保证同一视图产出的顺序稳定。 */
export function tasksOf(view: View, workflowId: Id): Task[] {
  const tasks: Task[] = []
  for (const task of view.tasks.values()) {
    if (task.workflowId === workflowId) tasks.push(task)
  }
  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** 任务下的全部 run，按入队序排（`queueSeq` → `createdAt` → `id`）。 */
export function runsOfTask(view: View, taskId: Id): RunRow[] {
  const runs: RunRow[] = []
  for (const run of view.runs.values()) {
    if (run.taskId === taskId) runs.push(run)
  }
  return runs.sort(
    (a, b) =>
      a.queueSeq - b.queueSeq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

/** 命中该工作流的活跃 run（「执行中」只认 queued/running）。 */
export function hasActiveRun(view: View, workflowId: Id): boolean {
  for (const task of view.tasks.values()) {
    if (task.workflowId === workflowId && view.activeTaskIds.has(task.id)) return true
  }
  return false
}

/** 摘要截断：按码点取前 200 字（与 `protocol/validate` 的 `summary` 上限一致）。 */
export function truncateSummary(summary: string): string {
  const chars = Array.from(summary)
  return chars.length > 200 ? chars.slice(0, 200).join('') : summary
}

/** 聊天 run 终态 → 一条 assistant 消息；用户消息由 `conversation.send` 产。 */
export function chatMessageFacts(
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

/**
 * 外部事件入账 + 规则匹配（M6）：产一条 `event.received`，超过跳数上限只产
 * `event.dropped`（熔断，不建任务）；否则立即按当前规则集建任务。
 */
export function receivedEventFacts(
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
    // M42：命中停用规则也要留痕（补跑的依据），再按启用规则建任务
    ...skippedRuleFacts(view, payload, view.rulesVersion, now),
    ...eventThreadFacts(view, payload, view.rulesVersion, now, env),
  ]
}
