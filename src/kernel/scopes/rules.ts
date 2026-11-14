/**
 * 自动化规则（纯函数，M6）：匹配事件 / cron 到点 / 手动触发 → 建任务。
 *
 * **规则只建任务，不直接派活。** 任务进入阶段后由该阶段的 `entry_mode` 决定交给
 * 智能体、等人、还是停留；外部事件与手工任务因此走同一个工作流引擎。
 *
 * M6.5 起事件归线程：同一 `(source, externalRef)` 的事件进同一线程；线程里已有
 * 未完成任务时默认**复用任务**（在当前阶段追加一轮、run 携带新事件），没有则按规则
 * 目标新建任务。线程当前阶段已有 `queued` run 时改产 `event.merged`（事件追加进
 * `run.eventIds`，不新建 run）。回执派生事件（`originRunId` 非空）按父 run 归线程、
 * 记 `parentTaskId`，总是新建子任务。
 *
 * cron 语义：`clock.tick` 对每条 enabled cron 规则取「上次触发（无则本版 replacedAt）→ now」
 * 之间最近一次到点时刻，只补一次；重复墙钟（秋调）用 `cronLocalKey` 去重。
 * cron / 手动触发拿不到外部入口，按隐式线程处理（`source='manual'`、`externalRef=null`）。
 */
import type { Task } from '../../protocol/entities'
import type { EventReceivedPayload } from '../../protocol/facts'
import type { Input } from '../../protocol/inputs'
import {
  isCronRule,
  type AutomationRule,
  type RuleNextFire,
  type RulePreview,
  type RulePreviewMatch,
  type RuleTarget,
} from '../../protocol/rules'
import type { ThreadRow } from '../../protocol/thread'
import { nextCronTime, parseCron } from '../core/cron'
import type { Actor, Decision, Environment, FactDraft, Id, Iso, View } from '../core/types'
import { entryRunFacts, type RunTrigger } from './task-effects'
import {
  activeTasksOfThread,
  eventAttachedFacts,
  findThreadByKey,
  openThreadRow,
  openedFacts,
  queuedRunOfTask,
  reopenedFacts,
  runCountOfTask,
  taskAttachedFacts,
  threadTitle,
  withEvent,
  withStatus,
  withTask,
} from './threads'

/** 规则引擎产生的自动事实：actor 标为内核（规则是内核逻辑，不是某个插件）。 */
const KERNEL_ACTOR: Actor = { kind: 'kernel' }

/** 手动触发（规则页「立即运行」）由 owner 发起。 */
const OWNER_ACTOR: Actor = { kind: 'owner', via: 'ui' }

/** cron 补跑最多向前回溯的触发次数（防御历史 baseline 过长导致的死循环）。 */
const MAX_CATCHUP_STEPS = 1_000

/** 规则匹配用的事件形状（事实 payload 的子集）。 */
export type RuleEvent = Pick<
  EventReceivedPayload,
  'eventId' | 'source' | 'type' | 'subject' | 'summary' | 'dedupeKey' | 'hops'
>

const reject = (code: 'invalid_input' | 'not_found' | 'conflict', message: string): Decision => ({
  facts: [],
  reject: { code, message },
})

const truncate = (value: string, max: number): string =>
  Array.from(value).length > max ? Array.from(value).slice(0, max).join('') : value

/** type 模式：精确、`*`、前缀 `x.*`。 */
export function ruleTypeMatches(pattern: string, type: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -2) + '.')
  return pattern === type
}

/** 事件条件是否命中（不看 `enabled`）：停用规则也要靠它留痕。 */
function matchesCondition(rule: AutomationRule, event: RuleEvent): boolean {
  if ('cron' in rule.when) return false
  const when = rule.when
  if (when.source !== '*' && when.source !== event.source) return false
  return when.types.some((pattern) => ruleTypeMatches(pattern, event.type))
}

/** 事件是否命中「启用」规则（停用规则的条件命中由 `skippedRuleFacts` 单独记账）。 */
export function ruleMatchesEvent(rule: AutomationRule, event: RuleEvent): boolean {
  return rule.enabled && matchesCondition(rule, event)
}

/**
 * 命中「停用」规则的留痕（M42）：条件命中但规则停用 → 一条 `event.skipped`。
 *
 * 只记账、不建线程/任务；`rule.replay` 在规则恢复后按它补跑。定时规则不参与
 * （没有「被事件跳过」这回事）。
 */
export function skippedRuleFacts(
  view: View,
  event: EventReceivedPayload,
  rulesVersion: number,
  now: Iso,
): FactDraft[] {
  const facts: FactDraft[] = []
  for (const rule of view.rules) {
    if (rule.enabled || !matchesCondition(rule, event)) continue
    facts.push({
      type: 'event.skipped',
      actor: KERNEL_ACTOR,
      at: now,
      payload: {
        eventId: event.eventId,
        ruleId: rule.id,
        version: rulesVersion,
        reason: 'rule-disabled',
      },
    })
  }
  return facts
}

/** 规则入口键：`to.thread.keyFrom`（缺省 subject）。 */
export function externalRefOf(rule: AutomationRule, event: RuleEvent): string {
  const keyFrom = rule.to.thread?.keyFrom ?? 'subject'
  if (keyFrom === 'externalRef') return event.dedupeKey ?? event.subject
  return event.subject
}

/** 目标工作流 / 起始阶段解析；工作流已删或阶段不属于它时返回 null。 */
export function resolveTarget(
  view: View,
  target: RuleTarget,
): { workflowId: Id; stageId: Id | null } | null {
  const workflow = view.workflows.get(target.workflowId)
  if (!workflow) return null
  const stages = [...view.stages.values()]
    .filter((stage) => stage.workflowId === workflow.id)
    .sort((left, right) => left.position - right.position)
  if (target.stageId === undefined) {
    return { workflowId: workflow.id, stageId: stages[0]?.id ?? null }
  }
  const stage = stages.find((candidate) => candidate.id === target.stageId)
  if (!stage) return null
  return { workflowId: workflow.id, stageId: stage.id }
}

/** 已解析的目标（调用方先 `resolveTarget`，避免 buildTask 里再判空）。 */
type ResolvedTarget = { workflowId: Id; stageId: Id | null }

function buildTask(
  env: Environment,
  rule: AutomationRule,
  target: ResolvedTarget,
  title: string,
  description: string,
  externalRef: string | null,
  now: Iso,
  threadId: Id | null,
  parentTaskId: Id | null,
): Task {
  return {
    id: env.nextId('task'),
    title: truncate(title.trim() || rule.name, 200),
    description: truncate(description, 2_000),
    workflowId: target.workflowId,
    // M10：规则声明的项目（老规则没有 → null，界面归入「未归属」）
    projectId: rule.to.projectId ?? null,
    currentStageId: target.stageId,
    status: 'active',
    origin: 'rule',
    ruleId: rule.id,
    externalRef,
    labels: [...(rule.to.task?.labels ?? [])],
    threadId,
    parentTaskId,
    spawnedByRunId: null,
    batchNo: null,
    spawnKey: null,
    handoffFromTaskId: null,
    handoffFromStageId: null,
    handoffFromRunId: null,
    createdAt: now,
    updatedAt: now,
  }
}

function triggerOf(rule: AutomationRule, eventIds: string[], hops: number): RunTrigger {
  return {
    ruleId: rule.id,
    rulesVersion: 0,
    eventIds,
    hops,
    promptExtra: rule.prompt?.trim() || undefined,
  }
}

/** 隐式线程 + 任务 + 入口 run（cron / 手动触发用：没有外部入口，`source='manual'`）。 */
function implicitThreadTaskFacts(
  view: View,
  env: Environment,
  rule: AutomationRule,
  title: string,
  now: Iso,
  actor: Actor,
  rulesVersion: number,
): { task: Task; facts: FactDraft[] } | null {
  const target = resolveTarget(view, rule.to)
  if (target === null) return null
  const thread = openThreadRow(env, { source: 'manual', externalRef: null, title, now })
  const task = buildTask(env, rule, target, title, '', null, now, thread.id, null)
  const attached = withTask(thread, task, now)
  const facts: FactDraft[] = [
    ...openedFacts(thread, actor, now),
    ...taskAttachedFacts(attached, task, rule.id, actor, now),
    { type: 'task.created', actor, at: now, payload: { task } },
    ...entryRunFacts(
      view,
      task,
      now,
      env,
      actor,
      {
        ...triggerOf(rule, [], 0),
        rulesVersion,
      },
      { thread: attached, turn: 1 },
    ),
  ]
  return { task, facts }
}

/**
 * 事件命中规则 → 线程归并 + 建任务 / 复用任务 / 合并事件（同一事件命中多条规则时
 * 逐条处理，不排序；每条规则各自归并，互不合并）。
 */
export function eventThreadFacts(
  view: View,
  event: EventReceivedPayload,
  rulesVersion: number,
  now: Iso,
  env: Environment,
  /** 补跑只应用这一条规则（其余规则的事件早已处理过，不能重复建任务） */
  onlyRuleId?: Id,
): FactDraft[] {
  const facts: FactDraft[] = []
  /** 本批新打开 / 演进的线程行（视图里还没有） */
  const localThreads = new Map<Id, ThreadRow>()
  /** 本批新建的任务（不参与「复用线程里已有任务」判定） */
  const createdTasks = new Set<Id>()
  /** 本批已合并过的 run（同一 run 只合并一次） */
  const mergedRuns = new Set<Id>()
  /** 本批为同一任务追加的 run 数（turn 递增用） */
  const extraRuns = new Map<Id, number>()

  const threadById = (id: Id): ThreadRow | undefined => localThreads.get(id) ?? view.threads.get(id)
  const threadByKey = (source: string, externalRef: string): ThreadRow | undefined => {
    for (const thread of localThreads.values()) {
      if (thread.source === source && thread.externalRef === externalRef) return thread
    }
    return findThreadByKey(view, source, externalRef)
  }

  const parentRun = event.originRunId === null ? undefined : view.runs.get(event.originRunId)
  const parentTask =
    parentRun?.taskId === null || parentRun?.taskId === undefined
      ? undefined
      : view.tasks.get(parentRun.taskId)

  for (const rule of view.rules) {
    if (onlyRuleId !== undefined && rule.id !== onlyRuleId) continue
    if (!ruleMatchesEvent(rule, event)) continue
    // 目标工作流 / 阶段已删：整条规则跳过（不建线程、不产任何事实，与 M6 同口径）
    const taskTarget = resolveTarget(view, rule.to)
    if (taskTarget === null) continue
    const externalRef = externalRefOf(rule, event)

    // 派生事件优先沿用父任务线程（身份仍记该线程）；否则按 (source, externalRef) 找。
    let thread =
      parentTask !== undefined && parentTask.threadId !== null
        ? threadById(parentTask.threadId)
        : undefined
    thread ??= threadByKey(event.source, externalRef)

    if (thread === undefined) {
      thread = openThreadRow(env, {
        source: event.source,
        externalRef,
        title: threadTitle(event.source, event),
        now,
      })
      facts.push(...openedFacts(thread, KERNEL_ACTOR, now))
    } else if (thread.status === 'closed') {
      thread = withStatus(thread, 'open', now)
      facts.push(...reopenedFacts(thread, event.eventId, KERNEL_ACTOR, now))
    }

    if (!thread.events.some((item) => item.eventId === event.eventId)) {
      thread = withEvent(thread, event, now)
      facts.push(...eventAttachedFacts(thread, event, KERNEL_ACTOR, now))
      localThreads.set(thread.id, thread)
    }

    // 复用判定：只看视图里既有的 active 任务（排除本批新建），策略缺省 reuse-task。
    const policy = rule.to.thread?.onExisting ?? 'reuse-task'
    const reusable =
      parentTask === undefined && policy === 'reuse-task'
        ? activeTasksOfThread(view, thread).filter((task) => !createdTasks.has(task.id))
        : []
    const target = reusable.at(-1)

    if (target !== undefined) {
      const queued = queuedRunOfTask(view, target.id)
      if (queued !== undefined && !queued.eventIds.includes(event.eventId)) {
        // 仅 queued run 可合并：事件追加进 run.eventIds，不新建任务 / run
        mergedRuns.add(queued.id)
        facts.push({
          type: 'event.merged',
          actor: KERNEL_ACTOR,
          at: now,
          payload: {
            run: { ...queued, eventIds: [...queued.eventIds, event.eventId] },
            eventId: event.eventId,
          },
        })
      } else {
        // 复用任务：在当前阶段追加一轮（entryRunFacts 自行判定阶段是否 agent 入口）
        const turn = runCountOfTask(view, target.id) + 1 + (extraRuns.get(target.id) ?? 0)
        const runFacts = entryRunFacts(
          view,
          target,
          now,
          env,
          KERNEL_ACTOR,
          { ...triggerOf(rule, [event.eventId], event.hops), rulesVersion },
          { thread, turn },
        )
        if (runFacts.length > 0) extraRuns.set(target.id, (extraRuns.get(target.id) ?? 0) + 1)
        facts.push(...runFacts)
      }
      continue
    }

    // 新建任务（跨线程；派生事件的父任务写入 parentTaskId）。
    const titleFrom = rule.to.task?.titleFrom ?? 'subject'
    const title = titleFrom === 'summary' ? event.summary.trim() || event.subject : event.subject
    const task = buildTask(
      env,
      rule,
      taskTarget,
      title,
      event.summary,
      externalRef,
      now,
      thread.id,
      parentTask?.id ?? null,
    )
    createdTasks.add(task.id)
    const attached = withTask(thread, task, now)
    localThreads.set(attached.id, attached)
    facts.push({ type: 'task.created', actor: KERNEL_ACTOR, at: now, payload: { task } })
    facts.push(...taskAttachedFacts(attached, task, rule.id, KERNEL_ACTOR, now))
    facts.push(
      ...entryRunFacts(
        view,
        task,
        now,
        env,
        KERNEL_ACTOR,
        { ...triggerOf(rule, [event.eventId], event.hops), rulesVersion },
        { thread: attached, turn: 1 },
      ),
    )
  }
  return facts
}

/**
 * cron 到期集合：每条 enabled cron 规则取 `(baseline, now]` 内最近一次到点时刻。
 * `baseline` = 该规则上次触发时刻（无则本版 `replacedAt`）。
 * 返回按规则数组顺序（内核视角不需要再排序）。
 */
export function cronDue(
  view: View,
  now: Iso,
  timezone: string,
): Array<{ rule: AutomationRule; scheduledFor: Iso }> {
  const due: Array<{ rule: AutomationRule; scheduledFor: Iso }> = []
  for (const rule of view.rules) {
    if (!rule.enabled || !isCronRule(rule)) continue
    const spec = parseCron(rule.when.cron)
    if (spec === null) continue
    const lastFired = view.ruleFiredAt.get(rule.id)
    const baseline = lastFired ?? view.ruleSetReplacedAt
    if (baseline === null) continue
    let after = baseline
    let candidate: Iso | null = null
    for (let step = 0; step < MAX_CATCHUP_STEPS; step += 1) {
      const next = nextCronTime(spec, after, timezone)
      if (next === null || next > now) break
      candidate = next
      after = next
    }
    if (candidate !== null) due.push({ rule, scheduledFor: candidate })
  }
  return due
}

/**
 * cron 触发 → 隐式线程 + 任务 + `rule.fired` 事实。
 * 目标工作流 / 阶段已不存在时只记 `rule.fired`（taskId=null），避免每个 tick 反复重试。
 */
export function cronTaskFacts(
  view: View,
  now: Iso,
  env: Environment,
  timezone: string,
): FactDraft[] {
  const facts: FactDraft[] = []
  for (const { rule, scheduledFor } of cronDue(view, now, timezone)) {
    const created = implicitThreadTaskFacts(
      view,
      env,
      rule,
      rule.name,
      now,
      KERNEL_ACTOR,
      view.rulesVersion,
    )
    if (created !== null) facts.push(...created.facts)
    facts.push({
      type: 'rule.fired',
      actor: KERNEL_ACTOR,
      at: now,
      payload: {
        fire: {
          id: env.nextId('rule-fire'),
          ruleId: rule.id,
          version: view.rulesVersion,
          scheduledFor,
          firedAt: now,
          taskId: created?.task.id ?? null,
        },
      },
    })
  }
  return facts
}

/**
 * 补跑被停用规则跳过的事件（M42）。
 *
 * 顺序：按 `skippedAt` 升序逐条重放；每条的线程/任务落进**影子视图**，下一条能看见
 * 上一条刚建的线程与任务——否则同一入口的连续事件会各建一个同名线程（`(source,
 * external_ref)` 唯一）。补跑只应用本条规则（`onlyRuleId`），不重复跑其它规则。
 *
 * 每条补跑都产 `rule.replayed`（含 `taskId`，目标失效时 null）：投影把跳过行标成
 * 已补跑，重复提交因此零事实。
 */
export function replayRule(
  view: View,
  input: Extract<Input, { type: 'rule.replay' }>,
  now: Iso,
  env: Environment,
): Decision {
  const rule = view.rules.find((candidate) => candidate.id === input.ruleId)
  if (rule === undefined) return reject('not_found', '规则不存在: ' + input.ruleId)
  if (!rule.enabled) return reject('conflict', '规则已停用，先恢复再补跑: ' + rule.name)
  if (isCronRule(rule)) return reject('conflict', '定时规则没有可补跑的事件: ' + rule.name)

  const shadow: View = { ...view, threads: new Map(view.threads), tasks: new Map(view.tasks) }
  const facts: FactDraft[] = []
  const skips = [...view.ruleSkips]
    .filter((skip) => skip.ruleId === rule.id)
    .sort((left, right) =>
      left.skippedAt < right.skippedAt ? -1 : left.skippedAt > right.skippedAt ? 1 : 0,
    )

  for (const skip of skips) {
    const event = shadow.events.get(skip.eventId)
    if (event === undefined) continue
    if (input.since !== undefined && event.receivedAt < input.since) continue
    if (input.until !== undefined && event.receivedAt > input.until) continue

    const payload: EventReceivedPayload = {
      eventId: event.id,
      source: event.source,
      type: event.type,
      subject: event.subject,
      summary: event.summary,
      detailRef: event.detailRef,
      link: event.link,
      hops: event.hops,
      originRunId: event.originRunId,
      dedupeKey: event.dedupeKey,
    }
    const produced = eventThreadFacts(shadow, payload, view.rulesVersion, now, env, rule.id)
    applyDrafts(shadow, produced)
    const created = produced.find((fact) => fact.type === 'task.created')
    const taskId = created === undefined ? null : (created.payload as { task: { id: Id } }).task.id
    facts.push(...produced)
    facts.push({
      type: 'rule.replayed',
      actor: KERNEL_ACTOR,
      at: now,
      payload: {
        ruleId: rule.id,
        eventId: event.id,
        taskId,
        skipped: {
          id: `${rule.id}:${event.id}`,
          ruleId: rule.id,
          eventId: event.id,
          version: skip.version,
          skippedAt: skip.skippedAt,
          replayedAt: now,
        },
      },
    })
  }

  return { facts }
}

/** 把一批事实里「整行携带实体」的部分折进影子视图（补跑按顺序累加用）。 */
function applyDrafts(view: View, facts: readonly FactDraft[]): void {
  for (const fact of facts) {
    switch (fact.type) {
      case 'thread.opened':
      case 'thread.event_attached':
      case 'thread.task_attached':
      case 'thread.reopened': {
        const thread = (fact.payload as { thread: ThreadRow }).thread
        view.threads.set(thread.id, thread)
        break
      }
      case 'task.created': {
        const task = (fact.payload as { task: Task }).task
        view.tasks.set(task.id, task)
        break
      }
      default:
        break
    }
  }
}
/**
 * 规则预演（M36-F）：纯函数、零事实。
 *
 * 与真实匹配共用 `matchesCondition` 与 `resolveTarget`，避免「预演说会接、实际不接」。
 * 定时规则不参与（没有事件可言）；停用规则列出但 `enabled:false`。
 */
export function previewEvent(
  view: View,
  event: { source: string; type: string; subject: string; summary?: string | null },
): RulePreview {
  // 匹配只需要 source/type/subject；补上 RuleEvent 的其余字段（预演不入账，取值无副作用）
  const sample: RuleEvent = {
    source: event.source,
    type: event.type,
    subject: event.subject,
    summary: event.summary ?? '',
    hops: 1,
    dedupeKey: null,
    eventId: 'preview',
  }
  const matches: RulePreviewMatch[] = []
  for (const rule of view.rules) {
    if (!matchesCondition(rule, sample)) continue
    const target = resolveTarget(view, rule.to)
    const titleFrom = rule.to.task?.titleFrom ?? 'subject'
    const summary = (event.summary ?? '').trim()
    const title = titleFrom === 'summary' && summary !== '' ? summary : event.subject
    matches.push({
      ruleId: rule.id,
      ruleName: rule.name,
      enabled: rule.enabled,
      workflowId: target === null ? null : target.workflowId,
      stageId: target === null ? null : target.stageId,
      title,
      threadKey: externalRefOf(rule, sample),
    })
  }
  return {
    matches,
    wouldCreate: matches.some((match) => match.enabled && match.workflowId !== null),
  }
}

/** 定时规则的下一次触发（M36）：显示用；停用 / 表达式非法 / 已无未来时刻给 null。 */
export function nextRuleFires(view: View, now: Iso, timezone: string): RuleNextFire[] {
  return view.rules.map((rule) => {
    if (!rule.enabled || !isCronRule(rule)) {
      return { ruleId: rule.id, enabled: rule.enabled, nextAt: null }
    }
    const spec = parseCron(rule.when.cron)
    return {
      ruleId: rule.id,
      enabled: rule.enabled,
      nextAt: spec === null ? null : nextCronTime(spec, now, timezone),
    }
  })
}
/** 手动立即运行一条规则：隐式线程 + 任务（不依赖事件、externalRef=null）。 */
export function manualTriggerFacts(view: View, ruleId: Id, now: Iso, env: Environment): Decision {
  const rule = view.rules.find((candidate) => candidate.id === ruleId)
  if (rule === undefined) return reject('not_found', '规则不存在: ' + ruleId)
  if (!rule.enabled) return reject('conflict', '规则已停用: ' + rule.name)
  const created = implicitThreadTaskFacts(
    view,
    env,
    rule,
    rule.name,
    now,
    OWNER_ACTOR,
    view.rulesVersion,
  )
  if (created === null) return reject('conflict', '规则目标工作流或阶段不存在: ' + rule.name)
  return { facts: created.facts }
}

/**
 * 整批规则校验（`rules.replace`）：任一条非法返回错误文案，调用方整批 reject。
 * 形状上限由 `protocol/validate` 已挡一层；这里补语义（引用存在、cron 可解析、id 唯一）。
 */
export function validateRuleBatch(
  view: View,
  rules: readonly AutomationRule[],
): { rules: AutomationRule[]; version: number } | { error: string } {
  const ids = new Set<string>()
  const normalized: AutomationRule[] = []
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    if (rule === undefined) return { error: `规则 ${index + 1}: 缺失` }
    const id = rule.id.trim()
    const name = rule.name.trim()
    if (id === '') return { error: `规则 ${index + 1}: id 必填` }
    if (ids.has(id)) return { error: `规则 id 重复: ${id}` }
    ids.add(id)
    if (name === '') return { error: `规则 ${index + 1}: 名称必填` }
    const whenError = validateWhen(rule, name)
    if (whenError !== null) return { error: whenError }
    if (!view.workflows.has(rule.to.workflowId)) {
      return { error: `规则「${name}」: 工作流不存在: ${rule.to.workflowId}` }
    }
    if (rule.to.stageId !== undefined) {
      const stage = view.stages.get(rule.to.stageId)
      if (!stage || stage.workflowId !== rule.to.workflowId) {
        return { error: `规则「${name}」: 起始阶段不属于该工作流: ${rule.to.stageId}` }
      }
    }
    // M10：规则任务的所属项目必须存在（老规则缺省 → 不校验，任务落在「未归属」）
    if (rule.to.projectId !== undefined && !view.projects.has(rule.to.projectId)) {
      return { error: `规则「${name}」: 项目不存在: ${rule.to.projectId}` }
    }
    normalized.push({ ...rule, id, name })
  }
  return { rules: normalized, version: view.rulesVersion + 1 }
}

function validateWhen(rule: AutomationRule, name: string): string | null {
  if ('cron' in rule.when) {
    const expression = rule.when.cron.trim()
    if (expression === '') return `规则「${name}」: cron 必填`
    if (parseCron(expression) === null) return `规则「${name}」: cron 表达式非法: ${expression}`
    return null
  }
  const when = rule.when
  if (when.source.trim() === '') return `规则「${name}」: source 必填`
  if (when.types.length === 0) return `规则「${name}」: types 至少 1 项`
  return null
}
