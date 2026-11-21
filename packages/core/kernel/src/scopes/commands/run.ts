/**
 * 运行命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type {
  GateCheck,
  GateVerdict,
  RunRow,
  Task,
  WorkflowStage,
} from '@workbench/protocol/entities'
import { isTaskOver, taskPhaseOf } from '@workbench/protocol/entities'
import type { EventReceivedPayload } from '@workbench/protocol/facts'
import type { Input, Receipt } from '@workbench/protocol/inputs'
import type { TaskComment } from '@workbench/protocol/task-comment'
import type { Decision, Environment, FactDraft, Id, Iso, Limits, View } from '../../core/types'
import type { SettledRun } from '../run'
import { cardsFromReceipt, expiredCardFacts, resumedRun } from '../cards'
import { handoffOnExit } from '../handoff'
import { handoffGuardOf } from '../workflow/stage-handoffs'
import { laterPrompt } from '../prompt'
import {
  abandonedFacts,
  claimFacts,
  deadlineReached,
  heartbeatFacts,
  hostSettledFacts,
  leaseExpired,
  pickClaims,
  receiptRejection,
  rejectedReceiptFacts,
  settledRun,
  settlementFacts,
  timeoutFacts,
  waitingFacts,
  waitingRun,
} from '../run'
import { cronTaskFacts, eventThreadFacts } from '../rules'
import { childrenSettledFacts, spawnFacts } from '../spawn'
import { entryRunFacts } from '../task-effects'
import { reviewFactsOf, type ReviewOutcome } from '../review'
import {
  batchTaskPhases,
  closeIfAllDone,
  inactivityFacts,
  makeNote,
  noteFacts,
  threadWithBatchTasks,
  withNote,
} from '../threads'
import { stageRoundCount } from '../threads'
import { moveTask, terminalOutcomeOf } from '../workflow/stage-machine'
import {
  chatMessageFacts,
  CONCURRENCY_CAP,
  CONCURRENCY_FLOOR,
  done,
  HOST_CANCEL,
  HOST_SCHEDULER,
  HOST_TIMER,
  HOST_TIMEOUT,
  hostDraft,
  ownerDraft,
  reject,
  truncateSummary,
  workflowWithStages,
} from './common'
import { revalidateMandate, revokeMandate } from '../mandate'

/** 回执派生事件（D8）：每条事件一个 `event.received`，`hops = 父 run.hops + 1`。 */
function eventFacts(run: RunRow, receipt: Receipt, now: Iso, env: Environment): FactDraft[] {
  const events = receipt.events ?? []
  if (events.length === 0) return []
  const hops = run.hops + 1
  return events.map((event) => {
    const eventId = env.nextId('event')
    if (hops > env.limits.maxHops) {
      return {
        type: 'event.dropped',
        actor: HOST_SCHEDULER,
        at: now,
        payload: { eventId, hops, reason: 'max_hops' },
      }
    }
    return {
      type: 'event.received',
      actor: HOST_SCHEDULER,
      at: now,
      payload: {
        eventId,
        source: event.source,
        type: event.type,
        subject: event.subject,
        summary: truncateSummary(event.summary ?? ''),
        detailRef: null,
        link: event.link ?? null,
        hops,
        originRunId: run.id,
        dedupeKey: event.dedupeKey ?? null,
      },
    }
  })
}

/**
 * 「没给结论」的具体原因（R4）：文案要能指向真正的问题。
 *
 * 旧口径只知道「没有 verdict」，文案却一律落到验收覆盖分支——本轮明明一条证据都没有，
 * 却提示「第 1 条验收没有全 0 的证据」，把排查带到了补证据上。
 */
export type GateNoConclusion =
  | { kind: 'missing_verdict' }
  | { kind: 'no_checks' }
  | { kind: 'checks_not_zero' }
  | { kind: 'uncovered'; index: number; total: number }
  | { kind: 'no_exit_code'; errorCode: string | null }

/** 闸门判定归一的结果：给结论，或给出「为什么没结论」。 */
export type GateOutcome = { verdict: GateVerdict } | { noConclusion: GateNoConclusion }

/**
 * 闸门判定归一（M11/M34/M40）：两条闸门共用一套证据口径——`checks[]`（逐条退出码）
 * 加 `acceptance: n`（1 基序号指向验收条目），缺证据就是**没给结论**。
 *
 * - 智能体闸门：结论来自回执 `verdict`；`pass` 要求至少一条 `checks`、退出码全 0、
 *   且每条验收都被一条全 0 的证据指向；
 * - 脚本闸门：结论来自进程退出码。非 0 是进程事实，脚本自报的 `checks` 再好看也不翻案；
 *   退出码 0 且脚本给了 `checks` 时，同样要求全 0 并逐条覆盖验收（漏一条算没给结论）；
 *   退出码 0 而脚本没给 `checks` 时，退出码就是全部结论（此时验收条目只是配置记录）。
 *
 * 不给结论时任务原地停住：既不放行也不消耗预算（`fail` 不需要证据——失败本身就是要修）。
 */
function gateVerdictOf(receipt: Receipt, stage: WorkflowStage, run: RunRow): GateOutcome {
  const checks = receipt.checks ?? []
  const uncovered = (): GateOutcome => {
    const index = coversAcceptance(checks, stage)
    return index === null
      ? { verdict: 'pass' }
      : { noConclusion: { kind: 'uncovered', index, total: checks.length } }
  }
  if ((run.script ?? null) !== null) {
    // 拿不到退出码（超时 / 被杀 / 起不来）：没给结论
    if (run.exitCode === null) {
      return { noConclusion: { kind: 'no_exit_code', errorCode: run.errorCode ?? null } }
    }
    // 非 0 是进程事实：先钉死，再看证据
    if (run.exitCode !== 0) return { verdict: 'fail' }
    // 没给证据：退出码即结论
    if (checks.length === 0) return { verdict: 'pass' }
    // 证据里有非 0：脚本自己报了没过，按没过算（不回退成退出码 0 的通过）
    if (!checks.every((check) => check.exitCode === 0)) return { verdict: 'fail' }
    return uncovered()
  }
  const verdict = receipt.verdict
  if (verdict === undefined) return { noConclusion: { kind: 'missing_verdict' } }
  if (verdict === 'fail') return { verdict: 'fail' }
  // `pass` 必须有全 0 的证据；没有证据的「通过」不算结论
  if (checks.length === 0) return { noConclusion: { kind: 'no_checks' } }
  if (!checks.every((check) => check.exitCode === 0)) {
    return { noConclusion: { kind: 'checks_not_zero' } }
  }
  return uncovered()
}

/**
 * 每条验收是否都被一条 `checks` 用 `acceptance: n`（1 基）指向。
 *
 * 全被覆盖返回 `null`；否则返回第一条没被覆盖的 1 基序号（由调用方给文案）。
 * 调用方已保证「证据全 0」与「至少一条证据」；验收为空时恒成立，序号越界
 * （指向不存在的验收）不算覆盖。
 */
function coversAcceptance(checks: readonly GateCheck[], stage: WorkflowStage): number | null {
  const covered = new Set(
    checks.map((check) => check.acceptance).filter((no): no is number => no !== undefined),
  )
  const index = (stage.acceptance ?? []).findIndex((_, position) => !covered.has(position + 1))
  return index < 0 ? null : index + 1
}

/** 闸门放行标记（M11）：预算耗尽后走通过分支时打在任务上的标签，看板可据此筛选。 */
export const GATE_DEGRADED_LABEL = 'gate:degraded'

/**
 * 脚本闸门结算归一（M40）：「进程跑完了、退出码非 0」是业务没过，不是执行出错。
 *
 * `command` 执行器把非 0 退出报成 `failed` + `exit_nonzero`；闸门阶段要把它翻成
 * `succeeded`（业务结论交给 `gateVerdictOf`），否则出口表的 `failed` 边永远走不到。
 * 非闸门脚本阶段不翻：命令跑挂了就是执行出错，走 `errored` 边。
 */
function scriptGateSettled(
  run: RunRow,
  receipt: Receipt,
  stage: WorkflowStage | undefined,
  now: Iso,
): SettledRun {
  const settled = settledRun(run, receipt, now)
  const gated = (run.script ?? null) !== null && stage !== undefined && stage.judge !== null
  if (gated && settled.status === 'failed' && settled.errorCode === 'exit_nonzero') {
    return { ...settled, status: 'succeeded', error: null, errorCode: null }
  }
  return settled
}

/**
 * 该任务在该阶段已经跑过几轮（含刚结算的这一轮）。
 *
 * 实现搬到 `kernel/threads.ts`（M28）：派活（`task-effects`）也要用它决定「第 2 轮起换新会话」，
 * 而 `commands/run.ts` 已经 import `task-effects`，反向 import 会成环。
 * 这里保留出口，既有调用点与用例不必跟着搬家。
 */
export { stageRoundCount }

/**
 * 闸门放行留痕的文案：预算次数取自闸门配置（脏数据缺省 0）。
 *
 * 单独成函数，是为了让「缺省」这一支能被单测直接覆盖：文案在产品路径上只在
 * 「预算耗尽且闸门配置完整」时拼得出，缺省那一侧永远走不到。
 */
export function degradedCommentText(
  stageName: string,
  maxFails: number | null | undefined,
): string {
  return `闸门「${stageName}」已连续 ${maxFails ?? 0} 次未通过，按配置放行（任务已打 ${GATE_DEGRADED_LABEL} 标签）。`
}

/**
 * 闸门「没给结论」的留痕文案（M49 / R4）：任务原地停、零流转，界面上原来看不出为什么。
 *
 * 每种原因分开说：没有 verdict、pass 但没证据、证据里有非 0、某条验收没被覆盖、
 * 脚本闸门拿不到退出码。纯函数，`now` / id 都由调用方给。
 */
export function noConclusionCommentText(stage: WorkflowStage, reason: GateNoConclusion): string {
  const head = `闸门「${stage.name}」没给结论：`
  const tail = '任务停在原地。'
  switch (reason.kind) {
    case 'missing_verdict':
      return `${head}本轮回执里没有 \`verdict\`（也没有被接收的 \`ask\`）。补一次判定，或重跑这一轮。${tail}`
    case 'no_checks':
      return `${head}给了 \`pass\` 但一条 \`checks\` 都没有；\`pass\` 必须带全 0 的证据。补证据后重跑这一轮。${tail}`
    case 'checks_not_zero':
      return `${head}给了 \`pass\`，但证据里有非 0 退出码。先修再判，不要为了让流程前进而填 pass。${tail}`
    case 'uncovered':
      return `${head}第 ${reason.index} 条验收没有全 0 的证据（本轮 ${reason.total} 条）。给这条验收补一步，或重跑这一轮。${tail}`
    case 'no_exit_code':
      return `${head}这一轮没拿到退出码（${reason.errorCode ?? '原因未知'}）。看本轮步骤证据后重跑，或改脚本配置。${tail}`
  }
}

function withLabel(labels: readonly string[], label: string): string[] {
  return labels.includes(label) ? [...labels] : [...labels, label]
}

/**
 * 阶段 run 终态 → 阶段流转事实：成功进下一阶段（无下一阶段则完成），失败按
 * `onReject` 打回；闸门阶段（M11）按 `verdict` 分流，预算耗尽后放行并留痕。
 * 打回原地 / 任务已完成 / 阶段无效 / 任务已删时零事实，取消不推进。
 */
/** 阶段结算的结果：要落的事实 + 需要立刻入队入口 run 的任务（流转 / 原地重跑）。 */
interface StageTransition {
  facts: FactDraft[]
  enter?: Task
}

/**
 * 硬门兜底（2026-11-21）：阻断项没处置时不推进阶段，但自动补一轮「只交 `addresses`」的回执。
 *
 * 为什么自动补：修复工作与验证都已在上一轮完成，缺的只是机器可读的逐条处置；靠人点
 * 「重新执行」才能补，会让任务在界面上静默挂死（实测 2026-11-21 任务 `a6e02161` 挂了两小时）。
 *
 * 只补**一次**（该阶段已跑过 ≥2 轮就不再派）：第二次仍缺说明模型稳定给不出格式，
 * 交给人处理，不自动循环——与 R5「闸门补回执只补一次」同一纪律。
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
  if (stageRoundCount(view, task.id, stage.id) > 1) return []
  return entryRunFacts(view, task, now, env, HOST_SCHEDULER, undefined, {
    roundSession: 'resume',
    receiptRepair: 'addresses',
    review: review.report,
  })
}

function stageTransitionFacts(
  view: View,
  run: SettledRun,
  outcome: GateOutcome | undefined,
  now: Iso,
  env: Environment,
): StageTransition {
  if (run.status === 'cancelled' || run.taskId === null) return { facts: [] }
  const task = view.tasks.get(run.taskId)
  if (!task) return { facts: [] }
  const workflow = view.workflows.get(task.workflowId)
  if (!workflow) return { facts: [] }
  const flow = workflowWithStages(view, workflow)
  const current = flow.stages.find((stage) => stage.id === task.currentStageId)
  if (!current) return { facts: [] }
  // M53：任务已经停在终态阶段（完成 / 取消）时，迟到的结算只落 run 终态，不再流转
  if (isTaskOver(taskPhaseOf(current))) return { facts: [] }
  const succeeded = run.status === 'succeeded'
  const verdict = outcome !== undefined && 'verdict' in outcome ? outcome.verdict : undefined
  const noConclusion =
    outcome !== undefined && 'noConclusion' in outcome ? outcome.noConclusion : undefined
  const event = succeeded
    ? ({ type: 'RUN_SUCCEEDED', runId: run.id, verdict } as const)
    : ({ type: 'RUN_FAILED', runId: run.id } as const)
  const moved = moveTask(task, event, flow)
  const next = moved.gateExhausted
    ? { ...moved.task, labels: withLabel(moved.task.labels, GATE_DEGRADED_LABEL) }
    : moved.task
  // M29：派单按触发条件分组——执行成功但被判定挡下是 `failed`，判定缺结论 / 打回原地
  // 都不算「离开」，一条都不派（与 M7 的「向前完成才交接」等价，但不再靠位置猜）。
  const targetStage =
    next.currentStageId === null ? undefined : flow.stages.find((s) => s.id === next.currentStageId)
  /** 终态阶段的完成口径（M53）：落到内置「已完成 / 已取消」即完成 */
  const finishOutcome = terminalOutcomeOf(targetStage)
  const leftStage =
    moved.archive === true ||
    (next.currentStageId !== null && next.currentStageId !== task.currentStageId)
  const guard = leftStage
    ? handoffGuardOf(current, {
        kind: 'run',
        status: run.status,
        verdict,
        gateExhausted: moved.gateExhausted === true,
      })
    : null
  const handoffFacts = (): FactDraft[] =>
    guard === null
      ? []
      : handoffOnExit(view, task, current, guard, now, env, HOST_SCHEDULER, {
          runId: run.id,
        })
  /** 预算耗尽放行时的留痕：任务评论（详情页可见，不改状态） */
  const degradedFacts = (): FactDraft[] => {
    if (moved.gateExhausted !== true) return []
    const comment: TaskComment = {
      id: env.nextId('task-comment'),
      taskId: task.id,
      author: 'agent',
      text: degradedCommentText(current.name, current.judge?.maxFails),
      createdAt: now,
    }
    return [hostDraft('task.comment_added', { comment }, now)]
  }
  /**
   * 闸门没给结论时的留痕（M49）：任务停在原地、零流转，界面上看不出为什么。
   * 只在「确实停在闸门里」时留一句，跟着去向走的情形（errored 出口）不加噪音。
   */
  const noConclusionFacts = (): FactDraft[] => {
    if (leftStage || current.judge === null || noConclusion === undefined) return []
    const comment: TaskComment = {
      id: env.nextId('task-comment'),
      taskId: task.id,
      author: 'agent',
      text: noConclusionCommentText(current, noConclusion),
      createdAt: now,
    }
    return [hostDraft('task.comment_added', { comment }, now)]
  }
  if (finishOutcome !== null || moved.archive === true) {
    // M53：完成 = 落到终态阶段（或出口 `close` 直接结束并归档），两者都产 `task.finished`
    const settled: Task = { ...next, updatedAt: now }
    return {
      facts: [
        ...handoffFacts(),
        hostDraft(
          'task.moved',
          { task: settled, from: task.currentStageId, to: settled.currentStageId },
          now,
        ),
        hostDraft('task.finished', { task: settled, outcome: finishOutcome ?? 'done' }, now),
        ...(moved.archive === true
          ? [hostDraft('task.archived', { task: { ...settled, archivedAt: now } }, now)]
          : []),
        ...degradedFacts(),
      ],
    }
  }
  if (leftStage) {
    return {
      facts: [
        ...handoffFacts(),
        hostDraft(
          'task.moved',
          {
            task: { ...next, updatedAt: now },
            from: task.currentStageId,
            to: next.currentStageId,
          },
          now,
        ),
        ...degradedFacts(),
      ],
      enter: next,
    }
  }
  // 阶段没变 = 没有去向（判定没给结论 / 打回原地 / 停在这里等人）：只留可能的放行留痕
  // 与「为什么停下」的说明。M34 删掉 `retry` 后不再有「原地重排一轮」这条路径——重跑只能由人触发。
  return { facts: [...degradedFacts(), ...noConclusionFacts()] }
}

export function claimRun(
  view: View,
  input: Extract<Input, { type: 'run.claim' }>,
  now: Iso,
  env: Environment,
): Decision {
  const runtime = view.runtimes.get(input.runtimeId)
  if (!runtime) return reject('not_found', '运行时不存在: ' + input.runtimeId)
  if (!runtime.enabled) return reject('conflict', '运行时未启用: ' + input.runtimeId)
  if (
    !Number.isInteger(input.capacity) ||
    input.capacity < CONCURRENCY_FLOOR ||
    input.capacity > CONCURRENCY_CAP
  ) {
    return reject('invalid_input', '领取数量必须是 1–8 的整数')
  }
  // A2：领活前按授权重校验——已撤销的不领（零事实），重校验失败当场撤销并留痕
  const picked = pickClaims(view, runtime, input.capacity, now)
  const mandateFacts: FactDraft[] = []
  const claimed = picked.filter((run) => {
    if (run.taskId === null) return true
    const mandate = view.mandates?.get(run.taskId)
    if (mandate === undefined) return true
    if (mandate.revokedAt !== null) return false
    const verdict = revalidateMandate(mandate, view.authority ?? null)
    if (verdict.ok) return true
    mandateFacts.push({
      type: 'mandate.revalidated',
      actor: { kind: 'kernel' },
      at: now,
      payload: {
        mandateId: mandate.id,
        taskId: mandate.taskId,
        ok: false,
        reason: verdict.reason,
        policyVersion: view.rulesVersion,
      },
    })
    mandateFacts.push({
      type: 'mandate.revoked',
      actor: { kind: 'kernel' },
      at: now,
      payload: { mandate: revokeMandate(mandate, 'revalidate', now) },
    })
    return false
  })
  return done([
    ...mandateFacts,
    ...claimFacts(claimed, now, env.limits, HOST_SCHEDULER, stageTimeoutOf(view, env.limits)),
  ])
}

/**
 * 本轮超时（M26）：阶段自己配了 `runTimeoutMs` 用它，否则用全局 `limits.runTimeoutMs`。
 *
 * 阶段查找失败（stageId 指向不存在的行 / 聊天 run 没有阶段）一律回落全局缺省——
 * 超时算长一点不会破坏数据，算短了会把还在推理的 run 掐死。
 */
export function stageTimeoutOf(view: View, limits: Limits): (run: RunRow) => number {
  return (run) => {
    // M40：脚本自己配的超时最优先（脚本轮询类命令通常比阶段短得多）
    const scriptTimeout = run.script?.timeoutMs ?? null
    if (scriptTimeout !== null) return scriptTimeout
    if (run.stageId === null) return limits.runTimeoutMs
    const stage = view.stages.get(run.stageId)
    return stage?.runTimeoutMs ?? limits.runTimeoutMs
  }
}

export function heartbeatRun(
  view: View,
  input: Extract<Input, { type: 'run.heartbeat' }>,
  now: Iso,
  env: Environment,
): Decision {
  // 租约不匹配只静默丢弃：心跳由调度器定时发，产 reject 只会变成噪音（D1）
  return done(
    heartbeatFacts(
      view,
      input.runId,
      input.leaseId,
      now,
      env.limits,
      HOST_SCHEDULER,
      input.sessionId,
    ),
  )
}

export function recordRunFrames(
  view: View,
  input: Extract<Input, { type: 'run.frames' }>,
  now: Iso,
): Decision {
  const run = view.runs.get(input.runId)
  // run 已终态 / 已删 / 轮次变了：帧无处可写，静默丢弃
  if (!run || run.status !== 'running' || run.turn !== input.turn) return done([])
  return done([
    {
      type: 'run.frames',
      actor: HOST_SCHEDULER,
      at: now,
      payload: { runId: input.runId, turn: input.turn, frames: input.frames },
    },
  ])
}

export function receiveRun(
  view: View,
  input: Extract<Input, { type: 'run.receipt' }>,
  now: Iso,
  env: Environment,
): Decision {
  const run = view.runs.get(input.runId)
  if (!run) return reject('not_found', '运行不存在: ' + input.runId)
  const rejection = receiptRejection(run, input.receipt)
  if (rejection !== null) {
    return done(rejectedReceiptFacts(run, input.receipt, rejection, now, HOST_SCHEDULER))
  }
  const receiptCards = cardsFromReceipt(view, run, input.receipt, now, env)
  // M14：评审结论 / 逐条处置 / 硬门判定（阶段图定位，不读 runs.output 摘要）
  const review = reviewFactsOf(
    view,
    run,
    input.receipt,
    input.receipt.artifact ?? null,
    HOST_SCHEDULER,
    now,
  )
  const derivedEvents = eventFacts(run, input.receipt, now, env)
  const facts: FactDraft[] = [...receiptCards.facts, ...review.facts, ...derivedEvents]
  // M6：回执派生的 event.received 同样命中规则；M6.5：按父 run 归线程/父任务
  for (const derived of derivedEvents) {
    if (derived.type !== 'event.received') continue
    facts.push(
      ...eventThreadFacts(
        view,
        derived.payload as EventReceivedPayload,
        view.rulesVersion,
        now,
        env,
      ),
    )
  }
  // M8：回执 spawn[] → 子任务（父任务 id 由内核从 run.taskId 推导，Agent 自报忽略）
  if (input.receipt.spawn !== undefined && input.receipt.spawn.length > 0) {
    facts.push(...spawnFacts(view, run, input.receipt.spawn, now, env, HOST_SCHEDULER))
  }
  // M6.5：回执 notes[] → 线程笔记（run 没挂线程 / 线程不存在时忽略）
  const receiptNotes = input.receipt.notes
  if (run.threadId !== null && receiptNotes !== undefined && receiptNotes.length > 0) {
    const thread = view.threads.get(run.threadId)
    if (thread !== undefined) {
      let current = thread
      for (const text of receiptNotes) {
        const note = makeNote(env, 'agent', text, now)
        current = withNote(current, note, now)
        facts.push(...noteFacts(current, note, HOST_SCHEDULER, now))
      }
    }
  }
  // 回执带 ask：先建卡再挂起等回答，释放租约与并发位，不落终态（D5/D12）
  if ((input.receipt.ask?.length ?? 0) > 0) {
    facts.push(
      ...waitingFacts(waitingRun(run, input.receipt), receiptCards.cardIds, now, HOST_SCHEDULER),
    )
    return done(facts)
  }
  // 只有 later（无 ask/notices）时不落终态：回 queued 到点复查，不重建会话（D7）
  if (input.receipt.later && (input.receipt.notices?.length ?? 0) === 0) {
    facts.push(
      hostDraft('run.queued', { run: resumedRun(run, laterPrompt(), input.receipt.later) }, now),
    )
    return done(facts)
  }
  // M40：脚本闸门阶段的「跑完了但没过」按 succeeded 落（业务结论交给 verdict）。
  // 不归一的话 `command` 执行器报的 failed 会让 failed 边永远走不到。
  const stage = run.stageId === null ? undefined : view.stages.get(run.stageId)
  const settled = scriptGateSettled(run, input.receipt, stage, now)
  facts.push(...settlementFacts(settled, now, HOST_SCHEDULER))
  if (run.purpose === 'stage') {
    // M14 硬门：评审清单还有未处置条目时不推进阶段——run 照常落终态、任务停在当前阶段，
    // 漏项由 `reviewFactsOf` 追加的任务评论说明「缺哪几条、怎么回应」。
    // M34：执行阶段不看业务结论（succeeded 即成功）；只有闸门阶段读回执 `verdict`，
    // 且 `pass` 要逐条覆盖验收条目（见 `gateVerdictOf`）。
    const outcome =
      stage === undefined || stage.judge === null
        ? undefined
        : gateVerdictOf(input.receipt, stage, settled)
    const transition = review.blocked
      ? { facts: addressRepairFacts(view, run, review, now, env) }
      : stageTransitionFacts(view, settled, outcome, now, env)
    facts.push(...transition.facts)
    // 进入效果：流转到目标阶段 / 原地重跑后立刻入队下一轮（形成链条）
    if (transition.enter !== undefined) {
      // M28：阶段流转进入的下一轮开新会话——上一轮正文与待修复清单已在提示词里，
      // 续接只是把上一阶段全量工具流水再送一遍。
      facts.push(
        ...entryRunFacts(view, transition.enter, now, env, HOST_SCHEDULER, undefined, {
          roundSession: 'fresh',
          review: review.report,
        }),
      )
    }
    for (const fact of transition.facts) {
      // M6.5：阶段流转把任务完成时，若线程内任务已全部完成 → 归档线程。
      // M50：同一批里可能刚派出一张落回本话题的新卡——它还没进视图，归档判定必须把它算成 active。
      if (fact.type === 'task.finished') {
        const completedTask = (fact.payload as { task: Task }).task
        const thread =
          completedTask.threadId === null ? undefined : view.threads.get(completedTask.threadId)
        const overrides = batchTaskPhases(facts)
        facts.push(
          ...closeIfAllDone(
            view,
            threadWithBatchTasks(thread, facts),
            now,
            HOST_SCHEDULER,
            overrides,
          ),
        )
      }
    }
    // M8：任务完成 → 父任务 rollup（全部子任务结束才触发；批内去重 + 沿链级联）
    const settledOverrides = batchTaskPhases(facts)
    const rolledUp = new Set<Id>()
    for (let round = 0; round < 8; round += 1) {
      let changed = false
      for (const fact of [...facts]) {
        if (fact.type !== 'task.finished') continue
        const completedTask = (fact.payload as { task: Task }).task
        if (completedTask.parentTaskId === null || rolledUp.has(completedTask.parentTaskId))
          continue
        const extra = childrenSettledFacts(
          view,
          completedTask.parentTaskId,
          now,
          env,
          HOST_SCHEDULER,
          settledOverrides,
        )
        if (extra.length === 0) continue
        rolledUp.add(completedTask.parentTaskId)
        facts.push(...extra)
        for (const item of extra) {
          if (item.type === 'task.finished') {
            const { task, outcome } = item.payload as {
              task: Task
              outcome: 'done' | 'cancelled'
            }
            settledOverrides.set(task.id, outcome === 'done' ? 'finished' : 'cancelled')
          }
        }
        changed = true
      }
      if (!changed) break
    }
  }
  if (run.purpose === 'chat') {
    facts.push(...chatMessageFacts(view, run, settled, now, env))
    // 续接会话 id 记到对话上：下一轮直接用它续接，避免整段历史重发（D8）
    const conversation =
      run.conversationId === null ? undefined : view.conversations.get(run.conversationId)
    if (conversation && settled.sessionId !== null) {
      facts.push(
        hostDraft(
          'conversation.updated',
          { conversation: { ...conversation, sessionId: settled.sessionId, updatedAt: now } },
          now,
        ),
      )
    }
  }
  return done(facts)
}

export function cancelRun(
  view: View,
  input: Extract<Input, { type: 'run.cancel' }>,
  now: Iso,
): Decision {
  const run = view.runs.get(input.runId)
  if (!run) return reject('not_found', '运行不存在: ' + input.runId)
  if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') {
    return reject('conflict', '运行已结束，无法取消: ' + input.runId)
  }
  // 重复取消幂等：已请求过就零事实，等宿主按取消时序落终态
  if (run.cancelRequested) return done([])
  return done([
    ownerDraft(
      'run.cancel_requested',
      { run: { ...run, cancelRequested: true }, by: 'owner' },
      now,
    ),
  ])
}

export function settleRunByHost(
  view: View,
  input: Extract<Input, { type: 'run.host_settled' }>,
  now: Iso,
  env: Environment,
): Decision {
  const run = view.runs.get(input.runId)
  if (!run) return reject('not_found', '运行不存在: ' + input.runId)
  const actor = input.status === 'cancelled' ? HOST_CANCEL : HOST_SCHEDULER
  const facts: FactDraft[] = hostSettledFacts(run, input, now, actor)
  // 聊天 run 由宿主兜底落终态时同样补一条 assistant 消息（中断/取消/超时都要可见）
  if (run.purpose === 'chat') {
    for (const fact of facts) {
      if (fact.type !== 'run.failed' && fact.type !== 'run.cancelled') continue
      const settled = (fact.payload as { run: RunRow }).run as SettledRun
      facts.push(...chatMessageFacts(view, settled, settled, now, env))
    }
  }
  return done(facts)
}

export function tickClock(view: View, now: Iso, env: Environment): Decision {
  // 唯一定时器到点：先判整体超时（终态），再看租约过期（放弃 / 重试），然后卡片超时、cron 规则。
  const facts: FactDraft[] = []
  for (const run of view.runs.values()) {
    if (deadlineReached(run, now)) {
      facts.push(...timeoutFacts(run, now, HOST_TIMEOUT))
    } else if (leaseExpired(run, now)) {
      facts.push(...abandonedFacts(run, now, env.limits, HOST_TIMER))
    }
  }
  // M28：等人超过时限的 ask 卡关闭并续接一轮（不让任务挂在「等人拍板」上过夜）
  facts.push(...expiredCardFacts(view, now))
  // M6：cron 规则到点建任务（同刻只触发一次；停机错过只补最近一次）
  facts.push(...cronTaskFacts(view, now, env, env.timezone))
  // M6.5：14 天无活动的 open 线程归档（只影响 UI 检索，不改任务/运行）
  facts.push(...inactivityFacts(view, now, HOST_TIMER))
  return done(facts)
}
