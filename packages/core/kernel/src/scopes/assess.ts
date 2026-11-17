/**
 * 研判（A3）：把一次 `purpose='assess'` 运行的判定折算成结论。
 *
 * 纯函数：不读时钟、不读文件、不调模型。三条硬约束来自 SPEC-authority §研判契约：
 *
 * 1. **覆盖精确**：当前启用的每条规则恰好判一次——漏判、多判、重判都算失败；
 * 2. **命中必须有证据**：`match=true` 时 `evidence` 非空且 ≤300 字（指向具体文字/链接）；
 * 3. **模式决定接不接单**：只有 `auto` 才可能 `accept`；`observe` / `off` 一律 `ignore`，
 *    命中与否另记 `wouldAccept`，用于「本来会接」复盘。
 *
 * 失败不是异常：返回 `{ok:false, reason}`，调用方记 `via='failed'` 并按 A3 口径重试一次，
 * 二次失败落 `event.denied{assess-failed}`——宁可漏接，不可瞎接。
 */
import type { AutomationRule } from '@workbench/protocol/rules'
import type { AcceptMode, Assessment, AssessVerdict } from '@workbench/protocol/authority'

/** 证据长度上限（与 SPEC-authority 一致：一句话，不写小作文） */
export const EVIDENCE_MAX = 300

export type OutcomeFailure = 'coverage' | 'evidence' | 'empty' | 'shape'

export type OutcomeResult =
  { ok: true; assessment: Assessment } | { ok: false; reason: OutcomeFailure }

export interface OutcomeInput {
  id: string
  eventId: string
  policyVersion: number
  /** 当前规则全集（停用的由这里过滤，调用方不必预处理） */
  rules: readonly AutomationRule[]
  verdicts: readonly AssessVerdict[]
  mode: AcceptMode
}

const fail = (reason: OutcomeFailure): OutcomeResult => ({ ok: false, reason })

export function assessmentOutcome(input: OutcomeInput): OutcomeResult {
  if (!Array.isArray(input.verdicts)) return fail('shape')
  const enabled = input.rules.filter((rule) => rule.enabled)
  if (enabled.length === 0) return fail('empty')

  const expected = new Set(enabled.map((rule) => rule.id))
  const seen = new Set<string>()
  for (const verdict of input.verdicts) {
    if (typeof verdict?.ruleId !== 'string' || !expected.has(verdict.ruleId)) {
      return fail('coverage')
    }
    if (seen.has(verdict.ruleId)) return fail('coverage')
    seen.add(verdict.ruleId)
    if (verdict.match) {
      const evidence = typeof verdict.evidence === 'string' ? verdict.evidence.trim() : ''
      if (evidence === '' || Array.from(evidence).length > EVIDENCE_MAX) return fail('evidence')
    }
  }
  if (seen.size !== expected.size) return fail('coverage')

  const matched = input.verdicts.some((verdict) => verdict.match)
  return {
    ok: true,
    assessment: {
      id: input.id,
      eventId: input.eventId,
      policyVersion: input.policyVersion,
      ruleIds: [...expected],
      verdicts: input.verdicts.map((verdict) => ({ ...verdict })),
      decision: matched && input.mode === 'auto' ? 'accept' : 'ignore',
      wouldAccept: matched && input.mode !== 'auto',
      via: 'assessor',
    },
  }
}
