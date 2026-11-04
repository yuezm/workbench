import type { Task, WorkflowStage } from '../../shared/ai-workflow-api'
import {
  completeTask as completeTaskInState,
  entryEffects,
  moveTask,
  moveTaskToStage as moveTaskToStageInState,
  type StageEffect,
  type StageEvent,
} from '../../shared/stage-machine'
import type { Repository } from './repository'

export type Enqueue = (runId: string) => void

/** 执行阶段效果：agent 阶段入队一条 run，并回调 onQueue 通知 runner。 */
export function applyEffects(
  repo: Repository,
  task: Task,
  effects: StageEffect[],
  onQueue: Enqueue,
): string[] {
  const ids: string[] = []
  for (const e of effects) {
    if (e.type !== 'createRun') continue
    const agent = repo.agentGet(e.agentId)
    const wf = repo.workflowGet(task.workflowId)
    const stage = wf.stages.find((s) => s.id === e.stageId)
    const prompt = [
      agent.systemPrompt,
      `# 任务：${task.title}`,
      task.description,
      stage ? `# 阶段：${stage.name}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const run = repo.runCreate({
      taskId: task.id,
      stageId: e.stageId,
      agentId: e.agentId,
      runtimeId: agent.runtimeId,
      prompt,
      status: 'queued',
    })
    ids.push(run.id)
    onQueue(run.id)
  }
  return ids
}

/** 任务进入某阶段后执行该阶段的进入效果。 */
export function enterTaskStage(repo: Repository, task: Task, onQueue: Enqueue): Task {
  const wf = repo.workflowGet(task.workflowId)
  const stage: WorkflowStage | undefined = wf.stages.find((s) => s.id === task.currentStageId)
  if (stage) applyEffects(repo, task, entryEffects(stage), onQueue)
  return repo.taskGet(task.id)
}

/** 按事件推进任务并落地效果。 */
export function advanceTask(
  repo: Repository,
  taskId: string,
  event: StageEvent,
  onQueue: Enqueue,
): Task {
  const task = repo.taskGet(taskId)
  const wf = repo.workflowGet(task.workflowId)
  const stage = wf.stages.find((s) => s.id === task.currentStageId)
  if (!stage) throw new Error('任务当前阶段无效')
  const { task: next, effects } = moveTask(task, event, wf)
  const saved = repo.taskUpdate(taskId, {
    currentStageId: next.currentStageId,
    status: next.status,
  })
  applyEffects(repo, saved, effects, onQueue)
  return saved
}

/** 取任务当前阶段；阶段缺失说明数据不一致，直接拒绝变更。 */
function currentStageOf(repo: Repository, task: Task): WorkflowStage {
  const wf = repo.workflowGet(task.workflowId)
  const stage = wf.stages.find((s) => s.id === task.currentStageId)
  if (!stage) throw new Error('任务当前阶段无效')
  return stage
}

/**
 * 看板拖拽：把任务放到目标阶段并落地该阶段的进入效果。
 *
 * 「执行中」由活跃 run 判定，而不是阶段配置：agent 阶段失败后没有 run 在跑，
 * 用户仍可把卡片拖去重试或收尾，不会卡死在看板上。
 */
export function moveTaskToStage(
  repo: Repository,
  taskId: string,
  stageId: string,
  onQueue: Enqueue,
): Task {
  const task = repo.taskGet(taskId)
  const wf = repo.workflowGet(task.workflowId)
  const current = wf.stages.find((s) => s.id === task.currentStageId)
  if (!current) throw new Error('任务当前阶段无效')
  if (repo.activeRunForTask(taskId)) throw new Error('执行中的阶段不能拖动')
  if (!wf.stages.some((s) => s.id === stageId)) throw new Error('目标阶段无效: ' + stageId)
  const { task: next, effects } = moveTaskToStageInState(task, stageId, wf)
  const saved = repo.taskUpdate(taskId, {
    currentStageId: next.currentStageId,
    status: next.status,
  })
  applyEffects(repo, saved, effects, onQueue)
  return saved
}

/** 看板拖到「已完成」区：任务移出看板；有活跃 run 时不允许。 */
export function completeTask(repo: Repository, taskId: string): Task {
  const task = repo.taskGet(taskId)
  currentStageOf(repo, task)
  if (repo.activeRunForTask(taskId)) throw new Error('执行中的阶段不能完成')
  return repo.taskUpdate(taskId, { status: completeTaskInState(task).status })
}
