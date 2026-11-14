/**
 * 阶段派单（M29）：纯函数，只回答三件事——老事实怎么归一、这次离开命中哪一组派单、
 * 派单目标解析到哪个工作流的哪个阶段。
 *
 * 不产事实、不读写库，事实由 `kernel/handoff.ts` 拼。
 *
 * 触发条件（`StageHandoffGuard`）是**两个轴**，不是五个并列状态：
 * - 执行轴：`done`（跑完且本阶段没有判定）/ `errored`（崩了 / 超时 / 失联）；
 * - 业务轴：`passed` / `failed`（判定者给的两侧，只有判定阶段才有）；
 * - 人工：`manual`（拖卡片 / 点完成任务）。
 *
 * 判定阶段没有 `done`：跑完但没给结论不构成任何去向，与 M11 的闸门语义一致。
 */
import type {
  GateVerdict,
  RunStatus,
  StageHandoff,
  StageHandoffGuard,
  WorkflowStage,
} from '../../../protocol/entities'
import type { Id, View } from '../../core/types'

/** 一次「离开阶段」的信号：run 终态，或人工动作。 */
export interface HandoffSignal {
  kind: 'run' | 'manual'
  /** kind='run' 时的终态 */
  status?: RunStatus
  verdict?: GateVerdict
  /** 闸门预算耗尽后按通过放行（M11） */
  gateExhausted?: boolean
  /**
   * 人工拖动的落点 `position`；`null` = 完成任务（视为向前）。
   * 只影响 `forwardOnly` 的派单，不影响自动流转。
   */
  toPosition?: number | null
}

/** 派单目标：目标工作流 + 落地阶段。 */
export interface HandoffTarget {
  workflowId: Id
  stageId: Id
}

/** 工作流下的阶段，按 position 升序（与投影唯一约束一致）。 */
export function stagesOfWorkflow(view: View, workflowId: Id): WorkflowStage[] {
  const stages: WorkflowStage[] = []
  for (const stage of view.stages.values()) {
    if (stage.workflowId === workflowId) stages.push(stage)
  }
  return stages.sort((left, right) => left.position - right.position)
}

/**
 * 这次离开属于哪种触发条件；`null` = 不派单。
 *
 * 取消不派单（任务保持进行中，之后可能被拖走）；判定阶段跑完却没给结论也不派单
 * （任务停在闸门等人，不是一次「离开」）。
 */
export function handoffGuardOf(
  stage: Pick<WorkflowStage, 'judge'>,
  signal: HandoffSignal,
): StageHandoffGuard | null {
  if (signal.kind === 'manual') return 'manual'
  if (signal.status === 'cancelled') return null
  if (signal.status !== 'succeeded') return 'errored'
  const gated = stage.judge !== null && stage.judge !== undefined
  if (!gated) return 'done'
  if (signal.gateExhausted === true) return 'passed'
  if (signal.verdict === 'pass') return 'passed'
  if (signal.verdict === 'fail') return 'failed'
  return null
}

/**
 * 命中这一组触发条件的派单目标。零目标的情况（不 reject，静默跳过）：
 * 没有配、目标工作流已删 / 是自身、`stageId` 已不属目标工作流、目标工作流没有任何阶段、
 * 以及 `manual` 下拖回更前阶段而该条派单要求「仅向前」。
 */
export function handoffTargetsOf(
  view: View,
  sourceWorkflowId: Id,
  stage: Pick<WorkflowStage, 'handoffs'>,
  guard: StageHandoffGuard,
  options?: { forward?: boolean },
): HandoffTarget[] {
  const forward = options?.forward ?? true
  const out: HandoffTarget[] = []
  for (const handoff of stage.handoffs) {
    if (handoff.on !== guard) continue
    // 只对人工拖动拦「往回拖」：自动流转的向前与否由去向决定，不由位置猜
    if (guard === 'manual' && !forward && handoff.forwardOnly !== false) continue
    if (handoff.workflowId === sourceWorkflowId) continue
    const workflow = view.workflows.get(handoff.workflowId)
    if (workflow === undefined) continue
    const stages = stagesOfWorkflow(view, workflow.id)
    if (handoff.stageId === null) {
      const first = stages[0]
      if (first !== undefined) out.push({ workflowId: workflow.id, stageId: first.id })
      continue
    }
    const target = stages.find((candidate) => candidate.id === handoff.stageId)
    if (target !== undefined) out.push({ workflowId: workflow.id, stageId: target.id })
  }
  return out
}

/**
 * 老事实归一（M7 两列 → 派单数组）。
 *
 * M7 的语义是「成功且向前离开就交接」，它同时覆盖两条路：run 成功流转、人工拖动 / 完成任务。
 * 拆成触发条件后这一条配置要有两个出口才能等价——`done`（跑完）与 `manual`（人工往前拖 /
 * 完成），后者保留「仅向前」。判定阶段的老配置一律折成 `passed`：M11 起「未通过不交接」，
 * 只有通过（含预算耗尽放行）才向前完成，所以它今天实际只在那一条支路上生效。
 */
export function legacyHandoffs(stage: {
  judge?: { maxFails: number | null } | null
  gate?: { maxFails: number } | null
  handoffWorkflowId?: string | null
  handoffStageId?: string | null
}): StageHandoff[] {
  const workflowId = stage.handoffWorkflowId ?? null
  if (workflowId === null) return []
  const stageId = stage.handoffStageId ?? null
  const auto: StageHandoffGuard =
    stage.judge !== undefined
      ? stage.judge === null
        ? 'done'
        : 'passed'
      : stage.gate != null
        ? 'passed'
        : 'done'
  return [
    { on: auto, workflowId, stageId },
    { on: 'manual', workflowId, stageId, forwardOnly: true },
  ]
}

/** 派单数组的深比较（保存前判断是否要落 `stage.updated`）。 */
export function sameHandoffs(
  a: readonly StageHandoff[] | null | undefined,
  b: readonly StageHandoff[] | null | undefined,
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      item.on === other.on &&
      item.workflowId === other.workflowId &&
      item.stageId === other.stageId &&
      (item.forwardOnly ?? true) === (other.forwardOnly ?? true)
    )
  })
}
