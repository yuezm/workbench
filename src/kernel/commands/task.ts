/**
 * 任务命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Task } from '../../protocol/entities'
import type { Input } from '../../protocol/inputs'
import type { TaskComment } from '../../protocol/task-comment'
import type { Decision, Environment, FactDraft, Iso, View } from '../types'
import { handoffOnExit } from '../handoff'
import { childrenSettledFacts } from '../spawn'
import { entryRunFacts } from '../task-effects'
import {
  closeIfAllDone,
  openThreadRow,
  openedFacts,
  taskAttachedFacts,
  threadOfTask,
  withTask,
} from '../threads'
import { completeTask, moveTaskToStage } from '../workflow/stage-machine'
import { done, OWNER, ownerDraft, reject, runsOfTask, stagesOf, workflowWithStages } from './common'

export function createTask(
  view: View,
  input: Extract<Input, { type: 'task.create' }>,
  now: Iso,
  env: Environment,
): Decision {
  const form = input.input
  const title = form.title?.trim()
  if (!title) return reject('invalid_input', '任务标题必填')
  const workflow = view.workflows.get(form.workflowId)
  if (!workflow) return reject('not_found', '工作流不存在: ' + form.workflowId)
  const stages = stagesOf(view, workflow.id)
  const requested = form.stageId || null
  if (requested !== null && !stages.some((stage) => stage.id === requested)) {
    return reject('not_found', '起始阶段不属于该工作流: ' + requested)
  }
  // M8：人工挂子任务——父任务必须存在、同工作流、active（父任务 id 才挂得上）
  const parentId = form.parentTaskId ?? null
  let parent: Task | undefined
  if (parentId !== null) {
    parent = view.tasks.get(parentId)
    if (!parent) return reject('not_found', '父任务不存在: ' + parentId)
    if (parent.workflowId !== workflow.id) {
      return reject('invalid_input', '父任务不属于该工作流: ' + parentId)
    }
    if (parent.status !== 'active') {
      return reject('conflict', '父任务已完成，不能挂子任务: ' + parentId)
    }
  }
  // M11：项目是聊天与任务共用的顶层上下文；省 / 空 = 默认目录（`projectId` 落 null），
  // 给了就必须存在（存在性只在视图里判，不靠外键）。
  const requestedProjectId = form.projectId?.trim() ?? ''
  if (requestedProjectId !== '' && !view.projects.has(requestedProjectId)) {
    return reject('not_found', '项目不存在: ' + requestedProjectId)
  }
  // 子任务与父任务同项目：父任务没有项目（默认目录）时子任务也落默认目录；
  // 父任务有项目时子任务继承，显式给了别的项目仍拒绝（M8 判定）
  let projectId: string | null = requestedProjectId === '' ? null : requestedProjectId
  if (parent !== undefined) {
    if (parent.projectId === null) {
      projectId = null
    } else if (projectId !== null && projectId !== parent.projectId) {
      return reject('invalid_input', '子任务必须属于父任务的项目: ' + parent.projectId)
    } else {
      projectId = parent.projectId
    }
  }
  // 子任务继承父任务线程；没有父线程（或父任务无线程）时新建隐式线程
  const parentThread = parent?.threadId == null ? undefined : view.threads.get(parent.threadId)
  const thread =
    parentThread ??
    openThreadRow(env, {
      source: 'manual',
      externalRef: null,
      title,
      now,
    })
  const task: Task = {
    id: env.nextId('task'),
    title,
    description: form.description ?? '',
    workflowId: workflow.id,
    projectId,
    currentStageId: requested ?? parent?.currentStageId ?? stages[0]?.id ?? null,
    status: 'active',
    origin: 'manual',
    ruleId: null,
    externalRef: null,
    labels: [],
    threadId: thread.id,
    parentTaskId: parent?.id ?? null,
    spawnedByRunId: null,
    batchNo: null,
    spawnKey: null,
    handoffFromTaskId: null,
    handoffFromStageId: null,
    createdAt: now,
    updatedAt: now,
  }
  const attached = withTask(thread, task, now)
  const facts: FactDraft[] = [
    ...(parentThread === undefined ? openedFacts(thread, OWNER, now) : []),
    ...taskAttachedFacts(attached, task, null, OWNER, now),
    ownerDraft('task.created', { task }, now),
  ]
  // 进入效果：首阶段是 agent 时立刻入队一条 run（与旧宿主 applyStageEffects 同口径）
  facts.push(
    ...entryRunFacts(view, task, now, env, OWNER, undefined, { thread: attached, turn: 1 }),
  )
  return done(facts)
}

export function moveTaskCommand(
  view: View,
  input: Extract<Input, { type: 'task.move' }>,
  now: Iso,
  env: Environment,
): Decision {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', '任务不存在: ' + input.id)
  const workflow = view.workflows.get(task.workflowId)
  if (!workflow) return reject('not_found', '工作流不存在: ' + task.workflowId)
  const flow = workflowWithStages(view, workflow)
  const fromStage = flow.stages.find((stage) => stage.id === task.currentStageId)
  if (!fromStage) return reject('conflict', '任务当前阶段无效')
  if (view.activeTaskIds.has(task.id)) return reject('conflict', '执行中的阶段不能拖动')
  const target = flow.stages.find((stage) => stage.id === input.stageId)
  if (!target) return reject('not_found', '目标阶段无效: ' + input.stageId)
  const next = moveTaskToStage(task, target.id, flow).task
  const moved: Task = { ...next, updatedAt: now }
  const facts: FactDraft[] = [
    ownerDraft(
      'task.moved',
      { task: moved, from: task.currentStageId, to: moved.currentStageId },
      now,
    ),
  ]
  // 进入效果：落点阶段的 agent 入口每次进入都重新建 run；原地（from=to）不重建
  if (moved.currentStageId !== task.currentStageId) {
    facts.push(...entryRunFacts(view, moved, now, env, OWNER))
  }
  // M7：拖到更后阶段 = 向前离开，触发交接；拖回更前阶段不触发
  facts.push(...handoffOnExit(view, task, fromStage, target, true, now, env, OWNER))
  return done(facts)
}

export function completeTaskCommand(
  view: View,
  input: Extract<Input, { type: 'task.complete' }>,
  now: Iso,
  env: Environment,
): Decision {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', '任务不存在: ' + input.id)
  const workflow = view.workflows.get(task.workflowId)
  if (!workflow) return reject('not_found', '工作流不存在: ' + task.workflowId)
  const fromStage = stagesOf(view, workflow.id).find((stage) => stage.id === task.currentStageId)
  if (!fromStage) return reject('conflict', '任务当前阶段无效')
  if (view.activeTaskIds.has(task.id)) return reject('conflict', '执行中的阶段不能完成')
  const completed: Task = { ...completeTask(task), updatedAt: now }
  // M7：完成前先产交接事实（完成 = 离开当前阶段且向前）
  const facts: FactDraft[] = [
    ...handoffOnExit(view, task, fromStage, null, true, now, env, OWNER),
    ownerDraft('task.completed', { task: completed }, now),
  ]
  // M6.5：线程内任务全部完成 → 归档线程
  facts.push(
    ...closeIfAllDone(
      view,
      threadOfTask(view, task),
      now,
      OWNER,
      new Map([[task.id, 'completed']]),
    ),
  )
  // M8：子任务完成 → 父任务 rollup（全部子任务结束才触发）
  if (task.parentTaskId !== null) {
    facts.push(
      ...childrenSettledFacts(
        view,
        task.parentTaskId,
        now,
        env,
        OWNER,
        new Map([[task.id, 'completed']]),
      ),
    )
  }
  return done(facts)
}

export function removeTask(
  view: View,
  input: Extract<Input, { type: 'task.remove' }>,
  now: Iso,
  env: Environment,
): Decision {
  const task = view.tasks.get(input.id)
  if (!task) return done([])
  // D13：先逐条删该任务的 run，再删任务；重建与旧 SQL 级联的可见结果一致
  const facts: FactDraft[] = runsOfTask(view, task.id).map((run) =>
    ownerDraft('run.removed', { runId: run.id }, now),
  )
  facts.push(ownerDraft('task.removed', { task }, now))
  // M6.5：删除后剩余任务都已完成 → 归档线程（已删任务视为完成）
  facts.push(
    ...closeIfAllDone(
      view,
      threadOfTask(view, task),
      now,
      OWNER,
      new Map([[task.id, 'completed']]),
    ),
  )
  // M8：删掉子任务 → 父任务 rollup（删除视为放弃，不阻塞）
  if (task.parentTaskId !== null) {
    facts.push(
      ...childrenSettledFacts(
        view,
        task.parentTaskId,
        now,
        env,
        OWNER,
        new Map([[task.id, 'completed']]),
      ),
    )
  }
  return done(facts)
}

export function commentTask(
  view: View,
  input: Extract<Input, { type: 'task.comment' }>,
  now: Iso,
  env: Environment,
): Decision {
  // M7.5：任务上下文 / 反馈（像 issue 评论一样追加）。
  const task = view.tasks.get(input.taskId)
  if (!task) return reject('not_found', '任务不存在: ' + input.taskId)
  const text = input.text.trim()
  if (!text) return reject('invalid_input', '反馈内容必填')
  const comment: TaskComment = {
    id: env.nextId('task-comment'),
    taskId: task.id,
    author: 'owner',
    text,
    createdAt: now,
  }
  const facts: FactDraft[] = [ownerDraft('task.comment_added', { comment }, now)]
  // 顺带再跑一轮：任务停在 agent 阶段且没有活跃 run 才会产 run.queued；
  if (input.rerun === true && !view.activeTaskIds.has(task.id)) {
    facts.push(
      ...entryRunFacts(view, task, now, env, OWNER, undefined, { pendingComment: comment }),
    )
  }
  return done(facts)
}
