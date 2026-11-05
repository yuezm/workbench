/**
 * 运行领取、租约与回执（纯函数）：候选排序、按运行时开窗、`run.claimed` /
 * `run.lease_extended` / 终态 / `run.waiting` / `run.receipt_rejected` 事实。
 *
 * 内核不读时钟、不取随机数：`now` 与 `Limits` 由宿主注入，`leaseUntil` / `deadlineAt`
 * 只做「now + 时长」的纯算术（`new Date(iso)` 仅用于解析宿主传入的时刻，不读当前时间）。
 *
 * 排序口径见 SPEC-kernel「调度」：按 `notBefore` 升序、同序按 seq。`RunRow.queueSeq`
 * 是入队事实的 seq（由 `project` 在 `run.queued` 时回填），M1 存量导入的行没有
 * 各自的入队 seq，回退到 `createdAt` + `id` 保持稳定顺序。
 */
import type { RunRow, RunTerminalStatus, Runtime } from '../protocol/entities'
import type { Receipt, RunHostSettledInput } from '../protocol/inputs'
import type { Actor, FactDraft, Id, Iso, Limits, View } from './types'

/** ISO 字符串比较（同格式时字典序即时间序；`now` 由宿主统一用 `toISOString` 产出）。 */
function compareIso(a: Iso, b: Iso): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** `now + ms` 的纯算术：`Date` 只解析注入的时刻，不读时钟。 */
function plusMs(now: Iso, ms: number): Iso {
  return new Date(Date.parse(now) + ms).toISOString()
}

/**
 * 领取排序：`notBefore` 升序（null = 立即可领，排最前），同序按入队 seq，
 * 再按 `createdAt`、`id` 兜底（存量导入行没有各自的 queueSeq）。
 */
export function claimOrder(a: RunRow, b: RunRow): number {
  return (
    compareIso(a.notBefore ?? '', b.notBefore ?? '') ||
    a.queueSeq - b.queueSeq ||
    compareIso(a.createdAt, b.createdAt) ||
    compareIso(a.id, b.id)
  )
}

/**
 * 该运行时当前占用的并发位：只数 `running`。
 * `waiting` 已释放租约与并发位（D12），`queued` 尚未占用，都不计数。
 */
export function occupiedSlots(view: View, runtimeId: Id): number {
  let count = 0
  for (const run of view.runs.values()) {
    if (run.runtimeId === runtimeId && run.status === 'running') count += 1
  }
  return count
}

/** 领取候选：该运行时下 `queued` 且 `notBefore` 已到（null = 立即）的 run，已按 FIFO 排好。 */
export function claimCandidates(view: View, runtimeId: Id, now: Iso): RunRow[] {
  const candidates: RunRow[] = []
  for (const run of view.runs.values()) {
    if (run.runtimeId !== runtimeId || run.status !== 'queued') continue
    if (run.notBefore !== null && run.notBefore > now) continue
    candidates.push(run)
  }
  return candidates.sort(claimOrder)
}

/**
 * 本次实际领取的 run：窗口 = `maxConcurrent − running 数`，最多
 * `min(window, capacity)`（capacity 已由 decide 校验为 1–8）。
 *
 * M6.5 线程闸门：同一线程同时 `running` 数 ≥ `thread.concurrency`（缺省 1）时跳过它的
 * 候选；跨线程互不影响。`waiting` 不占位（已释放租约与并发位），`queued` 尚未占位。
 */
export function pickClaims(view: View, runtime: Runtime, capacity: number, now: Iso): RunRow[] {
  const window = runtime.maxConcurrent - occupiedSlots(view, runtime.id)
  if (window <= 0) return []
  const runningByThread = new Map<Id, number>()
  for (const run of view.runs.values()) {
    if (run.status !== 'running' || run.threadId === null) continue
    runningByThread.set(run.threadId, (runningByThread.get(run.threadId) ?? 0) + 1)
  }
  const picked: RunRow[] = []
  const limit = Math.min(window, capacity)
  for (const run of claimCandidates(view, runtime.id, now)) {
    if (picked.length >= limit) break
    if (run.threadId !== null) {
      const thread = view.threads.get(run.threadId)
      const concurrency = thread?.concurrency ?? 1
      const used = runningByThread.get(run.threadId) ?? 0
      if (used >= concurrency) continue
      runningByThread.set(run.threadId, used + 1)
    }
    picked.push(run)
  }
  return picked
}

/**
 * `run.claimed` 事实：`attempt` = 当前领取次数 + 1（1 基），
 * `leaseId = '<runId>:<attempt>'`、`leaseUntil = now + leaseMs`、`deadlineAt = now + runTimeoutMs`。
 */
export function claimFacts(
  claimed: readonly RunRow[],
  now: Iso,
  limits: Limits,
  actor: Actor,
): FactDraft<'run.claimed'>[] {
  const leaseUntil = plusMs(now, limits.leaseMs)
  const deadlineAt = plusMs(now, limits.runTimeoutMs)
  return claimed.map((run) => {
    const attempt = run.attempt + 1
    const leaseId = `${run.id}:${attempt}`
    const next: RunRow = {
      ...run,
      status: 'running',
      leaseId,
      attempt,
      leaseUntil,
      deadlineAt,
      startedAt: run.startedAt ?? now,
    }
    return { type: 'run.claimed', actor, at: now, payload: { run: next } }
  })
}

/**
 * `run.lease_extended` 事实：`leaseId` 必须等于当前租约，否则零事实。
 * 不产 reject——心跳由调度器定时发，过期租约的迟到心跳只应静默丢弃，避免噪音。
 */
export function heartbeatFacts(
  view: View,
  runId: Id,
  leaseId: string,
  now: Iso,
  limits: Limits,
  actor: Actor,
): FactDraft<'run.lease_extended'>[] {
  const run = view.runs.get(runId)
  if (!run || run.leaseId !== leaseId) return []
  const next: RunRow = { ...run, leaseUntil: plusMs(now, limits.leaseMs) }
  return [{ type: 'run.lease_extended', actor, at: now, payload: { run: next } }]
}

// ---------- 回执 ----------

/** 终态 run 行：`status` 已归一，后续按事实名分派。 */
export type SettledRun = RunRow & { status: RunTerminalStatus }

/** 回执被拒原因（写进 `run.receipt_rejected.reason`，供 why 链审计）。 */
export type ReceiptRejectionReason = 'terminal' | 'lease_mismatch' | 'turn_mismatch'

const isTerminalStatus = (status: RunRow['status']): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled'

/**
 * 回执校验（SPEC-kernel「调度」）：先看终态，再比租约，最后比轮次。
 * - `terminal`：run 已落终态，迟到 / 重复回执只审计；
 * - `lease_mismatch`：旧 attempt 或别的租约；
 * - `turn_mismatch`：上一轮的回执。
 */
export function receiptRejection(run: RunRow, receipt: Receipt): ReceiptRejectionReason | null {
  if (isTerminalStatus(run.status)) return 'terminal'
  if (run.leaseId !== receipt.leaseId) return 'lease_mismatch'
  if (run.turn !== receipt.turn) return 'turn_mismatch'
  return null
}

/** 迟到 / 重复 / 不匹配回执的审计事实：只记账，不覆盖终态（D10）。 */
export function rejectedReceiptFacts(
  run: RunRow,
  receipt: Receipt,
  reason: ReceiptRejectionReason,
  now: Iso,
  actor: Actor,
): FactDraft<'run.receipt_rejected'>[] {
  return [
    {
      type: 'run.receipt_rejected',
      actor,
      at: now,
      payload: { runId: run.id, leaseId: receipt.leaseId, turn: receipt.turn, reason },
    },
  ]
}

/**
 * 用回执构造终态 run 行：终态归一、写用量与退出信息、清租约与超时时刻（D5/D10）。
 *
 * `error` 取回执里的失败文案（给人看），`errorCode` 仍是归类；成功终态恒为 null
 * （成功回执即使带了 error 也不落库）。
 */
export function settledRun(run: RunRow, receipt: Receipt, now: Iso): SettledRun {
  const status = receipt.status
  const errorCode =
    status === 'succeeded'
      ? null
      : (receipt.errorCode ?? (status === 'failed' ? 'run_failed' : 'cancelled'))
  return {
    ...run,
    status,
    output: receipt.output ?? run.output,
    error: status === 'succeeded' ? null : (receipt.error ?? null),
    errorCode,
    exitCode: receipt.exitCode ?? null,
    sessionId: receipt.sessionId ?? run.sessionId,
    usage: receipt.usage ?? run.usage,
    durationMs: receipt.durationMs ?? null,
    endedAt: now,
    leaseId: null,
    leaseUntil: null,
    deadlineAt: null,
  }
}

/** 终态事实：按归一后的 status 产 `run.succeeded` / `run.failed` / `run.cancelled`。 */
export function settlementFacts(
  run: SettledRun,
  now: Iso,
  actor: Actor,
): FactDraft<'run.succeeded' | 'run.failed' | 'run.cancelled'>[] {
  switch (run.status) {
    case 'succeeded':
      return [{ type: 'run.succeeded', actor, at: now, payload: { run } }]
    case 'failed':
      return [{ type: 'run.failed', actor, at: now, payload: { run } }]
    case 'cancelled':
      return [{ type: 'run.cancelled', actor, at: now, payload: { run } }]
  }
}

/**
 * 回执带 `ask[]`：挂起等回答（D12）。释放租约与超时时刻（并发位由 `occupiedSlots`
 * 只数 `running` 自然让出）；会话 id 记在 run 上供续接。`cardIds` 是本次 `ask` 产生的
 * 卡片 id（M4 由 `kernel/cards.ts` 生成后传入），信息卡不进这里。
 */
export function waitingRun(run: RunRow, receipt: Receipt): RunRow & { status: 'waiting' } {
  return {
    ...run,
    status: 'waiting',
    sessionId: receipt.sessionId ?? run.sessionId,
    leaseId: null,
    leaseUntil: null,
    deadlineAt: null,
  }
}

export function waitingFacts(
  run: RunRow & { status: 'waiting' },
  cardIds: readonly Id[],
  now: Iso,
  actor: Actor,
): FactDraft<'run.waiting'>[] {
  return [{ type: 'run.waiting', actor, at: now, payload: { run, cardIds: [...cardIds] } }]
}

// ---------- 时间与宿主兜底 ----------

/** 租约是否已过期（只有 running 持有租约）。 */
export function leaseExpired(run: RunRow, now: Iso): boolean {
  return run.status === 'running' && run.leaseUntil !== null && run.leaseUntil <= now
}

/** 运行是否已到单次超时时刻（只有 running 有 deadline）。 */
export function deadlineReached(run: RunRow, now: Iso): boolean {
  return run.status === 'running' && run.deadlineAt !== null && run.deadlineAt <= now
}

/** 退避时长：`backoffBaseMs × 2^(attempts-1)`，封顶 `backoffCapMs`（SPEC-kernel「调度」）。 */
export function backoffMs(attempts: number, limits: Limits): number {
  return Math.min(limits.backoffBaseMs * 2 ** (attempts - 1), limits.backoffCapMs)
}

/** 终态 run 行（失败/取消）：清租约与超时时刻、写 endedAt，其余按调用方覆盖。 */
function terminalRow(run: RunRow, now: Iso, over: Partial<RunRow>): RunRow {
  return {
    ...run,
    endedAt: now,
    leaseId: null,
    leaseUntil: null,
    deadlineAt: null,
    ...over,
  }
}

/**
 * 租约过期（D3）：`attempts+1` 后回 `queued` + 退避（`notBefore = now + backoff`），
 * 达到 `maxAttempts` 时改为 `run.failed{executor_lost}`，不再入队。
 */
export function abandonedFacts(
  run: RunRow,
  now: Iso,
  limits: Limits,
  actor: Actor,
): FactDraft<'run.abandoned' | 'run.failed' | 'run.cancelled'>[] {
  // 已请求取消但宿主没来得及落终态（取消后崩溃 / 强杀）：不再重排执行，
  // 直接补取消终态，否则重新领取后 `run.cancel` 幂等返回零事实，run 会不可取消地执行完。
  if (run.cancelRequested) {
    return [
      {
        type: 'run.cancelled',
        actor,
        at: now,
        payload: {
          run: terminalRow(run, now, {
            status: 'cancelled',
            error: '已取消',
            errorCode: 'cancelled',
          }),
        },
      },
    ]
  }
  const attempts = run.attempts + 1
  if (attempts >= limits.maxAttempts) {
    const failed = terminalRow(run, now, {
      status: 'failed',
      error: null,
      errorCode: 'executor_lost',
      attempts,
    })
    return [{ type: 'run.failed', actor, at: now, payload: { run: failed } }]
  }
  const next: RunRow = {
    ...run,
    status: 'queued',
    attempts,
    notBefore: plusMs(now, backoffMs(attempts, limits)),
    leaseId: null,
    leaseUntil: null,
    deadlineAt: null,
  }
  return [{ type: 'run.abandoned', actor, at: now, payload: { run: next } }]
}

/** 单次运行超时（D5）：`deadlineAt` 到期 → `run.failed{errorCode:'timeout'}`，actor 由调用方给 host/timeout。 */
export function timeoutFacts(run: RunRow, now: Iso, actor: Actor): FactDraft<'run.failed'>[] {
  const failed = terminalRow(run, now, { status: 'failed', error: null, errorCode: 'timeout' })
  return [{ type: 'run.failed', actor, at: now, payload: { run: failed } }]
}

/**
 * 宿主兜底终态（D14）：执行器不可达 / 超时无回执 / 取消无回执时由宿主写终态。
 *
 * 只在 run 非终态且（可选的）`leaseId` / `turn` 与当前轮匹配时产事实；重复或迟到的
 * `run.host_settled` 返回零事实（幂等）。宿主兜底不产成功终态。
 */
export function hostSettledFacts(
  run: RunRow,
  input: RunHostSettledInput,
  now: Iso,
  actor: Actor,
): FactDraft<'run.failed' | 'run.cancelled'>[] {
  if (isTerminalStatus(run.status) || input.status === 'succeeded') return []
  if (input.leaseId !== undefined && run.leaseId !== input.leaseId) return []
  if (input.turn !== undefined && run.turn !== input.turn) return []
  const status = input.status
  const next = terminalRow(run, now, {
    status,
    error: input.error ?? null,
    errorCode: input.errorCode ?? (status === 'failed' ? 'executor_lost' : 'cancelled'),
    output: input.output ?? run.output,
    sessionId: input.sessionId ?? run.sessionId,
    usage: input.usage ?? run.usage,
    exitCode: input.exitCode ?? null,
    durationMs: input.durationMs ?? null,
  })
  return status === 'failed'
    ? [{ type: 'run.failed', actor, at: now, payload: { run: next } }]
    : [{ type: 'run.cancelled', actor, at: now, payload: { run: next } }]
}
