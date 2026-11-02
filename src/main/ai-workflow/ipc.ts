import { ipcMain } from 'electron'
import type {
  AgentInput,
  RuntimeInput,
  Task,
  TaskInput,
  TaskMoveAction,
  WorkflowInput,
} from '../../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'
import {
  entryEffects,
  moveTask,
  type StageEffect,
  type StageEvent,
} from '../../shared/stage-machine'
import type { Repository } from './repository'

/** 纯分发器：方法名 + 参数 → 结果；不含 electron 依赖，便于单测。 */
export type AiWorkflowHandler = (method: string, args: unknown[]) => unknown

/** 执行阶段效果：agent 阶段入队一条 run；其余为 UI 语义，无副作用。 */
function applyEffects(repo: Repository, task: Task, effects: StageEffect[]): void {
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
    repo.runCreate({
      taskId: task.id,
      stageId: e.stageId,
      agentId: e.agentId,
      prompt,
      status: 'queued',
    })
  }
}

export function createAiWorkflowHandler(
  repo: Repository,
  notifyChanged: () => void,
): AiWorkflowHandler {
  const mutate = (fn: () => unknown): unknown => {
    const result = fn()
    notifyChanged()
    return result
  }

  const table: Record<string, (a: unknown[]) => unknown> = {
    'runtimes.list': () => repo.runtimesList(),
    'runtimes.create': (a) => mutate(() => repo.runtimeCreate(a[0] as RuntimeInput)),
    'runtimes.update': (a) =>
      mutate(() => repo.runtimeUpdate(a[0] as string, a[1] as Partial<RuntimeInput>)),
    'runtimes.remove': (a) => mutate(() => repo.runtimeRemove(a[0] as string)),

    'agents.list': () => repo.agentsList(),
    'agents.create': (a) => mutate(() => repo.agentCreate(a[0] as AgentInput)),
    'agents.update': (a) =>
      mutate(() => repo.agentUpdate(a[0] as string, a[1] as Partial<AgentInput>)),
    'agents.remove': (a) => mutate(() => repo.agentRemove(a[0] as string)),

    'workflows.list': () => repo.workflowsList(),
    'workflows.create': (a) => mutate(() => repo.workflowCreate(a[0] as WorkflowInput)),
    'workflows.update': (a) =>
      mutate(() => repo.workflowUpdate(a[0] as string, a[1] as WorkflowInput)),
    'workflows.remove': (a) => mutate(() => repo.workflowRemove(a[0] as string)),

    'tasks.list': (a) => repo.tasksList(a[0] as string),
    'tasks.create': (a) =>
      mutate(() => {
        const task = repo.taskCreate(a[0] as TaskInput)
        const wf = repo.workflowGet(task.workflowId)
        const stage = wf.stages.find((s) => s.id === task.currentStageId)
        if (stage) applyEffects(repo, task, entryEffects(stage))
        return repo.taskGet(task.id)
      }),
    'tasks.move': (a) =>
      mutate(() => {
        const id = a[0] as string
        const action = a[1] as TaskMoveAction
        const task = repo.taskGet(id)
        const wf = repo.workflowGet(task.workflowId)
        const stage = wf.stages.find((s) => s.id === task.currentStageId)
        if (!stage) throw new Error('任务当前阶段无效')
        if (action === 'approve' && stage.entryMode !== 'user')
          throw new Error('仅“交给用户”的阶段可通过')
        if (action === 'next' && stage.entryMode !== 'none')
          throw new Error('仅“不交接”的阶段可推进')
        if (action === 'reject' && stage.entryMode === 'agent')
          throw new Error('执行中的阶段不能打回')
        const event: StageEvent =
          action === 'approve'
            ? { type: 'APPROVE' }
            : action === 'reject'
              ? { type: 'REJECT' }
              : { type: 'MOVE_NEXT' }
        const { task: next, effects } = moveTask(task, event, wf)
        const saved = repo.taskUpdate(id, {
          currentStageId: next.currentStageId,
          status: next.status,
        })
        applyEffects(repo, saved, effects)
        return saved
      }),
    'tasks.remove': (a) => mutate(() => repo.taskRemove(a[0] as string)),

    'runs.listByTask': (a) => repo.runsListByTask(a[0] as string),
  }

  return (method, args) => {
    const fn = table[method]
    if (!fn) throw new Error('未知方法: ' + method)
    return fn(args)
  }
}

export interface AiWorkflowIpcDeps {
  repo: Repository
  notifyChanged: () => void
}

export function registerAiWorkflowIpc(deps: AiWorkflowIpcDeps): void {
  const handler = createAiWorkflowHandler(deps.repo, deps.notifyChanged)
  ipcMain.handle(AI_WORKFLOW_CHANNEL, (_event, method: string, args: unknown[]) =>
    handler(method, args),
  )
}
