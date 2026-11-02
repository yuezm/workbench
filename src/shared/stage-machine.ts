import type { Task, WorkflowStage, WorkflowWithStages } from './ai-workflow-api'

/** 进入某阶段后需要执行的效果（由 runner / UI 实际落地）。 */
export type StageEffect =
  { type: 'createRun'; stageId: string; agentId: string } | { type: 'waitUser' } | { type: 'none' }

/** 阶段流转事件。 */
export type StageEvent =
  | { type: 'RUN_SUCCEEDED'; runId: string }
  | { type: 'RUN_FAILED'; runId: string }
  | { type: 'APPROVE' }
  | { type: 'REJECT' }
  | { type: 'MOVE_NEXT' }

/** 读取某阶段「进入时」应产生的效果。 */
export function entryEffects(stage: WorkflowStage): StageEffect[] {
  switch (stage.entryMode) {
    case 'agent':
      return stage.agentId ? [{ type: 'createRun', stageId: stage.id, agentId: stage.agentId }] : []
    case 'user':
      return [{ type: 'waitUser' }]
    default:
      return [{ type: 'none' }]
  }
}

function indexOfStage(workflow: WorkflowWithStages, stage: WorkflowStage): number {
  return workflow.stages.findIndex((s) => s.id === stage.id)
}

/** 完成后进入的目标阶段；无下一阶段返回 null（表示任务完成）。 */
export function resolveNextStage(
  stage: WorkflowStage,
  workflow: WorkflowWithStages,
): WorkflowStage | null {
  if (stage.onCompleteStageId) {
    return workflow.stages.find((s) => s.id === stage.onCompleteStageId) ?? null
  }
  const idx = indexOfStage(workflow, stage)
  return idx >= 0 ? (workflow.stages[idx + 1] ?? null) : null
}

/** 打回退回到的目标阶段；未配置且已是首阶段则留在原地。 */
export function resolveRejectStage(
  stage: WorkflowStage,
  workflow: WorkflowWithStages,
): WorkflowStage {
  if (stage.onRejectStageId) {
    const target = workflow.stages.find((s) => s.id === stage.onRejectStageId)
    if (target) return target
  }
  const idx = indexOfStage(workflow, stage)
  return idx > 0 ? workflow.stages[idx - 1] : stage
}

/** 进入阶段：产出新任务态与效果。 */
export function enterStage(
  task: Task,
  stage: WorkflowStage,
  _workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] } {
  return {
    task: { ...task, currentStageId: stage.id, status: 'active' },
    effects: entryEffects(stage),
  }
}

/**
 * 纯函数：根据事件推进任务到新阶段。
 * 不读写数据库、不 spawn；由调用方执行返回的 effects 并持久化 task。
 */
export function moveTask(
  task: Task,
  event: StageEvent,
  workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] } {
  const current = workflow.stages.find((s) => s.id === task.currentStageId)
  if (!current || task.status === 'completed') {
    return { task, effects: [] }
  }

  const toNext = (): { task: Task; effects: StageEffect[] } => {
    const next = resolveNextStage(current, workflow)
    if (!next) return { task: { ...task, status: 'completed' }, effects: [] }
    return enterStage({ ...task, status: 'active' }, next, workflow)
  }
  const toReject = (): { task: Task; effects: StageEffect[] } => {
    const target = resolveRejectStage(current, workflow)
    return enterStage({ ...task, status: 'active' }, target, workflow)
  }

  switch (event.type) {
    case 'RUN_SUCCEEDED':
    case 'APPROVE':
    case 'MOVE_NEXT':
      return toNext()
    case 'RUN_FAILED':
    case 'REJECT':
      return toReject()
  }
}
