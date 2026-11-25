/**
 * 硬门收口（M55）：评审阻断项没逐条处置时，既不推进阶段、也不静默停住。
 *
 * 两条路，区别只在「谁来收拾」：
 *
 * 1. **预算内**（`REPAIR_BUDGET`）：自动补一轮「只交 `addresses`」的回执（`addressRepairFacts`）
 *    ——修复工作与验证已在上一轮做完，缺的只是机器可读的逐条处置；
 * 2. **预算用尽**（`stageErroredFacts`）：产 `stage.errored` + 把任务移进内置「已阻塞」+
 *    一张 `kind='stall'` 停机卡 + 一条任务评论，等人接手。
 *
 * 这里单独成文件而不是继续堆在 `commands/run.ts` 里：域可以多文件，单文件有行数预算
 * （`scripts/check-kernel-budget.mjs`），而这段是「阶段走不动」的完整一套口径，自成一块。
 *
 * 全部纯函数：不读时钟、不读文件、不查库、不取随机数。
 */
import type { Card, RunRow, Task } from '@workbench/protocol/entities'
import { isTaskOver, taskPhaseOf } from '@workbench/protocol/entities'
import type { TaskComment } from '@workbench/protocol/task-comment'
import type { Decision, Environment, FactDraft, Id, Iso, View } from '../core/types'
import { stallDueAt, stallWatchList } from '../core/stall'
import { stallCardFacts } from './cards'
import { REPAIR_BUDGET, blockingFindings, repairRounds, type ReviewOutcome } from './review'
import { entryRunFacts } from './task-effects'
import { HOST_SCHEDULER, hostDraft } from './commands/common'

/** 阶段错误的原因（写进 `stage.errored.payload.reason`，`project` 不写表）。 */
export type StageErroredReason = 'review_unaddressed' | 'budget_exhausted' | 'stalled'

/** 出错定位：任务 + 阶段 + 触发的那一轮（评论 id 与审计用，不要求 run 还在跑）。 */
export interface StageErroredTarget {
  taskId: Id
  stageId: Id
  /** 触发收口的那一轮；静默哨兵用最近一轮的 id */
  runId: Id
}

/**
 * 硬门兜底（2026-11-21，M55 扩成有预算的补轮）：阻断项没处置时不推进阶段，自动补一轮
 * 「只交 `addresses`」的回执。
 *
 * 为什么自动补：修复工作与验证都已在上一轮完成，缺的只是机器可读的逐条处置；靠人点
 * 「重新执行」才能补，会让任务在界面上静默挂死（实测 2026-11-21 任务 `a6e02161` 挂了两小时）。
 *
 * 额度（M55）：同一份报告打回该阶段后最多补 `REPAIR_BUDGET` 轮。旧口径按「该阶段历史总
 * 轮次 > 1」就放弃，而修复阶段天然多轮（打回循环），于是第二次打回起**永远不补**——实测
 * 2026-11-24 任务 `8b76d466` 就死在这里。现在改为按本轮报告派生轮次（`repairRounds`），
 * 用完由调用方转成阶段错误（`stageErroredFacts`），不再零流转地停住。
 */
export function addressRepairFacts(
  view: View,
  run: RunRow,
  review: ReviewOutcome,
  now: Iso,
  env: Environment,
): FactDraft[] {
  if (review.report === undefined) return []
  const task = run.taskId === null ? undefined : view.tasks.get(run.taskId)
  const stage = run.stageId === null ? undefined : view.stages.get(run.stageId)
  if (task === undefined || stage === undefined) return []
  // 闸门自己的「没给结论」走 `receiptRepairText`；这里只管执行阶段缺评审处置。
  if (stage.entryMode !== 'agent' || stage.judge !== null) return []
  if (repairRounds(view, task, stage.id, review.report) > REPAIR_BUDGET) return []
  return entryRunFacts(view, task, now, env, HOST_SCHEDULER, undefined, {
    roundSession: 'resume',
    receiptRepair: 'addresses',
    review: review.report,
  })
}

/** 阶段错误的原因文案（评论 / 卡 / 知会共用一句话，不各写一套）。 */
function stageErroredText(stageName: string, review: ReviewOutcome): string {
  const open = review.report === undefined ? [] : blockingFindings(review.report)
  const ids = open
    .slice(0, 5)
    .map((finding) => finding.id)
    .join('、')
  const more = open.length > 5 ? ` 等 ${open.length} 条` : ''
  return open.length > 0
    ? `阶段「${stageName}」无法推进：评审补了 ${REPAIR_BUDGET} 轮回执仍缺逐条处置（${ids}${more}）。`
    : `阶段「${stageName}」无法推进：本份评审下已跑满 ${REPAIR_BUDGET} 轮补回执。`
}

/**
 * 阶段无法推进的收口（M55）：预算用尽不再「零流转地停住」，转成阶段错误 → 任务进
 * 内置「已阻塞」→ 产一张 `stall` 卡（系统通知 / IM 都会投）喊人接手。
 *
 * 为什么不用 `run.failed`：这一轮 run 是正常跑完的（exit 0），失败的是阶段能不能前进；
 * 混进 `run.failed` 会把执行器成功率与失败通知都说错。`stage.errored` 只表达原因，
 * 任务行由同批 `task.moved` 落。
 *
 * 为什么强制进内置「已阻塞」而不读 `exits.errored`：这条路径的语义是「机器停了」，不是
 * 业务上没过，不该由每个工作流的出口配置决定它去哪；人接手后拖回阶段即可，预算从那一刻
 * 重新计（见 `repairRounds` 的锚点）。
 */
export function stageErroredFacts(
  view: View,
  target: StageErroredTarget,
  review: ReviewOutcome,
  now: Iso,
  env: Environment,
  options?: { reason?: StageErroredReason; text?: string },
): FactDraft[] {
  const task = view.tasks.get(target.taskId)
  const stage = view.stages.get(target.stageId)
  if (task === undefined || stage === undefined) return []
  if (isTaskOver(taskPhaseOf(view.stages.get(task.currentStageId ?? '')))) return []
  const open = review.report === undefined ? [] : blockingFindings(review.report)
  const text = options?.text ?? stageErroredText(stage.name, review)
  const blocked = [...view.stages.values()].find(
    (item) => item.workflowId === task.workflowId && item.builtin === 'blocked',
  )
  const parked: Task =
    blocked === undefined || blocked.id === task.currentStageId
      ? { ...task, updatedAt: now }
      : { ...task, currentStageId: blocked.id, gateFailsByStage: {}, updatedAt: now }
  const facts: FactDraft[] = [
    {
      type: 'stage.errored',
      actor: HOST_SCHEDULER,
      at: now,
      payload: {
        task: parked,
        stage: stage.id,
        stageName: stage.name,
        reason: options?.reason ?? (open.length > 0 ? 'review_unaddressed' : 'budget_exhausted'),
        reportId: review.report?.id ?? null,
        findings: open.slice(0, 10).map((finding) => finding.id),
      },
    },
  ]
  if (parked.currentStageId !== task.currentStageId) {
    facts.push(
      hostDraft(
        'task.moved',
        { task: parked, from: task.currentStageId, to: parked.currentStageId },
        now,
      ),
    )
  }
  const comment: TaskComment = {
    id: `stage-errored-${target.runId}`,
    taskId: task.id,
    author: 'agent',
    text:
      `${text}任务已移到「已阻塞」，处理完把它拖回该阶段即可继续（补轮预算从拖回时刻重新计）。` +
      (review.report === undefined
        ? ''
        : `相关报告：rev ${review.report.rev}（${review.report.id}）。`),
    createdAt: now,
  }
  facts.push(hostDraft('task.comment_added', { comment }, now))
  facts.push(
    ...stallCardFacts(
      view,
      {
        task: parked,
        runId: target.runId,
        title: `任务停机待接手：${task.title}`,
        text,
      },
      now,
      env,
    ),
  )
  return facts
}

/**
 * 硬门命中后的去向（M55）：预算内补轮，预算用尽转阶段错误。
 *
 * 两条路都**不**推进阶段——区别只在「谁来收拾」：机器自己再试一次，还是把人叫来。
 * 返回值不带 `enter`：这两条路都不派新阶段，调用方不必处理进入效果。
 */
export function blockedTransition(
  view: View,
  run: RunRow,
  review: ReviewOutcome,
  now: Iso,
  env: Environment,
): { facts: FactDraft[] } {
  const repair = addressRepairFacts(view, run, review, now, env)
  if (repair.length > 0) return { facts: repair }
  if (run.taskId === null || run.stageId === null) return { facts: [] }
  return {
    facts: stageErroredFacts(
      view,
      { taskId: run.taskId, stageId: run.stageId, runId: run.id },
      review,
      now,
      env,
    ),
  }
}

/**
 * 进入「会喊人」的阶段时开一张停机卡（M55）。
 *
 * 与静默哨兵的分工：哨兵管「机器停了」，这里管「轮到你动手了」——两者在产物上是同一件事
 * （都需要人），所以复用同一个卡种与打扰口径（系统通知 / IM 都投、点一下停）。
 *
 * 判据全从事实里来，不看时钟：本批的 `task.moved` 目标阶段带 `notifyOnPark` 且不是内置阶段。
 * 放在决策出口（`decide`）而不是逐个命令里，是为了覆盖自动流转、人工拖拽、派单落点所有路径。
 * 跳过两种情形：本批已经为该任务开过停机卡；视图里已有一张开着的停机卡（不覆盖哨兵的文案）。
 */
export function parkNoticesOnEnter(
  view: View,
  decision: Decision,
  now: Iso,
  env: Environment,
): Decision {
  if (decision.facts.length === 0) return decision
  const facts = [...decision.facts]
  const covered = new Set<Id>()
  for (const fact of facts) {
    if (fact.type !== 'card.opened') continue
    const card = (fact.payload as { card: Card }).card
    if (card.kind === 'stall' && card.taskId !== null) covered.add(card.taskId)
  }
  for (const card of view.cards.values()) {
    if (card.kind === 'stall' && card.status === 'open' && card.taskId !== null) {
      covered.add(card.taskId)
    }
  }
  for (const fact of facts) {
    if (fact.type !== 'task.moved') continue
    const { task } = fact.payload as { task: Task }
    const stage = task.currentStageId === null ? undefined : view.stages.get(task.currentStageId)
    if (stage === undefined || (stage.builtin ?? null) !== null) continue
    // 只对「不派活」的阶段生效：会派活的阶段进入时已经有一轮 run，静默哨兵负责它的停机
    if (stage.entryMode === 'agent' || stage.entryMode === 'script') continue
    if (stage.notifyOnPark !== true) continue
    if (covered.has(task.id)) continue
    covered.add(task.id)
    facts.push(
      ...stallCardFacts(
        view,
        {
          task,
          // 这一路径没有「刚跑完的那一轮」：卡不依赖 run（`answerFacts` 对 stall 直接放行）
          runId: '',
          title: `轮到你：${stage.name}`,
          text: `任务已进入「${stage.name}」：这一步要人来做，机器不会自己往下走。做完把它拖到下一个阶段即可。`,
        },
        now,
        env,
      ),
    )
  }
  return facts.length === decision.facts.length ? decision : { ...decision, facts }
}

/**
 * 静默哨兵（M55）：`clock.tick` 每次醒来扫一遍「没人管的任务」，把它们收成阶段错误。
 *
 * 为什么需要兜底而不是只堵住已知路径：2026-11-24 那次静默的每一层都「看起来正常」——
 * run 成功了、阶段没动、没有报错。只修 `addresses` 那条路能救那一次，救不了下一条没想到
 * 的路径。判据见 `core/stall.ts`（没有活跃 run、没有开着的卡、会派活的阶段、静默 ≥10 分钟），
 * 命中就沿用同一套收口：`stage.errored{reason:'stalled'}` + 进「已阻塞」+ 停机卡 + 通知。
 */
export function stallSweepFacts(view: View, now: Iso, env: Environment): FactDraft[] {
  const facts: FactDraft[] = []
  for (const watch of stallWatchList(view)) {
    if (stallDueAt(watch) > now) continue
    const stage = view.stages.get(watch.stageId)
    const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(watch.endedAt)) / 60_000))
    facts.push(
      ...stageErroredFacts(
        view,
        { taskId: watch.task.id, stageId: watch.stageId, runId: watch.runId },
        { facts: [], blocked: true },
        now,
        env,
        {
          reason: 'stalled',
          text: `阶段「${stage?.name ?? watch.stageId}」已静默 ${minutes} 分钟：没有活跃运行，也没有在等回答的卡片。`,
        },
      ),
    )
  }
  return facts
}
