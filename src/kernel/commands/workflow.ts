/**
 * 工作流命令（R2 从 `decide.ts` 拆出，行为不变；M18 加内置阶段）。
 */
import type {
  BuiltinStageKey,
  JudgeConfig,
  StageExits,
  StageInput,
  Workflow,
  WorkflowStage,
} from '../../protocol/entities'
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, FactDraft, Id, Iso, View } from '../types'
import { validateStageHandoffs } from '../handoff'
import {
  builtinStageInput,
  orderStagesByBuiltin,
  resolveBuiltinStages,
} from '../workflow/builtin-stages'
import { validateStageSet } from '../workflow/stage-validation'
import { sameHandoffs } from '../workflow/stage-handoffs'
import { normalizeAcceptance, sameAcceptance } from '../workflow/acceptance'
import { done, hasActiveRun, ownerDraft, reject, runsOfTask, stagesOf, tasksOf } from './common'

function stageRow(
  workflowId: Id,
  id: Id,
  ids: Id[],
  stage: StageInput,
  position: number,
  builtin: BuiltinStageKey | null,
): WorkflowStage {
  return {
    id,
    workflowId,
    name: stage.name.trim(),
    position,
    entryMode: stage.entryMode,
    builtin,
    agentId: stage.agentId ?? null,
    // M32：出口表按下标映射到 id；缺省的触发条件由 completeExits 在排序后补齐
    exits: exitsOf(ids, stage),
    // M29：派单按触发条件分组直存（跨工作流，不能用本批下标表达）
    handoffs: [...(stage.handoffs ?? [])],
    // M8：子任务落点 / rollup / 派发策略原样落行（null = 按默认推断）
    subtaskStageId: stage.subtaskStageId ?? null,
    onChildrenSettled: stage.onChildrenSettled ?? null,
    spawnPolicy: stage.spawnPolicy ?? null,
    // M9：阶段要干什么，去首尾空白后存；空串表示没写
    instructions: stage.instructions?.trim() ?? '',
    // M20/M34：验收条目归一（去空 / 去重 / 截断）；只有闸门阶段允许非空（validateStageSet 挡）
    acceptance: normalizeAcceptance(stage.acceptance),
    // M26：阶段单轮超时（毫秒；缺省 = null，用全局缺省）
    runTimeoutMs: stage.runTimeoutMs ?? null,
    // M32：判定者只回答「谁给结论 + 护栏多大」，去向在 exits 里
    judge: stage.judge ? { maxFails: stage.judge.maxFails ?? null } : null,
  }
}

/**
 * 下标 → 阶段 id；`validateStageSet` 已保证下标在范围内。
 *
 * 导出到模块级：下标越界这一支在产品路径上不可达（校验先挡住了），
 * 但判定本身要能测——导出后由单测直接构造越界下标覆盖（逻辑与调用点均不变）。
 */
/** 出口表：输入行（下标）→ 行内形状（id）。 */
function exitsOf(ids: Id[], stage: StageInput): StageExits {
  const exits: StageExits = {}
  for (const exit of stage.exits ?? []) {
    if (exit.do === 'goto') {
      const stageId = indexTarget(ids, exit.stageIndex)
      if (stageId !== null) exits[exit.on] = { do: 'goto', stageId }
      continue
    }
    exits[exit.on] = { do: exit.do }
  }
  return exits
}

export function indexTarget(ids: Id[], index: number | null | undefined): Id | null {
  if (index === null || index === undefined) return null
  return ids[index] ?? null
}

/**
 * 阶段「要干什么」的深比较（M9）：缺省与空串视为同值。
 *
 * 单独成函数是为了让「缺省」这一支能被单测直接覆盖（投影归一时恒为字符串）。
 */
export function sameInstructions(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return (a ?? '') === (b ?? '')
}

/** 判定者深比较（M32）：漏比较会让「改了护栏保存无效」。缺省与 null 视为同值。 */
export function sameJudge(
  a: JudgeConfig | null | undefined,
  b: JudgeConfig | null | undefined,
): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === null || right === null) return left === right
  return left.maxFails === right.maxFails
}

/** 出口表深比较（M32）：逐组比较动作与目标，缺省与「没有这一组」同值。 */
export function sameExits(a: StageExits | undefined, b: StageExits | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const guards = new Set([...Object.keys(left), ...Object.keys(right)])

  for (const guard of guards) {
    const one = left[guard as keyof StageExits]
    const other = right[guard as keyof StageExits]
    if (one === undefined || other === undefined) {
      if (one !== other) return false
      continue
    }
    if (one.do !== other.do) return false
    if (one.do === 'goto' && other.do === 'goto' && one.stageId !== other.stageId) return false
  }
  return true
}

function sameStage(a: WorkflowStage, b: WorkflowStage): boolean {
  return (
    a.id === b.id &&
    a.workflowId === b.workflowId &&
    a.name === b.name &&
    a.position === b.position &&
    a.entryMode === b.entryMode &&
    // M18：内置键一变就要落 stage.updated（否则锁名 / 锁位的修复会被静默吞掉）
    (a.builtin ?? null) === (b.builtin ?? null) &&
    a.agentId === b.agentId &&
    // M32：出口表一变就要落 stage.updated（缺省与「没有这一组」视为同值）
    sameExits(a.exits, b.exits) &&
    // M29：派单清单一变就要落 stage.updated（缺省与空数组视为同值）
    sameHandoffs(a.handoffs, b.handoffs) &&
    // M8：子任务三列同理（缺省与 null 视为同值）
    (a.subtaskStageId ?? null) === (b.subtaskStageId ?? null) &&
    (a.onChildrenSettled ?? null) === (b.onChildrenSettled ?? null) &&
    (a.spawnPolicy ?? null) === (b.spawnPolicy ?? null) &&
    // M9：阶段要干什么（缺省与空串视为同值）
    sameInstructions(a.instructions, b.instructions) &&
    // M20/M34：验收条目一变就要落 stage.updated（缺省与空数组视为同值）
    sameAcceptance(a.acceptance, b.acceptance) &&
    // M26：阶段超时一变要落 stage.updated（缺省与 null 视为同值）
    (a.runTimeoutMs ?? null) === (b.runTimeoutMs ?? null) &&
    // M32：判定者一变就要落 stage.updated
    sameJudge(a.judge, b.judge)
  )
}

/** 阶段绑定的智能体是否都能在视图里找到（旧实现靠外键，M1 由内核前置校验）。 */
function missingAgentId(view: View, stages: StageInput[]): Id | null {
  for (const stage of stages) {
    if (stage.agentId && !view.agents.has(stage.agentId)) return stage.agentId
  }
  return null
}

/** 一个待落行的阶段：内置键 + 按最终 position 造行（还原的内置行原样复用）。 */
interface StageEntry {
  builtin: BuiltinStageKey | null
  row: (position: number) => WorkflowStage
}

/**
 * 提交的阶段 + 补齐的内置阶段 → 规范顺序的待落行阶段。
 *
 * `builtins.keys[i]` 与 `inputs[i]` 一一对应；`missing` 里的内置阶段：
 * 更新时优先按既有行还原（保留原 id / 配置），新建时用默认值。
 */
function stageEntries(
  inputs: readonly StageInput[],
  ids: Id[],
  keys: Array<BuiltinStageKey | null>,
  missing: readonly BuiltinStageKey[],
  existing: readonly WorkflowStage[] | null,
  workflowId: Id,
  nextId: () => Id,
): StageEntry[] {
  const byBuiltin = new Map<BuiltinStageKey, WorkflowStage>()
  for (const stage of existing ?? []) {
    if (stage.builtin) byBuiltin.set(stage.builtin, stage)
  }
  const submitted: StageEntry[] = inputs.map((input, index) => ({
    builtin: keys[index],
    row: (position) => stageRow(workflowId, ids[index], ids, input, position, keys[index] ?? null),
  }))
  const restored: StageEntry[] = missing.map((key) => {
    const previous = byBuiltin.get(key)
    // 还原：字段原样保留，只有位置由规范顺序决定
    if (previous !== undefined) {
      return { builtin: key, row: (position) => ({ ...previous, position }) }
    }
    const id = nextId()
    const input = builtinStageInput(key)
    return {
      builtin: key,
      row: (position) => stageRow(workflowId, id, [], input, position, key),
    }
  })
  return orderStagesByBuiltin([...submitted, ...restored])
}

export function createWorkflow(
  view: View,
  input: Extract<Input, { type: 'workflow.create' }>,
  now: Iso,
  env: Environment,
): Decision {
  const form = input.input
  const name = form.name?.trim()
  if (!name) return reject('invalid_input', '工作流名称必填')
  const invalid = validateStageSet(form.stages)
  if (invalid) return reject('invalid_input', invalid)
  // M18：内置阶段（待办 / 已阻塞 / 已完成 / 已取消）由系统保证存在，改名、重复直接拒
  const resolved = resolveBuiltinStages(form.stages, null)
  if (resolved.error) return reject('invalid_input', resolved.error)
  const missingAgent = missingAgentId(view, form.stages)
  if (missingAgent) return reject('not_found', '智能体不存在: ' + missingAgent)
  const workflowId = env.nextId('workflow')
  // M7：交接目标必须存在且 ≠ 自身、目标阶段属于目标工作流（保存时校验，读时再防御）
  const handoffError = validateStageHandoffs(view, workflowId, form.stages, resolved.keys)
  if (handoffError) return reject('invalid_input', handoffError)
  const ids = form.stages.map(() => env.nextId('stage'))
  const entries = stageEntries(
    form.stages,
    ids,
    resolved.keys,
    resolved.missing,
    null,
    workflowId,
    () => env.nextId('stage'),
  )
  const workflow: Workflow = {
    id: workflowId,
    name,
    description: form.description ?? '',
    createdAt: now,
  }
  const facts: FactDraft[] = [ownerDraft('workflow.created', { workflow }, now)]
  // M32：出口表只存**显式配的**去向；缺省由决策时的 completeExits 按顺序解析（唯一一份缺省规则）
  const rows = entries.map((entry, position) => entry.row(position))
  for (const row of rows) facts.push(ownerDraft('stage.created', { stage: row }, now))
  return done(facts)
}

export function updateWorkflow(
  view: View,
  input: Extract<Input, { type: 'workflow.update' }>,
  now: Iso,
  env: Environment,
): Decision {
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
  const existing = stagesOf(view, current.id)
  // M18：内置阶段删不掉——缺的按既有行原样还原；改名 / 换类别 / 终态交接直接拒
  const resolved = resolveBuiltinStages(form.stages, existing)
  if (resolved.error) return reject('invalid_input', resolved.error)
  const missingAgent = missingAgentId(view, form.stages)
  if (missingAgent) return reject('not_found', '智能体不存在: ' + missingAgent)
  // M7：交接目标工作流 / 阶段的存在与从属（自指在保存时就拒绝）
  const handoffError = validateStageHandoffs(view, current.id, form.stages, resolved.keys)
  if (handoffError) return reject('invalid_input', handoffError)

  // 阶段 id 差量：回传的 id 保留，缺省 id 拿新 id，未出现在提交集合里的旧阶段 tombstone。
  const existingById = new Map(existing.map((stage) => [stage.id, stage]))
  const refs: Array<Id | null> = []
  const claimed = new Set<Id>()
  for (const stage of form.stages) {
    const ref = stage.id?.trim() || null
    if (ref !== null) {
      if (claimed.has(ref)) return reject('conflict', '阶段 id 重复: ' + ref)
      // 带上阶段名：只给一个 uuid 时用户无从判断该改哪里（典型成因是编辑期间别处删过阶段）
      if (!existingById.has(ref)) {
        return reject(
          'conflict',
          `阶段「${stage.name.trim()}」已不存在（${ref}），工作流可能已在别处被修改`,
        )
      }
      claimed.add(ref)
    }
    refs.push(ref)
  }
  const ids = refs.map((ref) => ref ?? env.nextId('stage'))
  const entries = stageEntries(
    form.stages,
    ids,
    resolved.keys,
    resolved.missing,
    existing,
    current.id,
    () => env.nextId('stage'),
  )
  const rows = entries.map((entry, position) => entry.row(position))
  const nextIds = new Set(rows.map((row) => row.id))
  const removed = existing.filter((stage) => !nextIds.has(stage.id))

  const workflow: Workflow = {
    id: current.id,
    name,
    description: form.description ?? current.description,
    createdAt: current.createdAt,
  }
  const facts: FactDraft[] = [ownerDraft('workflow.updated', { workflow }, now)]
  // 先删旧阶段腾出 position：`workflow_stages` 有 UNIQUE(workflow_id, position)
  for (const stage of removed) facts.push(ownerDraft('stage.deleted', { stage }, now))
  for (const row of rows) {
    const previous = existingById.get(row.id)
    if (previous && !sameStage(previous, row)) {
      facts.push(ownerDraft('stage.updated', { stage: row }, now))
    }
  }
  for (const row of rows) {
    if (!existingById.has(row.id)) facts.push(ownerDraft('stage.created', { stage: row }, now))
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
      ownerDraft(
        'task.moved',
        {
          task: { ...task, currentStageId: target.id },
          from: stageId,
          to: target.id,
        },
        now,
      ),
    )
  }
  return done(facts)
}

export function removeWorkflow(
  view: View,
  input: Extract<Input, { type: 'workflow.remove' }>,
  now: Iso,
): Decision {
  const current = view.workflows.get(input.id)
  if (!current) return done([])
  const facts: FactDraft[] = [ownerDraft('workflow.removed', { workflow: current }, now)]
  // 不依赖 SQL 级联：重建时会临时关外键，级联删除必须由事实显式表达
  for (const stage of stagesOf(view, current.id)) {
    facts.push(ownerDraft('stage.deleted', { stage }, now))
  }
  for (const task of tasksOf(view, current.id)) {
    // D13：run 删除必须由事实显式表达（重建时外键级联不可用），先删 run 再删任务
    for (const run of runsOfTask(view, task.id)) {
      facts.push(ownerDraft('run.removed', { runId: run.id }, now))
    }
    facts.push(ownerDraft('task.removed', { task }, now))
  }
  return done(facts)
}
