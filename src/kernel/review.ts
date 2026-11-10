/**
 * 评审结论的内核侧逻辑（M14）：定位、建行、逐条处置、覆盖判定。
 *
 * 三件事：
 *
 * 1. **定位（`locateReport`）按阶段图，不按时间序**。修复阶段要的是「把我打回这个阶段的
 *    那次评审」，不是「线程里最后一条 run」。判据：报告所属阶段的 `gate.onFailStageId` 或
 *    `onRejectStageId` 等于任务的当前阶段。命中多个取 `rev` 最大；同任务没有命中时才退回
 *    「该任务最新的报告」；再没有就沿 `handoffFromTaskId` / `parentTaskId` 上溯（链深 8）。
 *    绝不退回「读 `runs.output` 头部」——那正是被截断的老路径。
 *
 * 2. **建行（`reviewFactsOf`）**：回执带 `verdict` 或 `findings[]` 时产 `review.reported`，
 *    `rev` 按 `(taskId, stageId)` 递增，finding `id` 由内核拼成 `<reportId>#<key>`（不接受
 *    智能体自报 id）。判定证据 `checks` 一并入行，闸门不再「读一次就丢」。
 *
 * 3. **闭环（`applyAddresses` + 覆盖判定）**：修复回执的 `addresses[]` 逐条改 finding 状态，
 *    产 `review.addressed`；`fixed` 必须有同回执里退出码为 0 的 `checkRef`，`rejected` /
 *    `deferred` 必须写理由。当前阶段正是被该报告打回的目标阶段、且仍有 `open` 条目时
 *    **不推进**（硬门），并追加一条任务评论列出漏项。
 *
 * 全部纯函数：不读时钟、不读文件、不查库、不取随机数。
 */
import type { GateCheck, GateVerdict, RunRow, Task } from '../protocol/entities'
import type { Receipt } from '../protocol/inputs'
import type {
  FindingAddress,
  ReviewArtifact,
  ReviewFinding,
  ReviewFindingInput,
  ReviewReport,
} from '../protocol/review'
import { REVIEW_LIMITS } from '../protocol/review'
import type { ThreadRow } from '../protocol/thread'
import type { Actor, FactDraft, Id, Iso, View } from './types'

/** 报告定位与处置的结果：`facts` 直接并入回执决策，`blocked` 决定是否停住阶段流转。 */
export interface ReviewOutcome {
  facts: FactDraft[]
  /** 有未处置的评审条目（硬门）：调用方不得推进阶段 */
  blocked: boolean
}

const EMPTY: ReviewOutcome = { facts: [], blocked: false }

/** 该报告的所属阶段是否把任务打到 `stageId`（`gate.onFailStageId` / `onRejectStageId`）。 */
export function reportTargetsStage(view: View, report: ReviewReport, stageId: Id): boolean {
  const stage = view.stages.get(report.stageId)
  if (stage === undefined) return false
  return stage.gate?.onFailStageId === stageId || stage.onRejectStageId === stageId
}

/** 仍为 `open` 的条目（覆盖判定的唯一依据）。 */
export function openFindings(report: ReviewReport): ReviewFinding[] {
  return report.findings.filter((finding) => finding.status === 'open')
}

/** 同一 `(taskId, stageId)` 上已有的最大 `rev`；没有报告时为 0。 */
export function latestRev(view: View, taskId: Id, stageId: Id): number {
  let rev = 0
  for (const report of view.reviewReports.values()) {
    if (report.taskId !== taskId || report.stageId !== stageId) continue
    if (report.rev > rev) rev = report.rev
  }
  return rev
}

/** 报告排序：`rev` 大者优先，其次 `createdAt` 新，最后 id 大（确定性取最大）。 */
const newerReport = (a: ReviewReport | undefined, b: ReviewReport): ReviewReport => {
  if (a === undefined) return b
  if (b.rev !== a.rev) return b.rev > a.rev ? b : a
  if (b.createdAt !== a.createdAt) return b.createdAt > a.createdAt ? b : a
  return b.id > a.id ? b : a
}

/** 某任务名下被打回「当前阶段」的那份报告（没有则 undefined）。 */
const reportForStage = (view: View, task: Task): ReviewReport | undefined => {
  if (task.currentStageId === null) return undefined
  let found: ReviewReport | undefined
  for (const report of view.reviewReports.values()) {
    if (report.taskId !== task.id) continue
    if (!reportTargetsStage(view, report, task.currentStageId)) continue
    found = newerReport(found, report)
  }
  return found
}

/** 某任务名下最新的报告（不区分阶段）。 */
const latestReportOf = (view: View, taskId: Id): ReviewReport | undefined => {
  let found: ReviewReport | undefined
  for (const report of view.reviewReports.values()) {
    if (report.taskId !== taskId) continue
    found = newerReport(found, report)
  }
  return found
}

/**
 * 定位任务要看的评审报告。
 *
 * 顺序：① 打回到当前阶段的报告 → ② 该任务最新报告 → ③ 沿交接 / 父任务上溯同样的 ①②。
 * 上溯链深上限沿用交接口径（8），命中即停；全程不读 `runs.output`、不扫目录。
 */
export function locateReport(view: View, task: Task): ReviewReport | undefined {
  let current: Task | undefined = task
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    const hit = reportForStage(view, current) ?? latestReportOf(view, current.id)
    if (hit !== undefined) return hit
    const parentId: Id | null = current.handoffFromTaskId ?? current.parentTaskId
    current = parentId === null ? undefined : view.tasks.get(parentId)
  }
  return undefined
}

/**
 * 线程当前要呈现的评审报告：优先「还有 open 条目」的报告（那是待办），其次最新。
 *
 * 逐任务走 `locateReport`，因此交接 / 派生出来的线程也能取到上游任务的评审结论
 * （老实现只按 `thread.taskIds` 过滤，交接后整段上下文根本不会出现）。
 */
export function reportForThread(view: View, thread: ThreadRow): ReviewReport | undefined {
  let best: ReviewReport | undefined
  let bestPending = false
  for (const taskId of thread.taskIds) {
    const task = view.tasks.get(taskId)
    if (task === undefined) continue
    const report = locateReport(view, task)
    if (report === undefined) continue
    const pending = openFindings(report).length > 0
    if (best === undefined) {
      best = report
      bestPending = pending
      continue
    }
    if (pending !== bestPending) {
      if (pending) {
        best = report
        bestPending = true
      }
      continue
    }
    best = newerReport(best, report)
  }
  return best
}

/** 外部传进来的正文引用（宿主落盘后的结果）；缺省视为「正文没落盘」。 */
export type ArtifactRef = ReviewArtifact | null

const toFinding = (input: ReviewFindingInput, reportId: string, now: Iso): ReviewFinding => ({
  id: `${reportId}#${input.key.trim()}`,
  key: input.key.trim(),
  severity: input.severity,
  location: input.location?.trim() ? input.location.trim() : null,
  claim: input.claim.trim(),
  evidence: input.evidence?.trim() ? input.evidence.trim() : null,
  requiredAction: input.requiredAction.trim(),
  status: 'open',
  note: null,
  addressedByRunId: null,
  updatedAt: now,
})

/**
 * 回执 → `review.reported` 的报告行。
 *
 * `rev` 由内核按 `(taskId, stageId)` 递增；`id = '<runId>:<rev>'`。finding 的 `id` 由内核
 * 拼成 `<reportId>#<key>`，`key` 只在本次报告内唯一。
 */
export function buildReport(
  view: View,
  run: RunRow,
  taskId: Id,
  stageId: Id,
  verdict: GateVerdict | undefined,
  checks: readonly GateCheck[],
  findings: readonly ReviewFindingInput[],
  artifact: ArtifactRef,
  now: Iso,
): ReviewReport {
  const rev = latestRev(view, taskId, stageId) + 1
  const id = `${run.id}:${rev}`
  return {
    id,
    taskId,
    stageId,
    runId: run.id,
    threadId: run.threadId,
    rev,
    verdict: verdict ?? null,
    checks: [...checks],
    findings: findings
      .slice(0, REVIEW_LIMITS.maxFindings)
      .map((finding) => toFinding(finding, id, now)),
    artifact,
    createdAt: now,
    updatedAt: now,
  }
}

/** 校验一条处置是否成立：`fixed` 要有同回执里退出码 0 的 `checkRef`，其余要有理由。 */
function dispositionValid(address: FindingAddress, checks: readonly GateCheck[]): boolean {
  if (address.disposition === 'fixed') {
    const ref = address.checkRef?.trim() ?? ''
    if (ref === '') return false
    return checks.some((check) => check.cmd.trim() === ref && check.exitCode === 0)
  }
  return (address.note?.trim() ?? '') !== ''
}

/**
 * 把回执的 `addresses[]` 应用到报告行上。
 *
 * 只动**确实存在且仍为 `open`** 的条目：重复处置、未知 id、不满足处置条件的一律跳过
 * （幂等；重放同一条回执不会产生新的状态变化）。返回新的报告行与被关掉的 id 列表。
 */
export function applyAddresses(
  report: ReviewReport,
  addresses: readonly FindingAddress[],
  checks: readonly GateCheck[],
  runId: Id,
  now: Iso,
): { report: ReviewReport; addressed: Id[] } {
  const byId = new Map<string, FindingAddress>()
  for (const address of addresses.slice(0, REVIEW_LIMITS.maxAddresses)) {
    if (byId.has(address.findingId)) continue
    byId.set(address.findingId, address)
  }
  const addressed: Id[] = []
  const findings = report.findings.map((finding) => {
    const address = byId.get(finding.id)
    if (address === undefined || finding.status !== 'open') return finding
    if (!dispositionValid(address, checks)) return finding
    addressed.push(finding.id)
    return {
      ...finding,
      status: address.disposition === 'fixed' ? 'addressed' : address.disposition,
      note: address.note?.trim() ? address.note.trim() : null,
      addressedByRunId: runId,
      updatedAt: now,
    } satisfies ReviewFinding
  })
  if (addressed.length === 0) return { report, addressed }
  return { report: { ...report, findings, updatedAt: now }, addressed }
}

/** 漏项评论：把还没处置的条目写进任务上下文（人一眼能看到卡在哪）。 */
export function blockedCommentText(report: ReviewReport, open: readonly ReviewFinding[]): string {
  const ids = open
    .slice(0, 10)
    .map((finding) => finding.id)
    .join('、')
  const more = open.length > 10 ? ` 等 ${open.length} 条` : ''
  return (
    `评审清单（报告 rev ${report.rev}）还有未处置条目：${ids}${more}。` +
    '在回执块 `addresses` 里逐条回应（`fixed` 需带 `checkRef`，`rejected` / `deferred` 需写理由）后才会进入下一阶段。'
  )
}

/**
 * 回执 → 评审相关事实 + 硬门判定。
 *
 * - 本轮带 `verdict` 或 `findings[]` → 产 `review.reported`（建行 / 改版）；
 * - 本轮带 `addresses[]` 且定位到历史报告 → 产 `review.addressed`；
 * - 定位到的报告正打回当前阶段、处置后仍有 `open` 条目 → `blocked = true` 并附一条评论。
 *
 * 非阶段 run、任务不存在、当前阶段不是该报告的打回目标时，不产生硬门（避免误伤）。
 */
export function reviewFactsOf(
  view: View,
  run: RunRow,
  receipt: Receipt,
  artifact: ArtifactRef,
  actor: Actor,
  now: Iso,
): ReviewOutcome {
  if (run.purpose !== 'stage' || run.taskId === null) return EMPTY
  const task = view.tasks.get(run.taskId)
  if (task === undefined || run.stageId === null) return EMPTY
  const facts: FactDraft[] = []
  const declared = receipt.findings ?? []
  if (receipt.verdict !== undefined || declared.length > 0) {
    const report = buildReport(
      view,
      run,
      task.id,
      run.stageId,
      receipt.verdict,
      receipt.checks ?? [],
      declared,
      artifact,
      now,
    )
    facts.push({ type: 'review.reported', actor, at: now, payload: { report } })
  }
  const target = locateReport(view, task)
  if (target === undefined) return { facts, blocked: false }
  const applied = applyAddresses(target, receipt.addresses ?? [], receipt.checks ?? [], run.id, now)
  if (applied.addressed.length > 0) {
    facts.push({
      type: 'review.addressed',
      actor,
      at: now,
      payload: { report: applied.report, addressed: applied.addressed },
    })
  }
  const open = openFindings(applied.report)
  const blocked =
    open.length > 0 && reportTargetsStage(view, applied.report, task.currentStageId ?? '')
  if (!blocked) return { facts, blocked: false }
  facts.push({
    type: 'task.comment_added',
    actor,
    at: now,
    payload: {
      comment: {
        id: `review-blocked-${run.id}`,
        taskId: task.id,
        author: 'agent',
        text: blockedCommentText(applied.report, open),
        createdAt: now,
      },
    },
  })
  return { facts, blocked: true }
}
