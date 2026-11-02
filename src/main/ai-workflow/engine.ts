import type { Task, WorkflowStage } from '../../shared/ai-workflow-api'
import {
  entryEffects,
  moveTask,
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
