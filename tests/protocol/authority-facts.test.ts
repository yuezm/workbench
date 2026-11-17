// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  FACT_TYPES,
  type EventAdmittedPayload,
  type EventDeniedPayload,
  type EventReceivedPayload,
  type FactPayloads,
} from '@workbench/protocol/facts'
import { validateInput } from '@workbench/protocol/validate'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false
const expectType = <T extends true>(): T => true as T

describe('准入相关事实类型', () => {
  it('FACT_TYPES 收录 event.admitted / event.denied', () => {
    expect(FACT_TYPES).toContain('event.admitted')
    expect(FACT_TYPES).toContain('event.denied')
  })

  it('payload 形状与 SPEC-authority §事实 一致', () => {
    const admitted: EventAdmittedPayload = {
      eventId: 'evt-1',
      ruleId: 'rule-1',
      strength: 'explicit',
      basis: 'addressed',
      mode: 'auto',
      policyVersion: 3,
    }
    const denied: EventDeniedPayload = {
      eventId: 'evt-1',
      ruleId: null,
      reason: 'not-listed',
      policyVersion: 3,
    }
    expect(admitted.strength).toBe('explicit')
    expect(denied.reason).toBe('not-listed')
    expectType<Equal<FactPayloads['event.admitted'], EventAdmittedPayload>>()
    expectType<Equal<FactPayloads['event.denied'], EventDeniedPayload>>()
  })

  it('event.received 的 identity 可选，老事实仍可重建', () => {
    const legacy: EventReceivedPayload = {
      eventId: 'evt-1',
      source: 'github',
      type: 'issues.opened',
      subject: '#1 登录报错',
      summary: '',
      detailRef: null,
      link: null,
      hops: 1,
      originRunId: null,
      dedupeKey: null,
    }
    expect(legacy.identity).toBeUndefined()
  })
})

describe('event.received 的 identity 校验', () => {
  const base = {
    type: 'event.received' as const,
    event: { source: 'github', type: 'issues.opened', subject: '#1 登录报错' },
    hops: 1,
  }

  it('合法身份原样通过', () => {
    const result = validateInput({
      ...base,
      event: {
        ...base.event,
        identity: { kind: 'human', id: 'octocat', addressed: true },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const input = result.input
      expect(input.type).toBe('event.received')
      if (input.type === 'event.received') {
        expect(input.event.identity).toEqual({ kind: 'human', id: 'octocat', addressed: true })
      }
    }
  })

  it('不带 identity 仍然通过（兼容老宿主）', () => {
    expect(validateInput(base).ok).toBe(true)
  })

  it('未知 kind 被拒', () => {
    const result = validateInput({
      ...base,
      event: { ...base.event, identity: { kind: 'agent', id: 'x', addressed: true } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('identity.kind')
  })

  it('空 id 被拒', () => {
    const result = validateInput({
      ...base,
      event: { ...base.event, identity: { kind: 'human', id: '   ', addressed: true } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('identity.id')
  })

  it('id 超过 128 字符被拒', () => {
    const result = validateInput({
      ...base,
      event: {
        ...base.event,
        identity: { kind: 'human', id: 'x'.repeat(129), addressed: true },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('identity.id')
  })

  it('addressed 不是布尔值被拒', () => {
    const result = validateInput({
      ...base,
      event: { ...base.event, identity: { kind: 'human', id: 'x', addressed: 'yes' } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('identity.addressed')
  })

  it('identity 不是对象被拒', () => {
    const result = validateInput({
      ...base,
      event: { ...base.event, identity: 'octocat' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('identity')
  })

  it('回执里派生的 RawEvent 也按同一口径校验身份', () => {
    const result = validateInput({
      type: 'run.receipt',
      runId: 'run-1',
      receipt: {
        status: 'succeeded',
        leaseId: 'run-1:1',
        turn: 1,
        events: [
          {
            source: 'agent',
            type: 'task.requested',
            subject: '再来一轮',
            identity: { kind: 'system', id: 'unknown', addressed: true },
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
  })
})
