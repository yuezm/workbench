/**
 * 运行领取与租约（纯函数）：候选排序、按运行时开窗、`run.claimed` / `run.lease_extended` 事实。
 *
 * 内核不读时钟、不取随机数：`now` 与 `Limits` 由宿主注入，`leaseUntil` / `deadlineAt`
 * 只做「now + 时长」的纯算术（`new Date(iso)` 仅用于解析宿主传入的时刻，不读当前时间）。
 *
 * 排序口径见 SPEC-kernel「调度」：按 `notBefore` 升序、同序按 seq。`RunRow.queueSeq`
 * 是入队事实的 seq（由 `project` 在 `run.queued` 时回填），M1 存量导入的行没有
 * 各自的入队 seq，回退到 `createdAt` + `id` 保持稳定顺序。
 */
import type { RunRow, Runtime } from '../protocol/entities'
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
 */
export function pickClaims(view: View, runtime: Runtime, capacity: number, now: Iso): RunRow[] {
  const window = runtime.maxConcurrent - occupiedSlots(view, runtime.id)
  if (window <= 0) return []
  return claimCandidates(view, runtime.id, now).slice(0, Math.min(window, capacity))
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
