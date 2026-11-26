/**
 * 评审清单的提示词渲染（M14，2026-11-21 从 `thread-context` 抽出）。
 *
 * 同一份报告要出现在两个地方：线程上下文的「待修复清单」段，与修复轮任务提示词的
 * 「待处置评审清单」段。两处必须同源——否则修复轮拿到的清单和评审结论对不上，正是
 * 2026-11-21 那次「提示词里一条 finding 都没有」的成因之一。
 *
 * 口径：只内联**阻断项**（`blocker` / `high`）逐条；建议项（`medium` / `low`）只给计数
 * ——它们留痕但不要求处置。条数与字数双上限沿用线程索引的预算（`promptFindings` /
 * `reviewChars`），超出只记数不静默丢。
 */
import {
  isBlockingSeverity,
  REVIEW_LIMITS,
  type ReviewFinding,
  type ReviewReport,
} from '@workbench/protocol/review'
import { THREAD_LIMITS } from '@workbench/protocol/thread'

/** 严重度排序：`blocker` 最前（被截断时也先看到最重的）。 */
const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * 单条**阻断项**的索引行：**完整 finding id**（`<reportId>#<key>`，可直接粘进 `addresses`）/
 * 严重度 / 位置 / 断言 → 验收条件。
 *
 * 只服务阻断项（调用方按 `blocking` 过滤）：建议项不要求处置，也就不给验收条件，
 * 走的是另一段文案，不需要在这里判断严重度。
 */
function findingLine(finding: ReviewFinding): string {
  const place = finding.location === null ? '' : ` ${finding.location}`
  const claim = truncate(finding.claim, REVIEW_LIMITS.promptClaimChars)
  const acceptance = ` → 验收：${truncate(finding.requiredAction, REVIEW_LIMITS.promptClaimChars)}`
  return `- ${finding.id} [${finding.severity}]${place} — ${claim}${acceptance}`
}

/** 与线程上下文同口径的按码点截断（不把代理对切成半个字符）。 */
function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : text
}

/**
 * 报告 → 待修复清单段（确定性：同一报告同一文本，不含时钟）。
 *
 * @param level 标题级别：线程上下文里是 `###`，任务提示词里是 `##`（阶段容器内的小节）
 */
export function findingsText(report: ReviewReport, level = 3): string {
  if (report.findings.length === 0 && report.verdict === null) return ''
  const blocking = report.findings
    .filter((finding) => finding.status === 'open' && isBlockingSeverity(finding.severity))
    .sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.key.localeCompare(b.key),
    )
  const advisory = report.findings.filter(
    (finding) => finding.status === 'open' && !isBlockingSeverity(finding.severity),
  )
  const done = report.findings.length - blocking.length - advisory.length
  const verdict = report.verdict === null ? '无判定' : report.verdict
  const head =
    `${'#'.repeat(level)} 待修复清单（报告 rev ${report.rev}，${verdict}，` +
    `阻断 ${blocking.length} 条 / 建议 ${advisory.length} 条` +
    (done === 0 ? '）' : `，已处置 ${done}）`)
  const reference =
    report.artifact === null
      ? `（完整清单：报告 ${report.id}，运行 ${report.runId}）`
      : `（完整清单：${report.artifact.path}）`

  const lines: string[] = []
  let used = 0
  let shown = 0
  for (const finding of blocking.slice(0, REVIEW_LIMITS.promptFindings)) {
    const line = findingLine(finding)
    if (used + Array.from(line).length > THREAD_LIMITS.reviewChars) break
    used += Array.from(line).length
    lines.push(line)
    shown += 1
  }
  const rest = blocking.length - shown
  const out = [head, ...lines]
  if (rest > 0) {
    out.push(
      `…（还有 ${rest} 条阻断项未在此列出，是全部待办的一部分，见${reference.slice(1, -1)}）`,
    )
  }
  if (advisory.length > 0) {
    out.push(
      `另有 ${advisory.length} 条建议项（medium/low）：只留痕，不要求处置；` +
        '可用 `addresses` 顺手回应，不拦推进。',
    )
  }
  if (lines.length === 0 && advisory.length === 0) {
    out.push(`- 清单已全部处置。${reference}`)
    return out.join('\n')
  }
  out.push(reference)
  return out.join('\n')
}
