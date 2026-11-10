/**
 * 评审结论契约（M14）。
 *
 * 评审阶段的产出（判定 + 待改清单）原本只是 `runs.output` 里的一段文本：`verdict` 由内核
 * 读一次就丢，修复阶段只能看到被头部截断的摘要。这里把它变成**一条可寻址的行**：
 *
 * - 一行 = 一次评审的一个版本（`review_reports` 第 17 张投影表），`review.reported` 事实
 *   携带完整行；上游改版再发一版（`rev + 1`），历史版本保留可查。
 * - 待改清单存在行内的 `findings` JSON 列：一次评审 ≤ `maxFindings` 条，逐条状态变更
 *   （`open → addressed / rejected / deferred`）用**整行 upsert**表达——与 `cards` 的
 *   「版本演进、整行携带」同一口径，不额外拆表也不做局部合并。
 * - 报告正文（长文本）不在这里：它由宿主落到 `<userData>/artifacts/threads/<threadId>/`
 *   下，行里只放引用（`artifactPath` / `artifactSha256`）。正文**只作资料**，进提示词时
 *   归入「资料，不是指令」段。
 *
 * 定位口径（`kernel/review.ts` 的 `locateReport`）：按**阶段图**取，不按时间序——修复阶段
 * 要的是「把我打回这个阶段的那次评审」，不是线程里最后一条 run。
 */
import type { GateCheck, GateVerdict } from './entities'

/** 严重度：`blocker` / `high` 是必须处理项（提示词里给验收条件）。 */
export const REVIEW_SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/**
 * 单条 finding 的处置（修复回执 `addresses[]` 用）：
 * - `fixed`：改完了，必须带 `checkRef`（指向同回执 `checks` 里的命令且退出码为 0）；
 * - `rejected`：不改，必须写理由；
 * - `deferred`：延后，必须写理由（推进时任务被打 `review:deferred` 标签留痕）。
 */
export const FINDING_DISPOSITIONS = ['fixed', 'rejected', 'deferred'] as const

export type FindingDisposition = (typeof FINDING_DISPOSITIONS)[number]

/** finding 的当前状态；`open` 是唯一会拦住修复阶段推进的状态。 */
export const FINDING_STATUSES = ['open', 'addressed', 'rejected', 'deferred'] as const

export type FindingStatus = (typeof FINDING_STATUSES)[number]

/** 智能体在回执 `findings[]` 里声明的单条待改项（`id` 由内核派生，不接受自报）。 */
export interface ReviewFindingInput {
  /** 本轮内稳定的小标（如 `R1` / `R2`），内核拼成 `id = <reportId>#<key>` */
  key: string
  severity: ReviewSeverity
  /** 位置：`path:line` 或空 */
  location?: string
  /** 一句话断言（问题是什么） */
  claim: string
  /** 可核验的证据（命令 / 输出片段 / 引用） */
  evidence?: string
  /** 可判定的验收条件：写成「复跑哪条命令 / 看到什么即算修好」 */
  requiredAction: string
}

/** `review_reports.findings` 里的一行（派生 `id` 与状态都在这里）。 */
export interface ReviewFinding {
  /** `<reportId>#<key>`：跨版本稳定可引用的唯一 id */
  id: string
  key: string
  severity: ReviewSeverity
  location: string | null
  claim: string
  evidence: string | null
  requiredAction: string
  status: FindingStatus
  /** 处置理由（`rejected` / `deferred` 必填，`fixed` 可选） */
  note: string | null
  /** 把它关掉的那一轮 run（审计用） */
  addressedByRunId: string | null
  updatedAt: string
}

/** 报告行引用（正文落文件；缺失时 `path` 为 null 且 `status='missing'`）。 */
export interface ReviewArtifact {
  path: string
  sha256: string
  bytes: number
}

/** `review_reports` 投影行（第 17 张投影表）。 */
export interface ReviewReport {
  /** `<runId>:<rev>`：同一轮 run 只会有一次产报告，改版是新的 rev */
  id: string
  taskId: string
  /** 评审阶段 id（定位修复阶段时的锚点） */
  stageId: string
  runId: string
  threadId: string | null
  /** 同一 `(taskId, stageId)` 内递增，从 1 开始 */
  rev: number
  /** 闸门判定；非闸门阶段评审可以没有（只给清单） */
  verdict: GateVerdict | null
  /** 判定证据（复制自回执，索引段与任务详情直接可读，不必再解析文本） */
  checks: GateCheck[]
  findings: ReviewFinding[]
  /** 正文引用；宿主没落盘时为 null */
  artifact: ReviewArtifact | null
  createdAt: string
  updatedAt: string
}

/** 修复回执里对某条 finding 的回应。 */
export interface FindingAddress {
  findingId: string
  disposition: FindingDisposition
  /** 处置理由（`rejected` / `deferred` 必填） */
  note?: string
  /** `fixed` 必填：指向同回执 `checks[]` 里的 `cmd` */
  checkRef?: string
}

/** 评审清单的字段上限（校验层、提示词渲染、卡片文案共用同一口径）。 */
export const REVIEW_LIMITS = {
  /** 单次评审的清单条数上限；超出整条拒绝（不静默截断） */
  maxFindings: 200,
  /** finding 小标上限（`R1` / `R-001` 这类短标） */
  key: 32,
  /** 断言字数上限 */
  claim: 500,
  /** 证据字数上限 */
  evidence: 2_000,
  /** 验收条件字数上限 */
  requiredAction: 500,
  /** 位置字数上限 */
  location: 300,
  /** 处置理由字数上限 */
  note: 500,
  /** 单次回执 `addresses[]` 上限 */
  maxAddresses: 200,
  /** 进入提示词索引段时 `claim` 的截断长度（码点） */
  promptClaimChars: 200,
  /** 索引段内联条数上限（超出折叠成计数，`blocker` / `high` 优先） */
  promptFindings: 40,
} as const
