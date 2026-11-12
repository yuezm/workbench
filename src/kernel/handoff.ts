/**
 * 派单（M29，取代 M7 的跨工作流交接）：阶段离开且触发条件命中时，在目标工作流建一张新工单。
 *
 * 触发点收敛到 `decide` 的三处（run 结算、人工拖拽、直接完成），本文件只回答两件事：
 * 「这次离开命中哪些派单目标」与「派单要产哪些事实」。
 *
 * 语义边界（D11）：
 * - 产物 = 目标工作流一条 `task.created`（`origin='handoff'`）+ 新隐式线程
 *   （`source='handoff'`、`externalRef=null`）+ 目标阶段为 agent 时的入口 run；
 * - **不回写来源任务**：不产 `task.updated`，来源任务的状态只由它自己的流转事实表达；
 *   派单产物挂 `parentTaskId = 来源任务`，但只有在来源阶段显式配了 `onChildrenSettled`
 *   时才会参与 rollup（见 `spawn.ts#childrenSettledFacts` 的交接守卫）；
 * - 去重：扫 `view.tasks` 的 `(handoffFromTaskId, handoffFromStageId)`，同一对只派一次
 *   （同一阶段可以配多条派单，它们在同一批里一起产出；离开第二次才需要 runId 维度，见待办）；
 * - 链深上限 8：沿 `handoffFromTaskId` 回溯，超限零事实（防交接环无限扩张）。
 */
import type {
  BuiltinStageKey,
  StageHandoffGuard,
  StageInput,
  Task,
  WorkflowStage,
} from '../protocol/entities'
import type { Actor, Environment, FactDraft, Id, Iso, View } from './types'
import { entryRunFacts } from './task-effects'
import { openThreadRow, openedFacts, taskAttachedFacts, withTask } from './threads'
import { handoffTargetsOf, stagesOfWorkflow, type HandoffTarget } from './workflow/stage-handoffs'

export { handoffTargetsOf, stagesOfWorkflow, type HandoffTarget }

/** 交接链深上限：新产出的任务最多是第 8 层，第 9 层不再建。 */
export const HANDOFF_MAX_DEPTH = 8

const truncate = (value: string, max: number): string =>
  Array.from(value).length > max ? Array.from(value).slice(0, max).join('') : value

/**
 * 这一轮 run 是否已经派过单（M30）：扫 `view.tasks` 的派单来源 run。
 *
 * 以「一次离开」为粒度，同一阶段第二次成功会再派一张（工单模型：每次发起都是新单）。
 * 人工离开（runId = null）不去重——每次拖动 / 完成都是一次独立发起。
 */
export function handedOffAlready(view: View, sourceRunId: Id | null): boolean {
  if (sourceRunId === null) return false
  for (const task of view.tasks.values()) {
    if (task.handoffFromRunId === sourceRunId) return true
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
 * 单个派单目标的事实（D11）：目标工作流的一条任务 + 新隐式线程 + 入口 run。
 *
 * 事实顺序与 `kernel/rules` 的隐式任务一致（线程 → 挂任务 → 任务 → 入口 run），
 * 保证重建可复现。
 */
function handoffFactsFor(
  view: View,
  sourceTask: Task,
  exitedStageId: Id,
  sourceRunId: Id | null,
  target: HandoffTarget,
  now: Iso,
  env: Environment,
  actor: Actor,
): FactDraft[] {
  const title = truncate(sourceTask.title.trim(), 200) || sourceTask.title
  const thread = openThreadRow(env, { source: 'handoff', externalRef: null, title, now })
  const task: Task = {
    id: env.nextId('task'),
    title,
    description: truncate(sourceTask.description, 2_000),
    workflowId: target.workflowId,
    // M10：交接产物沿用来源任务的项目（同一工作目录）
    projectId: sourceTask.projectId,
    currentStageId: target.stageId,
    status: 'active',
    origin: 'handoff',
    ruleId: null,
    externalRef: null,
    labels: [],
    threadId: thread.id,
    // 挂来源任务（M25）：派单产物同样是一条「父任务的子任务」，来源阶段显式配了
    // `onChildrenSettled` 时，它全部结终态就能唤醒来源任务（缺陷全修完 → 自动回归）。
    // 但「不回写来源任务」的语义不变：这里不产 `task.updated`。
    parentTaskId: sourceTask.id,
    spawnedByRunId: null,
    batchNo: null,
    spawnKey: null,
    handoffFromTaskId: sourceTask.id,
    handoffFromStageId: exitedStageId,
    handoffFromRunId: sourceRunId,
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
 * 阶段离开 → 派单事实：只有触发条件命中且还有目标时才产事实。
 *
 * 打回 / 原地 / 取消不派单由调用方选的 `guard` 表达（见 `handoffGuardOf`）；
 * `options.forward` 只影响 `manual` 里标了 `forwardOnly` 的派单。
 */
export function handoffOnExit(
  view: View,
  task: Task,
  stage: WorkflowStage,
  guard: StageHandoffGuard,
  now: Iso,
  env: Environment,
  actor: Actor,
  options?: { forward?: boolean; runId?: Id | null },
): FactDraft[] {
  const runId = options?.runId ?? null
  if (handedOffAlready(view, runId)) return []
  const targets = handoffTargetsOf(view, task.workflowId, stage, guard, options)
  if (targets.length === 0) return []
  if (handoffDepth(view, task) >= HANDOFF_MAX_DEPTH) return []
  return targets.flatMap((target) =>
    handoffFactsFor(view, task, stage.id, runId, target, now, env, actor),
  )
}

/**
 * 派单目标语义校验（`workflow.create` / `workflow.update` 共用）。
 * 返回第一条错误文案；全部合法返回 null。
 *
 * 只做视图能判的部分：目标工作流存在且 ≠ 自身、给了 `stageId` 就必须属于目标工作流、
 * 内置终态不允许派单。形状校验在 `protocol/validate`。
 */
export function validateStageHandoffs(
  view: View,
  workflowId: Id,
  stages: readonly StageInput[],
  builtinKeys?: readonly (BuiltinStageKey | null)[],
): string | null {
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]
    const handoffs = stage.handoffs ?? []
    if (handoffs.length === 0) continue
    // 内置键优先取调用方解析好的（提交的输入可能只给了名字，没带 builtin）
    const key = builtinKeys?.[index] ?? stage.builtin ?? null
    if (key === 'done' || key === 'cancelled') {
      return `内置阶段「${stage.name}」不允许派单`
    }
    for (const handoff of handoffs) {
      if (handoff.workflowId === workflowId) {
        return `阶段「${stage.name}」的派单目标工作流不能是自身`
      }
      const target = view.workflows.get(handoff.workflowId)
      if (target === undefined) {
        return `阶段「${stage.name}」的派单目标工作流不存在: ${handoff.workflowId}`
      }
      if (handoff.stageId === null) continue
      const targetStage = view.stages.get(handoff.stageId)
      if (targetStage === undefined || targetStage.workflowId !== target.id) {
        return `阶段「${stage.name}」的派单目标阶段不属于目标工作流: ${handoff.stageId}`
      }
    }
  }
  return null
}
