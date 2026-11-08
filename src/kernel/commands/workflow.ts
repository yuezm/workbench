/**
 * 工作流命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { GateConfig, StageInput, Workflow, WorkflowStage } from '../../protocol/entities'
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, FactDraft, Id, Iso, View } from '../types'
import { validateStageHandoffs } from '../handoff'
import { validateStageSet } from '../workflow/stage-validation'
import { done, hasActiveRun, ownerDraft, reject, runsOfTask, stagesOf, tasksOf } from './common'

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
    // M8：子任务落点 / rollup / 派发策略原样落行（null = 按默认推断）
    subtaskStageId: stage.subtaskStageId ?? null,
    onChildrenSettled: stage.onChildrenSettled ?? null,
    spawnPolicy: stage.spawnPolicy ?? null,
    // M9：阶段要干什么，去首尾空白后存；空串表示没写
    instructions: stage.instructions?.trim() ?? '',
    // M11：闸门按 id 直存（下标已由 `validateStageSet` 保证在范围内）
    gate: stage.gate
      ? {
          maxFails: stage.gate.maxFails,
          onPassStageId: indexTarget(ids, stage.gate.onPassIndex),
          onFailStageId: indexTarget(ids, stage.gate.onFailIndex),
        }
      : null,
  }
}

/** 下标 → 阶段 id；`validateStageSet` 已保证下标在范围内。 */
function indexTarget(ids: Id[], index: number | null | undefined): Id | null {
  if (index === null || index === undefined) return null
  return ids[index] ?? null
}

/** 闸门深比较（M11）：漏比较会让「改了闸门配置保存无效」。缺省与 null 视为同值。 */
function sameGate(a: GateConfig | null | undefined, b: GateConfig | null | undefined): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === null || right === null) return left === right
  return (
    left.maxFails === right.maxFails &&
    left.onPassStageId === right.onPassStageId &&
    left.onFailStageId === right.onFailStageId
  )
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
    a.handoffStageId === b.handoffStageId &&
    // M8：子任务三列同理（缺省与 null 视为同值）
    (a.subtaskStageId ?? null) === (b.subtaskStageId ?? null) &&
    (a.onChildrenSettled ?? null) === (b.onChildrenSettled ?? null) &&
    (a.spawnPolicy ?? null) === (b.spawnPolicy ?? null) &&
    // M9：阶段要干什么（缺省与空串视为同值）
    (a.instructions ?? '') === (b.instructions ?? '') &&
    // M11：闸门三列一变就要落 stage.updated
    sameGate(a.gate, b.gate)
  )
}

/** 阶段绑定的智能体是否都能在视图里找到（旧实现靠外键，M1 由内核前置校验）。 */
function missingAgentId(view: View, stages: StageInput[]): Id | null {
  for (const stage of stages) {
    if (stage.agentId && !view.agents.has(stage.agentId)) return stage.agentId
  }
  return null
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
  const facts: FactDraft[] = [ownerDraft('workflow.created', { workflow }, now)]
  form.stages.forEach((stage, position) => {
    facts.push(
      ownerDraft('stage.created', { stage: stageRow(workflowId, stageIds, stage, position) }, now),
    )
  })
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
