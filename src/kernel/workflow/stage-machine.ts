import type {
  GateVerdict,
  JudgeConfig,
  StageExitGuard,
  StageExits,
  StagePrimary,
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../protocol/entities'

/** 进入某阶段后需要执行的效果（由 runner / UI 实际落地）。 */
export type StageEffect =
  { type: 'createRun'; stageId: string; agentId: string } | { type: 'waitUser' } | { type: 'none' }

/**
 * 阶段流转事件（只含自动流转；手动流转走 moveTaskToStage / completeTask）。
 *
 * `verdict` 只对判定阶段有意义（M11）：`run.status='succeeded'` 说明执行器跑完了，
 * `verdict` 才说明业务上过没过。缺省 = 没给结论，任务原地停住等人。
 */
export type StageEvent =
  | { type: 'RUN_SUCCEEDED'; runId: string; verdict?: GateVerdict }
  | { type: 'RUN_FAILED'; runId: string }

/** 流转结果；`gateExhausted` 供调用方打「闸门放行」留痕（M11）。 */
export interface MoveResult {
  task: Task
  effects: StageEffect[]
  /** 判定预算耗尽后按配置放行：本次是 fail 但走了通过分支 */
  gateExhausted?: boolean
}

/** 读取某阶段「进入时」应产生的效果。 */
export function entryEffects(stage: WorkflowStage): StageEffect[] {
  switch (stage.entryMode) {
    case 'agent':
      return stage.agentId ? [{ type: 'createRun', stageId: stage.id, agentId: stage.agentId }] : []
    case 'user':
      return [{ type: 'waitUser' }]
    default:
      return [{ type: 'none' }]
  }
}

function indexOfStage(workflow: WorkflowWithStages, stage: WorkflowStage): number {
  return workflow.stages.findIndex((s) => s.id === stage.id)
}

/**
 * 完成后进入的目标阶段；无下一阶段返回 null（表示任务完成）。
 *
 * M18 起默认只沿「自己添加的进行中阶段」往前走：内置的「已阻塞」是旁路状态，
 * 默认流转跳过它；没有下一阶段时落到内置「已完成」（同样只在当前阶段之后找，
 * 从「已完成」出发再成功即视为任务走完）。
 */
export function resolveNextStage(
  stage: WorkflowStage,
  workflow: WorkflowWithStages,
): WorkflowStage | null {
  // 显式配了「完成后进入」就按它；缺省才按顺序推
  const explicit = stage.exits.done
  if (explicit?.do === 'goto') {
    return workflow.stages.find((s) => s.id === explicit.stageId) ?? null
  }
  const idx = indexOfStage(workflow, stage)
  if (idx < 0) return null
  const rest = workflow.stages.slice(idx + 1)
  return rest.find((s) => s.builtin == null) ?? rest.find((s) => s.builtin === 'done') ?? null
}

/**
 * 缺省出口（M32）：落库前把每个触发条件的去向补齐，读到的就是完整形状。
 *
 * - `done` → 下一个自己添加的阶段 / 内置「已完成」/ 没有就 `close`（同一张工单走完）；
 * - `errored` → `await`（停在这里等人，与 M7「打回原地」等价，但现在是显式出口）；
 * - 判定阶段额外补 `passed`（同 `done` 的默认）与 `failed`（`await`）；
 * - 非判定阶段不保留 `passed` / `failed`；终态内置阶段没有出口。
 *
 * 幂等：已经是完整形状时原样返回同一批对象的内容。
 */
export function completeExits(stages: readonly WorkflowStage[]): WorkflowStage[] {
  return stages.map((stage, index) => {
    if (stage.builtin === 'done' || stage.builtin === 'cancelled') {
      return { ...stage, exits: {} }
    }
    const rest = stages.slice(index + 1)
    const next =
      rest.find((s) => s.builtin == null) ?? rest.find((s) => s.builtin === 'done') ?? null
    const fallback: StagePrimary =
      next === null ? { do: 'close' } : { do: 'goto', stageId: next.id }
    const exits: StageExits = { ...stage.exits }
    exits.done = exits.done ?? fallback
    exits.errored = exits.errored ?? { do: 'await' }
    if (stage.judge === null) {
      delete exits.passed
      delete exits.failed
    } else {
      exits.passed = exits.passed ?? fallback
      exits.failed = exits.failed ?? { do: 'await' }
    }
    return { ...stage, exits }
  })
}

/**
 * 进入阶段：产出新任务态与效果。
 *
 * `gateFails` 是判定预算的携带值：新进入一个阶段默认清零（M11），但失败回环要把
 * 累计次数带过去，否则「最多 3 次」永远到不了。
 */
export function enterStage(
  task: Task,
  stage: WorkflowStage,
  _workflow: WorkflowWithStages,
  gateFails = 0,
): { task: Task; effects: StageEffect[] } {
  return {
    task: { ...task, currentStageId: stage.id, status: 'active', gateFails },
    effects: entryEffects(stage),
  }
}

/**
 * 执行一条主去向（M32）：`goto` 换阶段、`await` 停住、`close` 归档。
 *
 * - `goto`：目标阶段不存在（脏投影 / 已删）时零流转，宁可不走；
 * - `await`：不产效果，`gateFails` 按传入值落下（判定预算要能累计）；
 * - `close`：任务 `completed`（工单走完），预算清零。
 *
 * M34 删掉 `retry`：执行阶段不设轮次，原地再来一轮只能由人触发（拖回阶段 / 重新执行）。
 */
export function applyExit(
  task: Task,
  exit: StagePrimary,
  workflow: WorkflowWithStages,
  options?: { gateFails?: number },
): { task: Task; effects: StageEffect[] } {
  switch (exit.do) {
    case 'goto': {
      const target = workflow.stages.find((stage) => stage.id === exit.stageId)
      // 目标不存在（脏投影）或就是当前阶段（旧数据里可能存过自指 goto）：不猜去向，原地停住。
      // 保存时 `validateStageSet` 已拦自指，这里只兜历史数据。
      if (!target || target.id === task.currentStageId) {
        return {
          task: options?.gateFails === undefined ? task : { ...task, gateFails: options.gateFails },
          effects: [],
        }
      }
      return enterStage(task, target, workflow, options?.gateFails ?? 0)
    }
    case 'await':
      return {
        task: options?.gateFails === undefined ? task : { ...task, gateFails: options.gateFails },
        effects: [],
      }
    case 'close':
      return { task: { ...task, status: 'completed', gateFails: 0 }, effects: [] }
  }
}

/**
 * 纯函数：根据事件推进任务到新阶段。
 * 不读写数据库、不 spawn；由调用方执行返回的 effects 并持久化 task。
 *
 * 判定阶段（M11）只改「成功」这一支：`RUN_FAILED` 仍走 `errored`，且**不消耗**判定预算
 * ——执行器崩了不等于业务上没过。
 */
export function moveTask(task: Task, event: StageEvent, workflow: WorkflowWithStages): MoveResult {
  const current = workflow.stages.find((s) => s.id === task.currentStageId)
  if (!current || task.status === 'completed') {
    return { task, effects: [] }
  }
  // 缺失的出口按顺序补（老行 / 刚加的阶段）：`completeExits` 是唯一一份缺省规则
  const currentExits = completeExits(workflow.stages).find((s) => s.id === current.id)?.exits ?? {}

  const follow = (guard: StageExitGuard, gateFails?: number): MoveResult => {
    const exit = currentExits[guard]
    if (exit === undefined) return { task, effects: [] }
    return applyExit(task, exit, workflow, gateFails === undefined ? undefined : { gateFails })
  }

  switch (event.type) {
    case 'RUN_SUCCEEDED': {
      if (current.judge === null) return follow('done')
      const verdict = event.verdict
      // 没给结论：既不白过也不烧预算，任务留在判定阶段等人（看板上可见）
      if (verdict === undefined) return { task, effects: [] }
      if (verdict === 'pass') return follow('passed')

      const fails = (task.gateFails ?? 0) + 1
      const maxFails = current.judge.maxFails
      if (maxFails !== null && fails >= maxFails) {
        // 预算耗尽：按配置放行，调用方据此打 `gate:degraded` 留痕
        return { ...follow('passed', 0), gateExhausted: true }
      }
      // 没有护栏（maxFails=null）时永远走 failed 那一侧
      return follow('failed', fails)
    }
    case 'RUN_FAILED':
      // 执行出错不清零预算：崩了不等于业务上没过
      return follow('errored', task.gateFails ?? 0)
  }
}

/**
 * 纯函数：看板拖拽 —— 把任务直接放到目标阶段，不套用出口表。
 * 任务已完成、目标不存在或就落在当前阶段时原样返回。人工落位视为重新开始，预算清零。
 */
export function moveTaskToStage(
  task: Task,
  stageId: string,
  workflow: WorkflowWithStages,
): { task: Task; effects: StageEffect[] } {
  const target = workflow.stages.find((s) => s.id === stageId)
  if (task.status === 'completed' || !target || target.id === task.currentStageId) {
    return { task, effects: [] }
  }
  return enterStage(task, target, workflow)
}

/** 纯函数：看板拖到「归档」区 —— 任务移出看板。 */
export function completeTask(task: Task): Task {
  return { ...task, status: 'completed' }
}

/** 老事实的判定者（M11 的 gate → M32 的 judge）：只保留护栏，去向搬进出口表。 */
export function legacyJudge(stage: {
  judge?: JudgeConfig | null
  gate?: { maxFails: number } | null
}): JudgeConfig | null {
  if (stage.judge !== undefined) return stage.judge ?? null
  return stage.gate === undefined || stage.gate === null ? null : { maxFails: stage.gate.maxFails }
}

/**
 * 老事实的出口表（M32）：四组旧字段 → 主去向。
 *
 * 只搬**显式配过**的去向；没配的留空，由启动补齐（`store.ensureBuiltinStages` 那一步）
 * 按实际顺序补缺省——「下一个阶段」取决于排序，归一阶段算不出来。
 */
export function legacyExits(stage: {
  exits?: StageExits
  gate?: { onPassStageId: string | null; onFailStageId: string | null } | null
  onCompleteStageId?: string | null
  onRejectStageId?: string | null
}): StageExits {
  // M34：`retry` 已删除——老事实 / 旧库里的「原地重跑」归一成「停在这里等人」，
  // 由人决定改配去向还是手动再跑（不猜用户想改成哪个阶段）。
  if (stage.exits !== undefined) return withoutRetry(stage.exits ?? {})
  const exits: StageExits = {}
  const complete = stage.onCompleteStageId ?? null
  if (complete !== null) exits.done = { do: 'goto', stageId: complete }
  const reject = stage.onRejectStageId ?? null
  if (reject !== null) exits.errored = { do: 'goto', stageId: reject }
  const gate = stage.gate ?? null
  if (gate !== null) {
    if (gate.onPassStageId !== null) exits.passed = { do: 'goto', stageId: gate.onPassStageId }
    if (gate.onFailStageId !== null) exits.failed = { do: 'goto', stageId: gate.onFailStageId }
  }
  return exits
}

/**
 * 老事实里的 `retry` 出口归一成 `await`（M34）。
 *
 * 类型层已没有这个动作（`STAGE_EXIT_ACTIONS` 只剩三种），但旧库 / 老事实的 JSON 里还留着，
 * 不归一会在重建后写进投影，再被 UI 读成「未知去向」。归一成 `await` 是有意的保守选择：
 * 不替用户猜目标阶段。
 */
function withoutRetry(exits: StageExits): StageExits {
  const result: StageExits = {}
  for (const [guard, exit] of Object.entries(exits) as Array<[StageExitGuard, unknown]>) {
    if (exit === null || exit === undefined) continue
    const action = (exit as { do?: string }).do
    result[guard] = action === 'retry' ? { do: 'await' } : (exit as StagePrimary)
  }
  return result
}
