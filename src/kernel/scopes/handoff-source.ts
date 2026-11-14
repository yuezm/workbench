/**
 * 来源工单的资料解析（M31）：纯函数，只读视图。
 *
 * 单独成文件是为了打断环——`handoff.ts` 要产事实（依赖 task-effects），
 * 而 task-effects 要拼提示词（需要这里的来源信息）。这里只依赖协议类型。
 */
import type { Task } from '../../protocol/entities'
import type { Id, View } from '../core/types'
import type { HandoffSource } from './prompt'

/**
 * 本次运行的任务是不是一张派单产物；是则返回「来源工单」的资料（M31）。
 *
 * 取哪一轮：`handoffFromRunId` 命中就用它；人工派出的没有 run，退回「来源任务在来源阶段上
 * 最后一条终态 run」（按 `endedAt ?? createdAt` 取最大），再没有就只给任务 / 阶段信息。
 * 只读视图，不读时钟、不读文件，同事实集文本全等。
 */
export function sourceHandoffOf(view: View, task: Task): HandoffSource | null {
  const sourceTaskId = task.handoffFromTaskId
  if (sourceTaskId === null) return null
  const sourceTask = view.tasks.get(sourceTaskId)
  const stageId = task.handoffFromStageId
  const sourceStage = stageId === null ? undefined : view.stages.get(stageId)
  const workflow = sourceTask === undefined ? undefined : view.workflows.get(sourceTask.workflowId)
  if (sourceTask === undefined || sourceStage === undefined) return null

  const explicit = task.handoffFromRunId === null ? undefined : view.runs.get(task.handoffFromRunId)
  const run = explicit ?? latestTerminalRunAt(view, sourceTask.id, sourceStage.id)

  return {
    workflowName: workflow?.name ?? sourceTask.workflowId,
    stageName: sourceStage.name,
    taskTitle: sourceTask.title,
    taskId: sourceTask.id,
    runId: run?.id ?? null,
    runStatus: run?.status ?? null,
    summary: run?.output ?? '',
  }
}

/** 来源任务在来源阶段上最后一条终态 run（人工派单时用它兜底取结论）。 */
function latestTerminalRunAt(
  view: View,
  taskId: Id,
  stageId: Id,
): { id: Id; status: string; output: string } | undefined {
  let best: { at: string; run: { id: Id; status: string; output: string } } | undefined
  for (const run of view.runs.values()) {
    if (run.taskId !== taskId || run.stageId !== stageId) continue
    if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting') continue
    const at = run.endedAt ?? run.createdAt
    if (best === undefined || at > best.at) {
      best = { at, run: { id: run.id, status: run.status, output: run.output } }
    }
  }
  return best?.run
}
