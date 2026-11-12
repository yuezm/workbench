/**
 * 运行命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { GateVerdict, RunRow, Task, WorkflowStage } from '../../protocol/entities'
import { STAGE_ROUND_LIMITS } from '../../protocol/entities'
import type { EventReceivedPayload } from '../../protocol/facts'
import type { Input, Receipt } from '../../protocol/inputs'
import type { TaskComment } from '../../protocol/task-comment'
import type { Decision, Environment, FactDraft, Id, Iso, Limits, View } from '../types'
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
import { reviewFactsOf } from '../review'
import { closeIfAllDone, inactivityFacts, makeNote, noteFacts, withNote } from '../threads'
import { stageRoundCount } from '../threads'
import { moveTask } from '../workflow/stage-machine'
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
 * 闸门判定归一（M11）：`pass` 必须带齐证据（至少一条 `checks` 且退出码全为 0），
 * 否则视为**没给结论**。不信任模型的自述——说通过却拿不出证据时任务原地停住等人，
 * 既不放行也不消耗预算。`fail` 不需要证据（失败本身就是要修）。
 */
function gateVerdictOf(receipt: Receipt): GateVerdict | undefined {
  const verdict = receipt.verdict
  if (verdict === undefined) return undefined
  if (verdict === 'fail') return 'fail'
  const checks = receipt.checks ?? []
  return checks.length > 0 && checks.every((check) => check.exitCode === 0) ? 'pass' : undefined
}

/** 闸门放行标记（M11）：预算耗尽后走通过分支时打在任务上的标签，看板可据此筛选。 */
export const GATE_DEGRADED_LABEL = 'gate:degraded'

/**
 * 验收自评里仍未达的条目（M21）：回执缺项、序号越界、`met` 非真都按**未达**处理
 * （fail-closed）。返回条目原文，顺序即阶段 `acceptance` 的顺序。
 */
export function unmetAcceptance(
  stage: Pick<WorkflowStage, 'acceptance'>,
  receipt: Receipt,
): string[] {
  const items = stage.acceptance ?? []
  if (items.length === 0) return []
  const met = new Set<number>()
  for (const check of receipt.acceptance ?? []) {
    if (
      check.met === true &&
      Number.isInteger(check.no) &&
      check.no >= 1 &&
      check.no <= items.length
    ) {
      met.add(check.no)
    }
  }
  return items.filter((_, index) => !met.has(index + 1))
}

/**
 * 该任务在该阶段已经跑过几轮（含刚结算的这一轮）。
 *
 * 实现搬到 `kernel/threads.ts`（M28）：派活（`task-effects`）也要用它决定「第 2 轮起换新会话」
 * 与提示词里的阶段轮次，而 `commands/run.ts` 已经 import `task-effects`，反向 import 会成环。
 * 这里保留出口，既有调用点与用例不必跟着搬家。
 */
export { stageRoundCount }

/**
 * 阶段内续轮留痕（M21）：本轮自评达成几条、未达哪几条，以及接下来是续轮还是按原规则流转。
 *
 * 这段是**资料**（任务评论）：它进下一轮的反馈记录段，不进指令段——未达项怎么补是 Agent 的判断。
 */
export function repairCommentText(
  round: number,
  total: number,
  unmet: readonly string[],
  exhausted: boolean,
): string {
  const lines = [
    `第 ${round} 轮验收自评：${total - unmet.length}/${total} 达成。`,
    '未达条目：',
    ...unmet.map((item, index) => `${index + 1}. ${item}`),
    exhausted
      ? '已达本阶段轮次上限，按原规则继续流转；未达项请在后续阶段或反馈里跟进。'
      : `按配置续第 ${round + 1} 轮：补上未达项，已达成的不必重做。`,
  ]
  return lines.join('\n')
}

/**
 * 阶段内多轮自修复（M21）：run 正常结束但验收未全达时，原地续一轮而不是流转。
 *
 * 判据全部确定性：验收条目来自阶段配置、达成情况来自回执、轮数来自既有 run 计数。
 * 以下情况零事实（走原规则）：验收未声明 / 全达 / run 不是 succeeded / 任务已完成 /
 * 阶段不是 agent 入口。轮数用尽时只留一条评论，不改任务状态、不额外打标签——
 * 流转仍由 `stageTransitionFacts` 决定，避免同批两个 `task.moved` 互相覆盖。
 */
function repairRoundFacts(
  view: View,
  run: SettledRun,
  receipt: Receipt,
  now: Iso,
  env: Environment,
): { facts: FactDraft[]; blocked: boolean } {
  const idle = { facts: [] as FactDraft[], blocked: false }
  if (run.status !== 'succeeded' || run.taskId === null) return idle
  const task = view.tasks.get(run.taskId)
  if (!task || task.status !== 'active' || task.currentStageId === null) return idle
  const stage = view.stages.get(task.currentStageId)
  if (!stage || stage.entryMode !== 'agent') return idle
  const total = (stage.acceptance ?? []).length
  if (total === 0) return idle
  const unmet = unmetAcceptance(stage, receipt)
  if (unmet.length === 0) return idle
  const rounds = stageRoundCount(view, task.id, stage.id)
  const configured = stage.maxRounds ?? STAGE_ROUND_LIMITS.min
  const maxRounds = Math.min(Math.max(configured, STAGE_ROUND_LIMITS.min), STAGE_ROUND_LIMITS.max)
  const exhausted = rounds >= maxRounds
  const comment: TaskComment = {
    id: env.nextId('task-comment'),
    taskId: task.id,
    author: 'agent',
    text: repairCommentText(rounds, total, unmet, exhausted),
    createdAt: now,
  }
  const facts: FactDraft[] = [hostDraft('task.comment_added', { comment }, now)]
  if (exhausted) return { facts, blocked: false }
  // 续轮的会话必须接上本轮：`taskSessions` 只认**终态** run，而本轮的结算事实还在同一批里
  // （视图尚未更新），所以这里显式回填本轮 sessionId，否则多轮之间会丢掉上下文记忆。
  const sessionId = run.sessionId ?? run.resumeSessionId
  const queued = entryRunFacts(view, task, now, env, HOST_SCHEDULER, undefined, {
    pendingComment: comment,
  }).map((fact) => ({
    ...fact,
    payload: {
      run:
        sessionId === null ? fact.payload.run : { ...fact.payload.run, resumeSessionId: sessionId },
    },
  }))
  facts.push(...queued)
  return { facts, blocked: true }
}

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

function withLabel(labels: readonly string[], label: string): string[] {
  return labels.includes(label) ? [...labels] : [...labels, label]
}

/**
 * 阶段 run 终态 → 阶段流转事实：成功进下一阶段（无下一阶段则完成），失败按
 * `onReject` 打回；闸门阶段（M11）按 `verdict` 分流，预算耗尽后放行并留痕。
 * 打回原地 / 任务已完成 / 阶段无效 / 任务已删时零事实，取消不推进。
 */
function stageTransitionFacts(
  view: View,
  run: SettledRun,
  verdict: GateVerdict | undefined,
  now: Iso,
  env: Environment,
): FactDraft[] {
  if (run.status === 'cancelled' || run.taskId === null) return []
  const task = view.tasks.get(run.taskId)
  if (!task || task.status === 'completed') return []
  const workflow = view.workflows.get(task.workflowId)
  if (!workflow) return []
  const flow = workflowWithStages(view, workflow)
  const current = flow.stages.find((stage) => stage.id === task.currentStageId)
  if (!current) return []
  const succeeded = run.status === 'succeeded'
  const event = succeeded
    ? ({ type: 'RUN_SUCCEEDED', runId: run.id, verdict } as const)
    : ({ type: 'RUN_FAILED', runId: run.id } as const)
  const moved = moveTask(task, event, flow)
  const next = moved.gateExhausted
    ? { ...moved.task, labels: withLabel(moved.task.labels, GATE_DEGRADED_LABEL) }
    : moved.task
  // M29：派单按触发条件分组——执行成功但被判定挡下是 `failed`，判定缺结论 / 打回原地
  // 都不算「离开」，一条都不派（与 M7 的「向前完成才交接」等价，但不再靠位置猜）。
  const leftStage =
    next.status === 'completed' ||
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
      text: degradedCommentText(current.name, current.gate?.maxFails),
      createdAt: now,
    }
    return [hostDraft('task.comment_added', { comment }, now)]
  }
  if (next.status === 'completed') {
    return [
      ...handoffFacts(),
      hostDraft('task.completed', { task: { ...next, updatedAt: now } }, now),
      ...degradedFacts(),
    ]
  }
  if (leftStage) {
    return [
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
    ]
  }
  return degradedFacts()
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
  const claimed = pickClaims(view, runtime, input.capacity, now)
  return done(
    claimFacts(claimed, now, env.limits, HOST_SCHEDULER, stageTimeoutOf(view, env.limits)),
  )
}

/**
 * 本轮超时（M26）：阶段自己配了 `runTimeoutMs` 用它，否则用全局 `limits.runTimeoutMs`。
 *
 * 阶段查找失败（stageId 指向不存在的行 / 聊天 run 没有阶段）一律回落全局缺省——
 * 超时算长一点不会破坏数据，算短了会把还在推理的 run 掐死。
 */
export function stageTimeoutOf(view: View, limits: Limits): (run: RunRow) => number {
  return (run) => {
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
  return done(heartbeatFacts(view, input.runId, input.leaseId, now, env.limits, HOST_SCHEDULER))
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
  const settled = settledRun(run, input.receipt, now)
  facts.push(...settlementFacts(settled, now, HOST_SCHEDULER))
  if (run.purpose === 'stage') {
    // M21 阶段内自修复：验收未全达且轮数未用尽 → 原地续一轮（不流转）
    const repair = review.blocked
      ? { facts: [] as FactDraft[], blocked: false }
      : repairRoundFacts(view, settled, input.receipt, now, env)
    // M14 硬门：评审清单还有未处置条目时不推进阶段——run 照常落终态、任务停在当前阶段，
    // 漏项由 `reviewFactsOf` 追加的任务评论说明「缺哪几条、怎么回应」。
    const transition =
      review.blocked || repair.blocked
        ? []
        : stageTransitionFacts(view, settled, gateVerdictOf(input.receipt), now, env)
    facts.push(...repair.facts)
    facts.push(...transition)
    // 进入效果：流转到目标阶段后若目标阶段是 agent 入口，立刻入队下一轮（形成链条）
    for (const fact of transition) {
      if (fact.type === 'task.moved') {
        const movedTask = (fact.payload as { task: Task }).task
        // M28：阶段流转进入的下一轮开新会话——上一轮正文与待修复清单已在提示词里，
        // 续接只是把上一阶段全量工具流水再送一遍。
        facts.push(
          ...entryRunFacts(view, movedTask, now, env, HOST_SCHEDULER, undefined, {
            roundSession: 'fresh',
          }),
        )
      }
      // M6.5：阶段流转把任务完成时，若线程内任务已全部完成 → 归档线程
      if (fact.type === 'task.completed') {
        const completedTask = (fact.payload as { task: Task }).task
        const thread =
          completedTask.threadId === null ? undefined : view.threads.get(completedTask.threadId)
        facts.push(
          ...closeIfAllDone(
            view,
            thread,
            now,
            HOST_SCHEDULER,
            new Map([[completedTask.id, 'completed']]),
          ),
        )
      }
    }
    // M8：任务完成 → 父任务 rollup（全部子任务结束才触发；批内去重 + 沿链级联）
    const settledOverrides = new Map<Id, 'completed'>()
    for (const fact of facts) {
      if (fact.type === 'task.completed') {
        settledOverrides.set((fact.payload as { task: Task }).task.id, 'completed')
      }
    }
    const rolledUp = new Set<Id>()
    for (let round = 0; round < 8; round += 1) {
      let changed = false
      for (const fact of [...facts]) {
        if (fact.type !== 'task.completed') continue
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
          if (item.type === 'task.completed') {
            settledOverrides.set((item.payload as { task: Task }).task.id, 'completed')
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
