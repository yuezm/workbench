/**
 * 自动化规则（纯函数，M6）：匹配事件 / cron 到点 / 手动触发 → 建任务。
 *
 * **规则只建任务，不直接派活。** 任务进入阶段后由该阶段的 `entry_mode` 决定交给
 * 智能体、等人、还是停留；外部事件与手工任务因此走同一个工作流引擎。
 *
 * 去重：同一规则 + 同一入口键（`to.thread.keyFrom`，缺省 `subject`）已有 active 任务时
 * 不再建任务（事件仍入账）。线程归并 / 事件合并 / 线程上下文属 M6.5，本阶段不实现。
 *
 * cron 语义：`clock.tick` 对每条 enabled cron 规则取「上次触发（无则本版 replacedAt）→ now」
 * 之间最近一次到点时刻，只补一次；重复墙钟（秋调）用 `cronLocalKey` 去重。
 */
import type { Task } from '../protocol/entities'
import type { EventReceivedPayload } from '../protocol/facts'
import { isCronRule, type AutomationRule, type RuleTarget } from '../protocol/rules'
import { nextCronTime, parseCron } from './cron'
import type { Actor, Decision, Environment, FactDraft, Id, Iso, View } from './types'
import { entryRunFacts, type RunTrigger } from './task-effects'

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

/** 事件是否命中规则（enabled 由调用方先过滤也可，这里统一判）。 */
export function ruleMatchesEvent(rule: AutomationRule, event: RuleEvent): boolean {
  if (!rule.enabled || 'cron' in rule.when) return false
  const when = rule.when
  if (when.source !== '*' && when.source !== event.source) return false
  return when.types.some((pattern) => ruleTypeMatches(pattern, event.type))
}

/** 规则入口键：`to.thread.keyFrom`（缺省 subject）。 */
export function externalRefOf(rule: AutomationRule, event: RuleEvent): string {
  const keyFrom = rule.to.thread?.keyFrom ?? 'subject'
  if (keyFrom === 'externalRef') return event.dedupeKey ?? event.subject
  return event.subject
}

/** 同规则 + 同入口键是否已有 active 任务（只对 active 去重：完成后新事件可再建任务）。 */
function existingTask(view: View, ruleId: Id, externalRef: string): Task | undefined {
  for (const task of view.tasks.values()) {
    if (task.status !== 'active') continue
    if (task.ruleId === ruleId && task.externalRef === externalRef) return task
  }
  return undefined
}

/** 目标工作流 / 起始阶段解析；工作流已删或阶段不属于它时返回 null。 */
function resolveTarget(
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

function buildTask(
  view: View,
  env: Environment,
  rule: AutomationRule,
  title: string,
  description: string,
  externalRef: string | null,
  now: Iso,
): Task | null {
  const target = resolveTarget(view, rule.to)
  if (target === null) return null
  return {
    id: env.nextId('task'),
    title: truncate(title.trim() || rule.name, 200),
    description: truncate(description, 2_000),
    workflowId: target.workflowId,
    currentStageId: target.stageId,
    status: 'active',
    origin: 'rule',
    ruleId: rule.id,
    externalRef,
    labels: [...(rule.to.task?.labels ?? [])],
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

/**
 * 事件命中规则 → 建任务（同一事件命中多条规则时全部建，不排序）。
 * `rulesVersion` 写进 run 的 `rulesVersion` 与规则 prompt 无关，只做追溯。
 */
export function eventTaskFacts(
  view: View,
  event: RuleEvent,
  rulesVersion: number,
  now: Iso,
  env: Environment,
): FactDraft[] {
  const facts: FactDraft[] = []
  for (const rule of view.rules) {
    if (!ruleMatchesEvent(rule, event)) continue
    const externalRef = externalRefOf(rule, event)
    if (existingTask(view, rule.id, externalRef) !== undefined) continue
    const titleFrom = rule.to.task?.titleFrom ?? 'subject'
    const title = titleFrom === 'summary' ? event.summary.trim() || event.subject : event.subject
    const task = buildTask(view, env, rule, title, event.summary, externalRef, now)
    if (task === null) continue
    const trigger: RunTrigger = {
      ...triggerOf(rule, [event.eventId], event.hops),
      rulesVersion,
    }
    facts.push({ type: 'task.created', actor: KERNEL_ACTOR, at: now, payload: { task } })
    facts.push(...entryRunFacts(view, task, now, env, KERNEL_ACTOR, trigger))
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
 * cron 触发 → 任务 + `rule.fired` 事实。
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
    const task = buildTask(view, env, rule, rule.name, '', null, now)
    if (task !== null) {
      facts.push({ type: 'task.created', actor: KERNEL_ACTOR, at: now, payload: { task } })
      facts.push(
        ...entryRunFacts(view, task, now, env, KERNEL_ACTOR, {
          ...triggerOf(rule, [], 0),
          rulesVersion: view.rulesVersion,
        }),
      )
    }
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
          taskId: task?.id ?? null,
        },
      },
    })
  }
  return facts
}

/** 手动立即运行一条规则：直接建任务（不依赖事件、externalRef=null）。 */
export function manualTriggerFacts(view: View, ruleId: Id, now: Iso, env: Environment): Decision {
  const rule = view.rules.find((candidate) => candidate.id === ruleId)
  if (rule === undefined) return reject('not_found', '规则不存在: ' + ruleId)
  if (!rule.enabled) return reject('conflict', '规则已停用: ' + rule.name)
  const task = buildTask(view, env, rule, rule.name, '', null, now)
  if (task === null) return reject('conflict', '规则目标工作流或阶段不存在: ' + rule.name)
  const facts: FactDraft[] = [
    { type: 'task.created', actor: OWNER_ACTOR, at: now, payload: { task } },
    ...entryRunFacts(view, task, now, env, OWNER_ACTOR, {
      ruleId: rule.id,
      rulesVersion: view.rulesVersion,
      eventIds: [],
      hops: 0,
      promptExtra: rule.prompt?.trim() || undefined,
    }),
  ]
  return { facts }
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
