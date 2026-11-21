/**
 * 任务阶段语义的客户端取数（M53）：从 `workflows.all` 里按任务自己的工作流找当前阶段，
 * 再交给协议的 `taskPhaseOf` 判类别。
 *
 * 为什么要有这一层：任务行只存 `currentStageId`，阶段类别（内置 / 自己添加）在阶段行上。
 * 看板、详情页、线程页三处都要判「完成没有」，口径必须只有一份——三处各写一遍就会漂
 * （M53 前它们各自读 `task.status`，于是停在「已完成」列的任务显示「进行中」）。
 */
import type {
  Task,
  TaskPhase,
  WorkflowStage,
  WorkflowWithStages,
} from '@workbench/protocol/entities'
import { taskPhaseOf } from '@workbench/protocol/entities'

/** 任务自己的当前阶段（跨工作流查；阶段缺失返回 undefined）。 */
export function stageOfTask(
  task: Task,
  workflows: readonly WorkflowWithStages[],
): WorkflowStage | undefined {
  const workflow = workflows.find((item) => item.id === task.workflowId)
  return workflow?.stages.find((stage) => stage.id === task.currentStageId)
}

/** 任务的阶段语义；阶段查不到按「未开始」（与协议的缺省一致）。 */
export function phaseOfTask(task: Task, workflows: readonly WorkflowWithStages[]): TaskPhase {
  return taskPhaseOf(stageOfTask(task, workflows))
}

/** 任务是否已经结束（完成或取消）——「还能不能派活 / 重排 / 挂子任务」都看它。 */
export function isTaskOver(phase: TaskPhase): boolean {
  return phase === 'finished' || phase === 'cancelled'
}
