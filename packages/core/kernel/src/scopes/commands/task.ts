/**
 * 任务命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Task, WorkflowWithStages } from '@workbench/protocol/entities'
import { isTaskOver, taskPhaseOf } from '@workbench/protocol/entities'
import type { Input } from '@workbench/protocol/inputs'
import type { TaskComment } from '@workbench/protocol/task-comment'
import type { Decision, Environment, FactDraft, Id, Iso, View } from '../../core/types'
import { handoffOnExit } from '../handoff'
import { revokeMandate } from '../mandate'
import { blockingFindings, locateReport, reportTargetsStage } from '../review'
import { childrenSettledFacts } from '../spawn'
import { entryRunFacts } from '../task-effects'
import {
  closeIfAllDone,
  openThreadRow,
  openedFacts,
  removedIfNoTasksLeft,
  stageRoundCount,
  taskAttachedFacts,
  threadWithBatchTasks,
  batchTaskPhases,
  threadOfTask,
  withTask,
} from '../threads'
import { archiveTask, moveTask, moveTaskToStage, terminalOutcomeOf } from '../workflow/stage-machine'
import {
  done,
  hostDraft,
  OWNER,
  ownerDraft,
  reject,
  runsOfTask,
  stagesOf,
  workflowWithStages,
} from './common'

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
    // M53：父任务「结束没有」看阶段语义（完成 / 取消），与归档无关
    const parentStage =
      parent.currentStageId === null ? undefined : view.stages.get(parent.currentStageId)
    if (isTaskOver(taskPhaseOf(parentStage))) {
      return reject('conflict', '父任务已结束，不能挂子任务: ' + parentId)
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
    archivedAt: null,
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
    handoffFromRunId: null,
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

/**
 * 人工跳转留痕里的「自然去向」文案：`null` = 完成（该阶段没有下一阶段），阶段已不存在时
 * 退「未知阶段」。
 *
 * 单列成导出函数只为让这两条判定能被单测直接覆盖：命令路径进到该处前已经断言当前阶段
 * 属于本工作流，`moveTask` 的返回值因此恒为「当前阶段」或 flow 里的阶段，构造不出另外两支。
 */
export function naturalStageLabel(natural: Id | null, flow: WorkflowWithStages): string {
  if (natural === null) return '完成'
  return flow.stages.find((stage) => stage.id === natural)?.name ?? '未知阶段'
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
  // M22：人工跳转留痕——落点不等于本阶段的自然去向时记一条评论。
  // 允许跳级/回退是「松绑」的一部分，但没有留痕的松绑收不回来（审计链要完整）。
  if (moved.currentStageId !== task.currentStageId) {
    const natural = moveTask(task, { type: 'RUN_SUCCEEDED', runId: 'manual-move-probe' }, flow).task
      .currentStageId
    if (natural !== moved.currentStageId) {
      const naturalName = naturalStageLabel(natural, flow)
      const comment: TaskComment = {
        id: env.nextId('task-comment'),
        taskId: task.id,
        author: 'agent',
        text: `人工跳转：「${fromStage.name}」→「${target.name}」（自然去向：${naturalName}）。`,
        createdAt: now,
      }
      facts.push(hostDraft('task.comment_added', { comment }, now))
    }
  }
  // M29：人工拖动走 `manual` 触发条件；标了「仅向前」的派单在拖回更前阶段（返工）时不发
  facts.push(
    ...handoffOnExit(view, task, fromStage, 'manual', now, env, OWNER, {
      forward: target.position > fromStage.position,
      runId: null,
    }),
  )
  // M53：落到终态阶段 = 完成（与自动流转同一套后果：线程归档 + 父任务 rollup）
  const outcome = terminalOutcomeOf(target)
  if (outcome !== null) {
    facts.push(ownerDraft('task.finished', { task: moved, outcome }, now))
    // M50：同一批里可能刚派出一张落回本话题的新卡——它还没进视图，归档判定要把它算作未结束
    const settled = batchTaskPhases(facts)
    settled.set(task.id, outcome === 'cancelled' ? 'cancelled' : 'finished')
    facts.push(
      ...closeIfAllDone(
        view,
        threadWithBatchTasks(threadOfTask(view, task), facts),
        now,
        OWNER,
        settled,
      ),
    )
    if (task.parentTaskId !== null) {
      facts.push(...childrenSettledFacts(view, task.parentTaskId, now, env, OWNER, settled))
    }
  }
  return done(facts)
}

/**
 * 归档 / 取消归档（M53，取代 `task.complete`）。
 *
 * 归档只表达「这条我不想再跟了」：只写 `archivedAt`、零业务后果、可逆。完成不在这里——
 * 完成由任务进入内置「已完成 / 已取消」阶段表达（`task.move`）。
 * 执行中的任务不能归档（先 `task.stop`）；已是目标状态时不产事实（幂等）。
 */
export function archiveTaskCommand(
  view: View,
  input: Extract<Input, { type: 'task.archive' }>,
  now: Iso,
): Decision {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', '任务不存在: ' + input.id)
  const archived = input.archived ?? true
  if (archived && view.activeTaskIds.has(task.id)) {
    return reject('conflict', '执行中的阶段不能归档')
  }
  if (archived === (task.archivedAt !== null)) return done([])
  const next: Task = archived
    ? { ...archiveTask(task, now), updatedAt: now }
    : { ...task, archivedAt: null, updatedAt: now }
  return done([ownerDraft('task.archived', { task: next }, now)])
}

/**
 * 停止与智能体的当前交互（`task.stop`）：把该任务的活跃 run 逐条置为「请求取消」。
 *
 * 与 `chat.cancel` 同一收尾链路——只产 `run.cancel_requested`，终态由宿主按取消时序落
 * `run.cancelled`；任务本身不动位置（想收尾再走 `task.move` 到「已完成」或 `task.archive` 收纳）。
 * 幂等：已请求过的跳过；没有活跃 run 时零事实（重复点不会报错）。
 */
export function stopTask(
  view: View,
  input: Extract<Input, { type: 'task.stop' }>,
  now: Iso,
): Decision {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', '任务不存在: ' + input.id)
  const facts: FactDraft[] = []
  for (const run of runsOfTask(view, task.id)) {
    if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') continue
    if (run.cancelRequested) continue
    facts.push(
      ownerDraft(
        'run.cancel_requested',
        { run: { ...run, cancelRequested: true }, by: 'owner' },
        now,
      ),
    )
  }
  // A2：人工停止同时撤销该任务的授权（只有人能撤，任务完成不算撤销）
  const mandate = view.mandates?.get(task.id)
  if (mandate !== undefined && mandate.revokedAt === null) {
    facts.push(ownerDraft('mandate.revoked', { mandate: revokeMandate(mandate, 'stop', now) }, now))
  }
  return done(facts)
}

/**
 * 重新执行当前阶段（`task.rerun`）：run 失败收口后原地再排一轮。
 *
 * 与 `task.comment{rerun}` 共用进入阶段效果——`turn+1`、线程上下文、会话续接、项目工作
 * 目录都不变，区别只是不追加反馈正文。任务行不动（阶段与闸门预算都保留）：执行器崩了
 * 不等于业务上没过。执行中 / 非 agent 阶段 / 智能体或运行时缺失一律 reject——「点了没
 * 反应」比报错更难查。
 */
export function rerunTask(
  view: View,
  input: Extract<Input, { type: 'task.rerun' }>,
  now: Iso,
  env: Environment,
): Decision {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', '任务不存在: ' + input.id)
  const phase = taskPhaseOf(
    task.currentStageId === null ? undefined : view.stages.get(task.currentStageId),
  )
  if (isTaskOver(phase)) return reject('conflict', '任务已结束，不能重新执行')
  if (view.activeTaskIds.has(task.id)) {
    return reject('conflict', '当前阶段正在执行，先停止执行再重排')
  }
  const stage = task.currentStageId === null ? undefined : view.stages.get(task.currentStageId)
  if (!stage || stage.workflowId !== task.workflowId) {
    return reject('conflict', '任务当前阶段无效')
  }
  if (stage.entryMode !== 'agent' && stage.entryMode !== 'script') {
    return reject('conflict', '当前阶段不派活，无法重新执行: ' + stage.name)
  }
  const facts = entryRunFacts(view, task, now, env, OWNER, undefined, {
    roundSession: 'resume',
  })
  if (facts.length === 0) {
    return reject('conflict', '当前阶段没有可用的智能体 / 脚本或运行时: ' + stage.name)
  }
  return done(facts)
}

/**
 * 让闸门补一次回执（R5）：跑完却没给结论时，在同一会话里只补 `verdict` / `checks`。
 *
 * 触发条件（全部满足才排一轮）：
 * - 任务进行中、无活跃 run；
 * - 当前阶段是**智能体闸门**（脚本闸门的结论来自退出码，补回执没有意义）；
 * - 该阶段只跑过一轮（`stageRoundCount <= 1`）——补过一次仍无结论就交给人，不自动循环。
 *
 * 形态是「同阶段新开一轮 run」：复用同一 run 会让第二轮终态归档覆盖第一轮的 `output.md`
 * （评审正文就没了）。提示词换成 `receiptRepairText`，会话强制续接上一轮。
 */
/**
 * 让阶段补一次回执（R5，2026-11-21 扩成两类）：
 *
 * 1. **闸门**跑完却没给结论：在同一会话里只补 `verdict` / `checks`；
 * 2. **修复阶段**跑完仍有阻断项（blocker / high）没逐条回应：只补 `addresses`，
 *    清单直接内联（不要求重新改代码或重跑验证）。
 *
 * 触发条件（两类共有）：任务进行中、无活跃 run、当前阶段是智能体阶段。
 * 额度按该阶段已跑轮数算：闸门补一次、修复阶段最多补到第 3 轮，之后交给人，不自动循环。
 */
export function reaskGate(
  view: View,
  input: Extract<Input, { type: 'task.reask' }>,
  now: Iso,
  env: Environment,
): Decision {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', '任务不存在: ' + input.id)
  if (
    isTaskOver(
      taskPhaseOf(task.currentStageId === null ? undefined : view.stages.get(task.currentStageId)),
    )
  ) {
    return reject('conflict', '任务已结束，不需要补回执')
  }
  if (view.activeTaskIds.has(task.id))
    return reject('conflict', '当前阶段正在执行，等这一轮结束再补')
  const stage = task.currentStageId === null ? undefined : view.stages.get(task.currentStageId)
  if (!stage || stage.workflowId !== task.workflowId) return reject('conflict', '任务当前阶段无效')
  if (stage.entryMode !== 'agent') {
    return reject('conflict', '脚本阶段没有回执可补: ' + stage.name)
  }
  // 第二类：执行阶段缺评审处置（当前阶段正是被那份报告打回的目标）。
  if (stage.judge === null) {
    const report = locateReport(view, task)
    const targets = report !== undefined && reportTargetsStage(view, report, stage.id)
    const blocking = report === undefined ? [] : blockingFindings(report)
    if (report === undefined || !targets || blocking.length === 0) {
      return reject('conflict', '当前阶段不是闸门，也没有待补的评审处置: ' + stage.name)
    }
    if (stageRoundCount(view, task.id, stage.id) > 2) {
      return reject('conflict', '这个阶段已经补过评审回执，仍没有逐条回应：请人工处理')
    }
    const facts = entryRunFacts(view, task, now, env, OWNER, undefined, {
      roundSession: 'resume',
      receiptRepair: 'addresses',
      review: report,
    })
    if (facts.length === 0) {
      return reject('conflict', '当前阶段没有可用的智能体 / 运行时: ' + stage.name)
    }
    return done(facts)
  }
  if (stageRoundCount(view, task.id, stage.id) > 1) {
    return reject('conflict', '这个闸门已经补过一次回执，仍没有结论：请重跑这一轮或人工处理')
  }
  const facts = entryRunFacts(view, task, now, env, OWNER, undefined, {
    roundSession: 'resume',
    receiptRepair: true,
  })
  if (facts.length === 0) {
    return reject('conflict', '当前阶段没有可用的智能体 / 运行时: ' + stage.name)
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
  // 线程内任务删光 → 线程一起删（线程保留一个「没有任务的壳」只会留在检索里）；
  // 还剩任务时按 M6.5 口径判归档（已删任务视为完成）
  const thread = threadOfTask(view, task)
  const emptied = removedIfNoTasksLeft(view, thread, task.id, OWNER, now)
  facts.push(
    ...(emptied.length > 0
      ? emptied
      : closeIfAllDone(view, thread, now, OWNER, new Map([[task.id, 'finished']]))),
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
        new Map([[task.id, 'finished']]),
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
  // 顺带再跑一轮：任务停在 agent 阶段且没有活跃 run 才会产 run.queued（人写反馈 → 接上一轮会话）
  if (input.rerun === true && !view.activeTaskIds.has(task.id)) {
    facts.push(
      ...entryRunFacts(view, task, now, env, OWNER, undefined, {
        pendingComment: comment,
        roundSession: 'resume',
      }),
    )
  }
  return done(facts)
}
