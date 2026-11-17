/**
 * 准入契约（A1）：来源身份、准入表、接受模式、上限与归一。
 *
 * 归属：`@workbench/protocol/authority`，只放类型、常量与**纯归一函数**——不读写文件、
 * 不读时钟、不认识具体产品。`Authority` 不单独成表：它作为 `RuleSetRow.authority` 的
 * 可选块随 `rules.replace` 整批替换，版本号就是 `rulesVersion`（见 SPEC-authority §概念）。
 *
 * 兼容口径：规则集里没有 `authority` 块时用 `compatAuthority()`，行为等价 M45
 * 「事件命中即建任务」；历史行、缺字段、非法值一律经 `normalizeAuthority` 收敛，
 * 让投影重建与实时写入走同一条路径。
 */

import type { Access } from './entities'

/** 来源种类：只影响缺省值推导，内核不认具体产品名。 */
export type SourceKey = 'manual' | 'app' | 'webhook' | 'feishu' | 'github'

/** 事件发起者：人、机器人、系统（手工任务 / app 事件 / 执行器派生）。 */
export const IDENTITY_KINDS = ['human', 'bot', 'system'] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]

export interface EventIdentity {
  kind: IdentityKind
  /** 来源内稳定标识：GitHub login、飞书 open_id、app id；system 用 `unknown` */
  id: string
  /** 是否直接点名智能体（mention / direct）；手工与系统事件恒 true */
  addressed: boolean
}

/** 准入强度：明确请求 vs 推断候选。 */
export type Strength = 'explicit' | 'inferred'

/** 强度依据：谁因为什么被准入。 */
export type AdmissionBasis = 'addressed' | 'followup' | 'table' | 'bot' | 'manual'

/** 接受模式：不接推断 / 只记「本来会接」/ 允许自动接单。 */
export const ACCEPT_MODES = ['off', 'observe', 'auto'] as const
export type AcceptMode = (typeof ACCEPT_MODES)[number]

/** 准入表单元格：明确请求 / 推断候选 / 忽略。 */
export const ADMISSION_CELLS = ['explicit', 'inferred', 'ignore'] as const
export type AdmissionCell = (typeof ADMISSION_CELLS)[number]

/** 准入拒绝的原因码（写进 `event.denied.reason`，与 `event.skipped` 严格区分）。 */
export const ADMISSION_REASONS = [
  'not-listed',
  'mode-off',
  'bot-not-listed',
  'no-rule',
  'assess-failed',
] as const
export type AdmissionReason = (typeof ADMISSION_REASONS)[number]

export interface AdmissionTable {
  /** 名单内、点名：缺省 explicit */
  listedAddressed: AdmissionCell
  /** 名单内、未点名：缺省 inferred；仅 `receiveAll` 作用域生效 */
  listedUnaddressed: AdmissionCell
  /** 名单外、点名：缺省 ignore */
  unlistedAddressed: AdmissionCell
  /** 名单外、未点名：缺省 ignore */
  unlistedUnaddressed: AdmissionCell
  /** 机器人（另需在 `bots` 名单）：缺省 inferred */
  botAddressed: AdmissionCell
}

export interface SourcePolicy {
  /** 与 `event.source` 相等的键 */
  id: string
  /** 允许发起工作的身份（来源内 id） */
  allowed: string[]
  /** 允许产生推断候选的机器人 */
  bots: string[]
  /** 是否接收未点名消息，决定未点名那两格是否生效 */
  receiveAll: boolean
  admission: AdmissionTable
}

export interface Authority {
  mode: AcceptMode
  sources: SourcePolicy[]
  /** 研判用的智能体；null = 不做语义研判（A3） */
  assessorAgentId: string | null
  /** 单批候选上限 */
  assessBatch: number
  /** 攒批窗口，毫秒 */
  assessWindowMs: number
}

/** 形状上限（`protocol/validate` 与内核同口径，超限拒收而不是截断）。 */
export const AUTHORITY_LIMITS = {
  sources: 32,
  identitiesPerSource: 200,
  sourceId: 64,
  identityId: 128,
  assessBatchMin: 1,
  assessBatchMax: 20,
  assessWindowMsMax: 60_000,
} as const

export const DEFAULT_ADMISSION_TABLE: AdmissionTable = {
  listedAddressed: 'explicit',
  listedUnaddressed: 'inferred',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore',
  botAddressed: 'inferred',
}

const COMPAT_BATCH = 8
const COMPAT_WINDOW_MS = 5000

export const isAcceptMode = (value: unknown): value is AcceptMode =>
  typeof value === 'string' && (ACCEPT_MODES as readonly string[]).includes(value)

export const isAdmissionCell = (value: unknown): value is AdmissionCell =>
  typeof value === 'string' && (ADMISSION_CELLS as readonly string[]).includes(value)

export const isIdentityKind = (value: unknown): value is IdentityKind =>
  typeof value === 'string' && (IDENTITY_KINDS as readonly string[]).includes(value)

/** 兼容值：规则集没有 `authority` 块时使用（今日行为）。每次返回独立副本。 */
export function compatAuthority(): Authority {
  return {
    mode: 'auto',
    sources: [],
    assessorAgentId: null,
    assessBatch: COMPAT_BATCH,
    assessWindowMs: COMPAT_WINDOW_MS,
  }
}

/** 名单归一：去空白、去空项、去重、单条截到 `identityId`、总数截到 `identitiesPerSource`。 */
function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || name.length > AUTHORITY_LIMITS.identityId) continue
    seen.add(name)
    if (seen.size >= AUTHORITY_LIMITS.identitiesPerSource) break
  }
  return [...seen]
}

export function normalizeAdmissionTable(value: unknown): AdmissionTable {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const cell = (key: keyof AdmissionTable): AdmissionCell => {
    const candidate = source[key]
    return isAdmissionCell(candidate) ? candidate : DEFAULT_ADMISSION_TABLE[key]
  }
  return {
    listedAddressed: cell('listedAddressed'),
    listedUnaddressed: cell('listedUnaddressed'),
    unlistedAddressed: cell('unlistedAddressed'),
    unlistedUnaddressed: cell('unlistedUnaddressed'),
    botAddressed: cell('botAddressed'),
  }
}

/**
 * 单条来源策略归一：没有 `id` 就不是一条策略（返回 `null` 由调用方丢弃）。
 */
export function normalizeSourcePolicy(value: unknown): SourcePolicy | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string') return null
  const id = raw.id.trim().slice(0, AUTHORITY_LIMITS.sourceId)
  if (id === '') return null
  return {
    id,
    allowed: normalizeNames(raw.allowed),
    bots: normalizeNames(raw.bots),
    receiveAll: raw.receiveAll === true,
    admission: normalizeAdmissionTable(raw.admission),
  }
}

/**
 * 整块准入配置归一：非法值回落到兼容值，来源按 id 去重（先到先得）并截到上限。
 * 实时写入与投影重建共用这一个函数，避免两条路径对同一份历史得出不同结论。
 */
export function normalizeAuthority(value: unknown): Authority {
  if (typeof value !== 'object' || value === null) return compatAuthority()
  const raw = value as Record<string, unknown>
  const sources: SourcePolicy[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.sources)) {
    for (const candidate of raw.sources) {
      const policy = normalizeSourcePolicy(candidate)
      if (policy === null || seen.has(policy.id)) continue
      seen.add(policy.id)
      sources.push(policy)
      if (sources.length >= AUTHORITY_LIMITS.sources) break
    }
  }
  const assessorAgentId =
    typeof raw.assessorAgentId === 'string' && raw.assessorAgentId.trim() !== ''
      ? raw.assessorAgentId.trim()
      : null
  return {
    mode: isAcceptMode(raw.mode) ? raw.mode : 'auto',
    sources,
    assessorAgentId,
    assessBatch: batchOf(raw.assessBatch),
    assessWindowMs: windowOf(raw.assessWindowMs),
  }
}

function batchOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return COMPAT_BATCH
  if (value < AUTHORITY_LIMITS.assessBatchMin || value > AUTHORITY_LIMITS.assessBatchMax) {
    return COMPAT_BATCH
  }
  return value
}

function windowOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return COMPAT_WINDOW_MS
  if (value < 0 || value > AUTHORITY_LIMITS.assessWindowMsMax) return COMPAT_WINDOW_MS
  return value
}

// ---------- 授权（A2） ----------

/** 授权撤销的三种原因：人叫停 / 恢复前重校验失败 / 换版后依据不再成立。 */
export const MANDATE_REVOKED_REASONS = ['stop', 'revalidate', 'policy'] as const
export type MandateRevokedReason = (typeof MANDATE_REVOKED_REASONS)[number]

/**
 * 一次授权的范围：任务能做什么、花多少、到什么时候。
 *
 * `access` 是运行期权限的**上限**：`run.access = min(agent.permissionMode, scope.access)`，
 * 也就是说授权只会收紧、不会放宽（`permissionMode` 才是配置侧的原意）。
 */
export interface MandateScope {
  workflowId: string
  stageId: string | null
  projectId: string | null
  access: Access
  /** 最多再跑几轮；null = 不限 */
  maxRuns: number | null
  /** Token 上限；null = 不限 */
  maxTokens: number | null
  /** 到期时刻（ISO）；null = 不过期 */
  expiresAt: string | null
}

/** 谁授的：来源里的某个人 / 某个机器人，或本机手工创建。 */
export type MandateBy =
  { kind: 'identity'; source: string; identity: EventIdentity } | { kind: 'manual'; via: 'ui' }

/**
 * 一张授权（A2）：任务凭它执行。
 *
 * 生命周期只有三种改变：授予（accept）、人叫停、重校验失败（含换版后依据不再成立）。
 * 任务完成**不撤销**授权——历史要能回答「当时凭什么」，`legacy` 标出 A2 之前的存量任务。
 */
export interface Mandate {
  id: string
  taskId: string
  scope: MandateScope
  strength: Strength
  basis: AdmissionBasis
  /** 授予时的规则集版本（与 `rule_sets.version` 同一口径） */
  policyVersion: number
  ruleIds: string[]
  by: MandateBy
  grantedAt: string
  revokedAt: string | null
  revokedReason: MandateRevokedReason | null
  /** 存量任务（A2 之前创建）：不补发授权，只读展示 */
  legacy: boolean
}
