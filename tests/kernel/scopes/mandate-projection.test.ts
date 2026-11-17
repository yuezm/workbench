// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Mandate } from '@workbench/protocol/authority'
import type { Fact } from '@workbench/kernel/core/types'
import { project } from '@workbench/kernel/scopes/project'
import { timeline } from '@workbench/kernel/scopes/timeline'

const AT = '2026-11-17T10:00:00.000Z'

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  id: 'mandate-1',
  taskId: 'task-1',
  scope: {
    workflowId: 'wf-1',
    stageId: 'st-1',
    projectId: null,
    access: 'edit',
    maxRuns: null,
    maxTokens: null,
    expiresAt: null,
  },
  strength: 'explicit',
  basis: 'addressed',
  policyVersion: 5,
  ruleIds: ['rule-1'],
  by: {
    kind: 'identity',
    source: 'github',
    identity: { kind: 'human', id: 'octocat', addressed: true },
  },
  grantedAt: AT,
  revokedAt: null,
  revokedReason: null,
  legacy: false,
  ...over,
})

const fact = <T extends Fact['type']>(type: T, payload: unknown): Fact =>
  ({ seq: 1, type, actor: { kind: 'kernel' }, at: AT, payload }) as Fact

describe('A2 授权事实的投影', () => {
  it('mandate.granted：整行落到 mandates（一行事实 → 一行投影）', () => {
    const row = mandate()
    expect(project(fact('mandate.granted', { mandate: row }))).toEqual([
      { table: 'mandates', key: 'mandate-1', row },
    ])
  })

  it('mandate.revoked：覆盖同一行（撤销不是删除）', () => {
    const row = mandate({ revokedAt: AT, revokedReason: 'stop' })
    expect(project(fact('mandate.revoked', { mandate: row }))).toEqual([
      { table: 'mandates', key: 'mandate-1', row },
    ])
  })

  it('mandate.revalidated：只作审计，不改投影', () => {
    expect(
      project(
        fact('mandate.revalidated', {
          mandateId: 'mandate-1',
          taskId: 'task-1',
          ok: true,
          reason: null,
          policyVersion: 6,
        }),
      ),
    ).toEqual([])
  })
})

describe('A2 授权的 why 链', () => {
  it('授予 / 撤销挂到任务上', () => {
    expect(
      timeline([fact('mandate.granted', { mandate: mandate() })], 'task', 'task-1'),
    ).not.toEqual([])
    expect(project(fact('mandate.granted', { mandate: mandate() }))[0]?.table).toBe('mandates')
  })

  it('重校验也挂到任务（失败时与撤销同批出现，能对上）', () => {
    const facts = [
      fact('mandate.revalidated', {
        mandateId: 'mandate-1',
        taskId: 'task-1',
        ok: false,
        reason: '请求人已不在名单里',
        policyVersion: 6,
      }),
    ]
    expect(timeline(facts, 'task', 'task-1').map((entry) => entry.fact.type)).toEqual([
      'mandate.revalidated',
    ])
  })
})
