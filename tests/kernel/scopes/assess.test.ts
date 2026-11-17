// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AutomationRule } from '@workbench/protocol/rules'
import type { AssessVerdict } from '@workbench/protocol/authority'
import { assessmentOutcome } from '@workbench/kernel/scopes/assess'

const rule = (id: string, enabled = true): AutomationRule => ({
  id,
  name: id,
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled,
})

const verdict = (
  ruleId: string,
  match: boolean,
  evidence: string | null = null,
): AssessVerdict => ({
  ruleId,
  match,
  evidence,
})

const base = {
  id: 'assess-1',
  eventId: 'event-1',
  policyVersion: 5,
}

describe('assessmentOutcome — 覆盖与证据', () => {
  it('每条启用规则恰好一次 + 命中带证据 → 折算为 accept（auto）', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1'), rule('rule-2')],
      verdicts: [verdict('rule-1', true, '正文写明登录页 500'), verdict('rule-2', false)],
      mode: 'auto',
    })
    expect(outcome).toEqual({
      ok: true,
      assessment: {
        ...base,
        ruleIds: ['rule-1', 'rule-2'],
        verdicts: [verdict('rule-1', true, '正文写明登录页 500'), verdict('rule-2', false)],
        decision: 'accept',
        wouldAccept: false,
        via: 'assessor',
      },
    })
  })

  it('漏判一条启用规则 → failed（宁可漏接，不可瞎接）', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1'), rule('rule-2')],
      verdicts: [verdict('rule-1', true, '有证据')],
      mode: 'auto',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'coverage' })
  })

  it('判了未启用的规则 → failed（覆盖必须精确对应当前规则集）', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', true, '有证据'), verdict('rule-9', false)],
      mode: 'auto',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'coverage' })
  })

  it('同一规则判两次 → failed', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', true, '有证据'), verdict('rule-1', false)],
      mode: 'auto',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'coverage' })
  })

  it('命中但没证据 → failed', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', true, null)],
      mode: 'auto',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'evidence' })
  })

  it('证据全是空白 → failed', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', true, '   ')],
      mode: 'auto',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'evidence' })
  })

  it('证据超长（>300 字）→ failed', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', true, '证'.repeat(301))],
      mode: 'auto',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'evidence' })
  })

  it('停用的规则不参与覆盖（只看启用的）', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1'), rule('rule-2', false)],
      verdicts: [verdict('rule-1', true, '有证据')],
      mode: 'auto',
    })
    expect(outcome.ok).toBe(true)
  })

  it('没有启用规则：视为 failed（不该走到研判）', () => {
    const outcome = assessmentOutcome({ ...base, rules: [], verdicts: [], mode: 'auto' })
    expect(outcome).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('形状不对（不是数组）也归 failed', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: null as unknown as AssessVerdict[],
      mode: 'auto',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'shape' })
  })
})

describe('assessmentOutcome — 模式语义', () => {
  it('observe：命中也不接单，只记「本来会接」', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', true, '有证据')],
      mode: 'observe',
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.assessment.decision).toBe('ignore')
      expect(outcome.assessment.wouldAccept).toBe(true)
    }
  })

  it('off：同样不接单，但结论照记（复盘用）', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', true, '有证据')],
      mode: 'off',
    })
    expect(outcome.ok && outcome.assessment.decision).toBe('ignore')
  })

  it('一条都没命中：ignore，且不记 wouldAccept', () => {
    const outcome = assessmentOutcome({
      ...base,
      rules: [rule('rule-1')],
      verdicts: [verdict('rule-1', false)],
      mode: 'auto',
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.assessment.decision).toBe('ignore')
      expect(outcome.assessment.wouldAccept).toBe(false)
    }
  })
})
