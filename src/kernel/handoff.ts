/**
 * 跨工作流交接（纯函数，M7）：阶段离开且向前时，在目标工作流建一条关联任务。
 *
 * 触发点收敛到 `decide` 的三处（成功流转、向前拖拽、直接完成），本文件只回答两件事：
 * 「这次离开该交接给谁」与「交接要产哪些事实」。打回与删阶段重挂显式排除（见
 * `workflow/stage-machine.ts` 的 `exitsForward`）。
 *
 * 语义边界（D11）：
 * - 产物 = 目标工作流一条 `task.created`（`origin='handoff'`）+ 新隐式线程
 *   （`source='handoff'`、`externalRef=null`）+ 目标阶段为 agent 时的入口 run；
 * - **不回写来源任务**：不产 `task.updated`，来源任务的状态只由它自己的流转事实表达；
 * - 去重：扫 `view.tasks` 的 `(handoffFromTaskId, handoffFromStageId)`，同一对只交接一次；
 * - 链深上限 8：沿 `handoffFromTaskId` 回溯，超限零事实（防交接环无限擴张）。
 */
import type { StageInput, Task, WorkflowStage } from '../protocol/entities'
import type { Actor, Environment, FactDraft, Id, Iso, View } from './types'
import { entryRunFacts } from './task-effects'
import { openThreadRow, openedFacts, taskAttachedFacts, withTask } from './threads'
import { exitsForward } from './workflow/stage-machine'

/** 交接链深上限：新产出的任务最多是第 8 层，第 9 层不再建。 */
export const HANDOFF_MAX_DEPTH = 8

/** 交接目标：目标工作流 + 落地阶段（目标工作流没有阶段时不交接，不会出现 null）。 */
export interface HandoffTarget {
  workflowId: Id
  stageId: Id
}

const truncate = (value: string, max: number): string =>
  Array.from(value).length > max ? Array.from(value).slice(0, max).join('') : value

/** 工作流下的阶段，按 position 升序（与投影唯一约束一致）。 */
function stagesOfWorkflow(view: View, workflowId: Id): WorkflowStage[] {
  const stages: WorkflowStage[] = []
  for (const stage of view.stages.values()) {
    if (stage.workflowId === workflowId) stages.push(stage)
  }
  return stages.sort((left, right) => left.position - right.position)
}

/**
 * 解析本次离开的交接目标：读阶段两列 → 目标工作流 + 目标阶段。
 *
 * 以下情况返回 null（零事实，不 reject）：阶段没配交接、目标工作流已删 / 是自身、
 * `handoffStageId` 已不属目标工作流、目标工作流没有任何阶段。保存时已校验，这里是防御
 * （删工作流与导入旧数据都会绕过校验）。
 */
export function handoffTargetOf(
  view: View,
  sourceTask: Task,
  exitedStageId: Id,
): HandoffTarget | null {
  const stage = view.stages.get(exitedStageId)
  if (stage === undefined || stage.handoffWorkflowId === null) return null
  const workflowId = stage.handoffWorkflowId
  if (workflowId === sourceTask.workflowId) return null
  const workflow = view.workflows.get(workflowId)
  if (workflow === undefined) return null
  const stages = stagesOfWorkflow(view, workflow.id)
  if (stage.handoffStageId === null) {
    const first = stages[0]
    return first === undefined ? null : { workflowId: workflow.id, stageId: first.id }
  }
  const target = stages.find((candidate) => candidate.id === stage.handoffStageId)
  return target === undefined ? null : { workflowId: workflow.id, stageId: target.id }
}

/** 同一 `(来源任务, 阶段)` 是否已经交接：扫 `view.tasks` 的交接两列。 */
export function handedOffAlready(view: View, sourceTaskId: Id, exitedStageId: Id): boolean {
  for (const task of view.tasks.values()) {
    if (task.handoffFromTaskId === sourceTaskId && task.handoffFromStageId === exitedStageId) {
      return true
    }
  }
  return false
}

/**
 * 交接链深度：沿 `handoffFromTaskId` 回溯的层数（非交接任务为 0）。
 *
 * 投影里出现环属于脏数据：遇到已访问节点即停，保证不无限循环。
 */
export function handoffDepth(view: View, task: Task): number {
  const seen = new Set<Id>([task.id])
  let depth = 0
  let current: Task | undefined = task
  while (current !== undefined && current.handoffFromTaskId !== null) {
    if (seen.has(current.handoffFromTaskId)) break
    seen.add(current.handoffFromTaskId)
    depth += 1
    current = view.tasks.get(current.handoffFromTaskId)
  }
  return depth
}

/**
 * 交接事实（D11）：目标工作流的一条任务 + 新隐式线程 + 入口 run。
 *
 * 零事实：没配目标 / 目标已失效 / 同一 `(任务, 阶段)` 已交接 / 链深已达上限。
 * 事实顺序与 `kernel/rules` 的隐式任务一致（线程 → 挂任务 → 任务 → 入口 run），
 * 保证重建可复现。
 */
export function handoffFacts(
  view: View,
  sourceTask: Task,
  exitedStageId: Id,
  now: Iso,
  env: Environment,
  actor: Actor,
): FactDraft[] {
  const target = handoffTargetOf(view, sourceTask, exitedStageId)
  if (target === null) return []
  if (handedOffAlready(view, sourceTask.id, exitedStageId)) return []
  if (handoffDepth(view, sourceTask) >= HANDOFF_MAX_DEPTH) return []

  const title = truncate(sourceTask.title.trim(), 200) || sourceTask.title
  const thread = openThreadRow(env, { source: 'handoff', externalRef: null, title, now })
  const task: Task = {
    id: env.nextId('task'),
    title,
    description: truncate(sourceTask.description, 2_000),
    workflowId: target.workflowId,
    currentStageId: target.stageId,
    status: 'active',
    origin: 'handoff',
    ruleId: null,
    externalRef: null,
    labels: [],
    threadId: thread.id,
    parentTaskId: null,
    spawnedByRunId: null,
    batchNo: null,
    spawnKey: null,
    handoffFromTaskId: sourceTask.id,
    handoffFromStageId: exitedStageId,
    createdAt: now,
    updatedAt: now,
  }
  const attached = withTask(thread, task, now)
  return [
    ...openedFacts(thread, actor, now),
    ...taskAttachedFacts(attached, task, null, actor, now),
    { type: 'task.created', actor, at: now, payload: { task } },
    ...entryRunFacts(view, task, now, env, actor, undefined, { thread: attached, turn: 1 }),
  ]
}

/**
 * 阶段退出 → 交接事实：只有「成功离开且向前」才产事实。
 * 打回 / 原地 / 拖回更早阶段一律零事实；这是三处钩子共用的入口。
 */
export function handoffOnExit(
  view: View,
  task: Task,
  fromStage: WorkflowStage,
  toStage: WorkflowStage | null,
  succeeded: boolean,
  now: Iso,
  env: Environment,
  actor: Actor,
): FactDraft[] {
  if (!exitsForward({ from: fromStage, to: toStage, succeeded })) return []
  return handoffFacts(view, task, fromStage.id, now, env, actor)
}

/**
 * 阶段交接目标语义校验（`workflow.create` / `workflow.update` 共用）。
 * 返回第一条错误文案；全部合法返回 null。
 *
 * 只做视图能判的部分：目标工作流存在且 ≠ 自身、给了 `handoffStageId` 就必须属于目标
 * 工作流；只给阶段不给工作流同样非法（形状校验在 `protocol/validate`）。
 */
export function validateStageHandoffs(
  view: View,
  workflowId: Id,
  stages: readonly StageInput[],
): string | null {
  for (const stage of stages) {
    const workflowTarget = stage.handoffWorkflowId ?? null
    const stageTarget = stage.handoffStageId ?? null
    if (workflowTarget === null) {
      if (stageTarget !== null) return `阶段「${stage.name}」的交接目标阶段缺少目标工作流`
      continue
    }
    if (workflowTarget === workflowId) {
      return `阶段「${stage.name}」的交接目标工作流不能是自身`
    }
    const target = view.workflows.get(workflowTarget)
    if (target === undefined) {
      return `阶段「${stage.name}」的交接目标工作流不存在: ${workflowTarget}`
    }
    if (stageTarget === null) continue
    const targetStage = view.stages.get(stageTarget)
    if (targetStage === undefined || targetStage.workflowId !== target.id) {
      return `阶段「${stage.name}」的交接目标阶段不属于目标工作流: ${stageTarget}`
    }
  }
  return null
}
