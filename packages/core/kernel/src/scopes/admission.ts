/**
 * 准入（A1）：一条事件该不该进入规则匹配，以什么强度进入。
 *
 * 纯函数：不读时钟、不读文件、不认识具体产品；时间与版本号由调用方传入或从事实取。
 * 判定分两层——先按来源找策略，再按身份（人 / 机器人 / 系统）× 是否点名 × 名单
 * 选准入表的一格，最后由接受模式决定推断候选能不能接。
 *
 * 三个口径按 SPEC-authority §准入表 与 §模式矩阵：
 *
 * - **兼容模式**（规则集没有 `authority` 块，`authority === null`）：不做判定，全部
 *   `explicit` / `basis='manual'`，行为等价 M45「事件命中即建任务」。
 * - **未点名**：只有 `receiveAll=true` 的来源才看「未点名」那两格；否则一律拒绝
 *   （`not-listed`），与 SPEC-kernel「事件必须点名」的口径一致。
 * - **拒绝原因只有五个码**：被准入表设成 `ignore` 的格记 `not-listed`（身份不在允许
 *   范围），`inferred` 格在 `off` 模式下记 `mode-off`，机器人不在名单记
 *   `bot-not-listed`。`no-rule` 与 `assess-failed` 由调用方（规则匹配 / 研判）自己填。
 */
import type {
  AcceptMode,
  AdmissionBasis,
  AdmissionCell,
  AdmissionReason,
  Authority,
  EventIdentity,
  SourcePolicy,
  Strength,
} from '@workbench/protocol/authority'

export interface AdmissionRequest {
  /** 与 `event.source` 相等 */
  source: string
  /** 缺失按 system 处理（老宿主 / 手工 / 派生事件） */
  identity?: EventIdentity
}

export type Admission =
  | { allow: true; strength: Strength; basis: AdmissionBasis }
  | { allow: false; reason: AdmissionReason }

const allow = (strength: Strength, basis: AdmissionBasis): Admission => ({
  allow: true,
  strength,
  basis,
})

const deny = (reason: AdmissionReason): Admission => ({ allow: false, reason })

/** 单元格 + 模式 → 结论。`ignore` 记 `not-listed`（身份不在允许范围内）。 */
function cellOutcome(cell: AdmissionCell, mode: AcceptMode, basis: AdmissionBasis): Admission {
  if (cell === 'ignore') return deny('not-listed')
  if (cell === 'explicit') return allow('explicit', basis)
  return mode === 'off' ? deny('mode-off') : allow('inferred', basis)
}

/** 该来源的策略；没有就是没配置，按 `not-listed` 拒。 */
function policyOf(authority: Authority, source: string): SourcePolicy | null {
  for (const policy of authority.sources) {
    if (policy.id === source) return policy
  }
  return null
}

export function admit(request: AdmissionRequest, authority: Authority | null): Admission {
  if (authority === null) return allow('explicit', 'manual')

  const identity = request.identity
  if (identity === undefined || identity.kind === 'system') return allow('explicit', 'manual')

  const policy = policyOf(authority, request.source)
  if (policy === null) return deny('not-listed')

  if (identity.kind === 'bot') {
    if (!policy.bots.includes(identity.id)) return deny('bot-not-listed')
    return cellOutcome(policy.admission.botAddressed, authority.mode, 'bot')
  }

  const listed = policy.allowed.includes(identity.id)
  const addressed = identity.addressed
  if (!addressed && !policy.receiveAll) return deny('not-listed')

  if (!addressed) {
    return cellOutcome(
      listed ? policy.admission.listedUnaddressed : policy.admission.unlistedUnaddressed,
      authority.mode,
      'table',
    )
  }
  if (listed) return cellOutcome(policy.admission.listedAddressed, authority.mode, 'addressed')
  return cellOutcome(policy.admission.unlistedAddressed, authority.mode, 'table')
}
