// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Agent, Task, WorkflowStage } from '@workbench/protocol/entities'
import type {
  Authority,
  Mandate,
  MandateBy,
  Strength,
  AdmissionBasis,
} from '@workbench/protocol/authority'
import { DEFAULT_ADMISSION_TABLE } from '@workbench/protocol/authority'
import {
  grantMandate,
  narrowAccess,
  revalidateMandate,
  revokeMandate,
} from '@workbench/kernel/scopes/mandate'

const AT = '2026-11-17T11:00:00.000Z'

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '修登录页',
  description: '',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  status: 'active',
  origin: 'rule',
  ruleId: 'rule-1',
  externalRef: null,
  labels: [],
  threadId: 'th-1',
  parentTaskId: null,
  spawnedByRunId: null,
  batchNo: null,
  spawnKey: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
  projectId: 'proj-1',
  gateFails: 0,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const stage = (judge: boolean): Pick<WorkflowStage, 'judge'> => ({
  judge: judge ? { maxFails: 3 } : null,
})

const agent = (mode: Agent['permissionMode']): Pick<Agent, 'permissionMode'> => ({
  permissionMode: mode,
})

const humanBy = (id = 'octocat', source = 'github'): MandateBy => ({
  kind: 'identity',
  source,
  identity: { kind: 'human', id, addressed: true },
})

const mandateOf = (basis: AdmissionBasis, strength: Strength, by: MandateBy = humanBy()): Mandate =>
  grantMandate({
    id: 'mandate-1',
    task: task(),
    ruleIds: ['rule-1'],
    strength,
    basis,
    by,
    policyVersion: 3,
    grantedAt: AT,
    stage: stage(false),
    agent: agent('workspace-write'),
  })

const authority = (over: Partial<Authority> = {}): Authority => ({
  mode: 'auto',
  sources: [
    {
      id: 'github',
      allowed: ['octocat'],
      bots: ['dependabot[bot]'],
      receiveAll: false,
      admission: { ...DEFAULT_ADMISSION_TABLE },
    },
  ],
  assessorAgentId: null,
  assessBatch: 8,
  assessWindowMs: 5000,
  ...over,
})

describe('grantMandate', () => {
  it('范围取任务落点与智能体权限上限，未用的额度留 null', () => {
    const mandate = mandateOf('addressed', 'explicit')
    expect(mandate.scope).toEqual({
      workflowId: 'wf-1',
      stageId: 'st-1',
      projectId: 'proj-1',
      access: 'edit',
      maxRuns: null,
      maxTokens: null,
      expiresAt: null,
    })
    expect(mandate).toMatchObject({
      taskId: 'task-1',
      strength: 'explicit',
      basis: 'addressed',
      policyVersion: 3,
      ruleIds: ['rule-1'],
      revokedAt: null,
      legacy: false,
    })
  })

  it('闸门阶段恒 full（与 M27 的阶段语义一致）', () => {
    const mandate = grantMandate({
      id: 'm-2',
      task: task(),
      ruleIds: [],
      strength: 'explicit',
      basis: 'manual',
      by: { kind: 'manual', via: 'ui' },
      policyVersion: 1,
      grantedAt: AT,
      stage: stage(true),
      agent: agent('read-only'),
    })
    expect(mandate.scope.access).toBe('full')
  })

  it('没有智能体时按最窄权限兜底', () => {
    const mandate = grantMandate({
      id: 'm-3',
      task: task(),
      ruleIds: [],
      strength: 'explicit',
      basis: 'manual',
      by: { kind: 'manual', via: 'ui' },
      policyVersion: 1,
      grantedAt: AT,
      stage: null,
      agent: null,
    })
    expect(mandate.scope.access).toBe('read')
  })

  it('没有阶段时按智能体原意折算', () => {
    const mandate = grantMandate({
      id: 'm-4',
      task: task(),
      ruleIds: [],
      strength: 'explicit',
      basis: 'manual',
      by: { kind: 'manual', via: 'ui' },
      policyVersion: 1,
      grantedAt: AT,
      stage: null,
      agent: agent('danger-full-access'),
    })
    expect(mandate.scope.access).toBe('full')
  })
})

describe('narrowAccess', () => {
  it.each([
    ['read', 'full', 'read'],
    ['full', 'read', 'read'],
    ['edit', 'edit', 'edit'],
    ['full', 'edit', 'edit'],
    ['edit', 'full', 'edit'],
  ] as const)('%s ∩ %s = %s', (intended, cap, expected) => {
    expect(narrowAccess(intended, cap)).toBe(expected)
  })
})

describe('revokeMandate', () => {
  it('填上撤销时刻与原因', () => {
    const revoked = revokeMandate(mandateOf('addressed', 'explicit'), 'stop', AT)
    expect(revoked).toMatchObject({ revokedAt: AT, revokedReason: 'stop' })
  })

  it('已撤销的幂等（重放不产生第二条撤销事实）', () => {
    const once = revokeMandate(mandateOf('addressed', 'explicit'), 'stop', AT)
    expect(revokeMandate(once, 'policy', '2026-12-01T00:00:00.000Z')).toEqual(once)
  })
})

describe('revalidateMandate', () => {
  it('兼容模式恒过（没有准入配置就没有失效依据）', () => {
    expect(revalidateMandate(mandateOf('addressed', 'explicit'), null)).toEqual({
      ok: true,
      reason: null,
    })
  })

  it('来源被删：说明是哪个来源不在了', () => {
    const result = revalidateMandate(mandateOf('addressed', 'explicit'), authority({ sources: [] }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('github')
  })

  it('addressed：人还在名单就过，移出名单就失败', () => {
    expect(revalidateMandate(mandateOf('addressed', 'explicit'), authority()).ok).toBe(true)
    const moved = authority()
    moved.sources[0]!.allowed = []
    const result = revalidateMandate(mandateOf('addressed', 'explicit'), moved)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('octocat')
  })

  it('followup：名单外但在「名单外点名」给 explicit 时仍成立', () => {
    const open = authority()
    open.sources[0]!.allowed = []
    open.sources[0]!.admission.unlistedAddressed = 'explicit'
    expect(revalidateMandate(mandateOf('followup', 'explicit'), open).ok).toBe(true)

    const closed = authority()
    closed.sources[0]!.allowed = []
    const result = revalidateMandate(mandateOf('followup', 'explicit'), closed)
    expect(result.ok).toBe(false)
  })

  it('bot：机器人移出名单或模式不再是 auto 都失败', () => {
    const by = {
      kind: 'identity' as const,
      source: 'github',
      identity: { kind: 'bot' as const, id: 'dependabot[bot]', addressed: true },
    }
    expect(revalidateMandate(mandateOf('bot', 'inferred', by), authority()).ok).toBe(true)

    const noBot = authority()
    noBot.sources[0]!.bots = []
    expect(revalidateMandate(mandateOf('bot', 'inferred', by), noBot).ok).toBe(false)

    const observe = authority({ mode: 'observe' })
    const result = revalidateMandate(mandateOf('bot', 'inferred', by), observe)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('自动接单')
  })

  it('table：今天准入表只给更弱强度时失败', () => {
    const weaker = authority()
    weaker.sources[0]!.admission.listedAddressed = 'inferred'
    const result = revalidateMandate(mandateOf('table', 'explicit'), weaker)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('更弱')
  })

  it('table：今天直接拒绝时把拒绝原因给人看', () => {
    const off = authority({ mode: 'off' })
    off.sources[0]!.admission.listedAddressed = 'inferred'
    const result = revalidateMandate(mandateOf('table', 'inferred'), off)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('推断')
  })

  it('manual 恒过，即使是存量任务', () => {
    const manual = grantMandate({
      id: 'm-5',
      task: task(),
      ruleIds: [],
      strength: 'explicit',
      basis: 'manual',
      by: { kind: 'manual', via: 'ui' },
      policyVersion: 1,
      grantedAt: AT,
      stage: null,
      agent: agent('workspace-write'),
    })
    expect(revalidateMandate(manual, authority({ sources: [] })).ok).toBe(true)
  })

  it('legacy 任务不参与重校验（不补发、不误撤）', () => {
    const legacy: Mandate = { ...mandateOf('addressed', 'explicit'), legacy: true }
    expect(revalidateMandate(legacy, authority({ sources: [] })).ok).toBe(true)
  })
})
