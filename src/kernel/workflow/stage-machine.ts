import type { GateVerdict, Task, WorkflowStage, WorkflowWithStages } from '../../protocol/entities'

/** 进入某阶段后需要执行的效果（由 runner / UI 实际落地）。 */
export type StageEffect =
  { type: 'createRun'; stageId: string; agentId: string } | { type: 'waitUser' } | { type: 'none' }

/**
 * 阶段流转事件（只含自动流转；手动流转走 moveTaskToStage / completeTask）。
 *
 * `verdict` 只对闸门阶段有意义（M11）：`run.status='succeeded'` 说明执行器跑完了，
 * `verdict` 才说明业务上过没过。缺省 = 没给结论，任务原地停住等人。
 */
export type StageEvent =
  | { type: 'RUN_SUCCEEDED'; runId: string; verdict?: GateVerdict }
  | { type: 'RUN_FAILED'; runId: string }

/** 阶段退出的描述：`to=null` = 任务完成（移出看板）。 */
export interface StageExit {
  /** 离开的阶段 */
  from: WorkflowStage
  /** 落地阶段；null = 完成（无下一阶段） */
  to: WorkflowStage | null
  /**
   * 是否由「成功」产生：run 成功流转 / 人工完成 / 向前拖拽为 true；
   * 打回（run 失败）与删阶段重挂为 false。
   */
  succeeded: boolean
}

/** 流转结果；`gateExhausted` 供调用方打「闸门放行」留痕（M11）。 */
export interface MoveResult {
  task: Task
  effects: StageEffect[]
  /** 闸门预算耗尽后按配置放行：本次是 fail 但走了通过分支 */
  gateExhausted?: boolean
}

/**
 * 纯函数（M7）：这次离开当前阶段是否算「向前完成」——跨工作流交接的唯一触发判定。
 *
 * - 成功流转到更后阶段 / 任务完成 → true；
 * - 打回（含 `onReject` 配到更后阶段的特例）→ false；
 * - 拖到更前阶段 / 原地 → false。
 */
export function exitsForward(exit: StageExit): boolean {
  if (!exit.succeeded) return false
  return exit.to === null || exit.to.position > exit.from.position
}

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

/** 打回退回到的目标阶段；未配置（不指定）则留在原地、不产生流转。 */
export function resolveRejectStage(
  stage: WorkflowStage,
  workflow: WorkflowWithStages,
): WorkflowStage {
  if (stage.onRejectStageId) {
    const target = workflow.stages.find((s) => s.id === stage.onRejectStageId)
    if (target) return target
  }
  return stage
}

/** 闸门通过分支：显式配了目标就用它，否则按默认下一阶段。 */
function resolvePassStage(
  stage: WorkflowStage,
  workflow: WorkflowWithStages,
): WorkflowStage | null {
  const configured = stage.gate?.onPassStageId
  if (configured) {
    const target = workflow.stages.find((s) => s.id === configured)
    if (target) return target
  }
  return resolveNextStage(stage, workflow)
}

/** 闸门未通过分支：未配置返回 null（原地不动）。 */
function resolveFailStage(
  stage: WorkflowStage,
  workflow: WorkflowWithStages,
): WorkflowStage | null {
  const configured = stage.gate?.onFailStageId
  if (!configured) return null
  return workflow.stages.find((s) => s.id === configured) ?? null
}

/**
 * 进入阶段：产出新任务态与效果。
 *
 * `gateFails` 是闸门预算的携带值：新进入一个阶段默认清零（M11），但失败回环要把
 * 累计次数带过去，否则「最多 3 次」永远到不了。
 */
export function enterStage(
  task: Task,
  stage: WorkflowStage,
  _workflow: WorkflowWithStages,
  gateFails = 0,
): { task: Task; effects: StageEffect[] } {
  return {
    task: { ...task, currentStageId: stage.id, status: 'active', gateFails },
    effects: entryEffects(stage),
  }
}

/**
 * 纯函数：根据事件推进任务到新阶段。
 * 不读写数据库、不 spawn；由调用方执行返回的 effects 并持久化 task。
 *
 * 闸门（M11）只改「成功」这一支：`RUN_FAILED` 仍按 `onReject` 走，且**不消耗**闸门预算
 * ——执行器崩了不等于业务上没过。
 */
export function moveTask(task: Task, event: StageEvent, workflow: WorkflowWithStages): MoveResult {
  const current = workflow.stages.find((s) => s.id === task.currentStageId)
  if (!current || task.status === 'completed') {
    return { task, effects: [] }
  }

  const advance = (next: WorkflowStage | null, gateFails: number): MoveResult => {
    if (!next) {
      return { task: { ...task, status: 'completed', gateFails: 0 }, effects: [] }
    }
    return enterStage(task, next, workflow, gateFails)
  }

  switch (event.type) {
    case 'RUN_SUCCEEDED': {
      const gate = current.gate ?? null
      if (gate === null) return advance(resolveNextStage(current, workflow), 0)

      const verdict = event.verdict
      // 没给结论：既不白过也不烧预算，任务留在闸门阶段等人（看板上可见）
      if (verdict === undefined) return { task, effects: [] }
      if (verdict === 'pass') return advance(resolvePassStage(current, workflow), 0)

      const fails = (task.gateFails ?? 0) + 1
      if (fails >= gate.maxFails) {
        // 预算耗尽：按配置放行，调用方据此打 `gate:degraded` 留痕
        return { ...advance(resolvePassStage(current, workflow), 0), gateExhausted: true }
      }
      const failTarget = resolveFailStage(current, workflow)
      if (!failTarget || failTarget.id === current.id) {
        // 未配失败去向：原地累计次数、不重建 run（防无限自动重试）
        return { task: { ...task, gateFails: fails }, effects: [] }
      }
      return enterStage(task, failTarget, workflow, fails)
    }
    case 'RUN_FAILED': {
      const target = resolveRejectStage(current, workflow)
      // 打回目标就是原地：保留任务与当前阶段，不再触发进入效果。
      // 否则 agent 阶段失败会立刻重建 run，形成无限自动重试。
      if (target.id === current.id) return { task, effects: [] }
      // 执行出错不清零预算：崩了不等于业务上没过
      return enterStage(task, target, workflow, task.gateFails ?? 0)
    }
  }
}

/**
 * 纯函数：看板拖拽 —— 把任务直接放到目标阶段，不套用「完成后进入 / 打回退回到」。
 * 任务已完成、目标不存在或就落在当前阶段时原样返回。人工落位视为重新开始，预算清零。
 */
export function moveTaskToStage(
  task: Task,
  stageId: string,
  workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] } {
  const target = workflow.stages.find((s) => s.id === stageId)
  if (task.status === 'completed' || !target || target.id === task.currentStageId) {
    return { task, effects: [] }
  }
  return enterStage(task, target, workflow)
}

/** 纯函数：看板拖到「归档」区 —— 任务移出看板。 */
export function completeTask(task: Task): Task {
  return { ...task, status: 'completed' }
}
