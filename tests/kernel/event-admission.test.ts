// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Agent, Runtime, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import type { AutomationRule } from '@workbench/protocol/rules'
import {
  DEFAULT_ADMISSION_TABLE,
  type Authority,
  type EventIdentity,
} from '@workbench/protocol/authority'
import type { Environment, Limits, View } from '@workbench/kernel/core/types'
import { decide } from '@workbench/kernel/decide'

const NOW = '2026-11-17T09:00:00.000Z'
const CREATED = '2026-11-16T00:00:00.000Z'

const LIMITS: Limits = {
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
}

const env = (): Environment => {
  const counters = new Map<string, number>()
  return {
    timezone: 'UTC',
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
  }
}

const workflow: Workflow = { id: 'wf-1', name: '研发', description: '', createdAt: CREATED }
const stage: WorkflowStage = {
  id: 'st-1',
  workflowId: 'wf-1',
  name: '实现',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  exits: {},
  judge: null,
  handoffs: [],
}
const agent: Agent = {
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
}
const runtime: Runtime = {
  id: 'rt-1',
  name: 'dsh',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
}

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: 'rule-1',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
  ...over,
})

const authority = (over: Partial<Authority> = {}): Authority => ({
  mode: 'auto',
  sources: [
    {
      id: 'github',
      allowed: ['octocat'],
      bots: [],
      receiveAll: false,
      admission: { ...DEFAULT_ADMISSION_TABLE },
    },
  ],
  assessorAgentId: null,
  assessBatch: 8,
  assessWindowMs: 5000,
  ...over,
})

const view = (over: { rules?: AutomationRule[]; authority?: Authority | null } = {}): View => ({
  seq: 10,
  workflows: new Map([[workflow.id, workflow]]),
  stages: new Map([[stage.id, stage]]),
  agents: new Map([[agent.id, agent]]),
  runtimes: new Map([[runtime.id, runtime]]),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  rules: over.rules ?? [rule()],
  rulesVersion: 4,
  ruleSetReplacedAt: CREATED,
  authority: over.authority === undefined ? null : over.authority,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const human = (id = 'octocat', addressed = true): EventIdentity => ({
  kind: 'human',
  id,
  addressed,
})

const received = (identity?: EventIdentity) => ({
  type: 'event.received' as const,
  event: {
    source: 'github',
    type: 'issues.opened',
    subject: '#42 登录页报错',
    ...(identity === undefined ? {} : { identity }),
  },
  hops: 1,
})

const types = (facts: Array<{ type: string }>): string[] => facts.map((fact) => fact.type)

describe('event.received — 兼容模式（规则集没有 authority）', () => {
  it('照旧建任务，且不产准入事实', () => {
    const decision = decide(view(), received(human()), NOW, env())
    expect(decision.reject).toBeUndefined()
    expect(types(decision.facts)).toContain('task.created')
    expect(types(decision.facts)).not.toContain('event.admitted')
    expect(types(decision.facts)).not.toContain('event.denied')
  })

  it('身份进事实（即使不判定准入）', () => {
    const decision = decide(view(), received(human()), NOW, env())
    const fact = decision.facts.find((entry) => entry.type === 'event.received')
    expect(fact?.payload).toMatchObject({ identity: human() })
  })

  it('没有身份时补 system，不冒充人', () => {
    const decision = decide(view(), received(), NOW, env())
    const fact = decision.facts.find((entry) => entry.type === 'event.received')
    expect(fact?.payload).toMatchObject({
      identity: { kind: 'system', id: 'unknown', addressed: true },
    })
  })
})

describe('event.received — 名单内点名', () => {
  it('产 admitted（含强度 / 依据 / 模式 / 版本）并建任务', () => {
    const decision = decide(view({ authority: authority() }), received(human()), NOW, env())
    expect(types(decision.facts)).toContain('event.admitted')
    expect(types(decision.facts)).toContain('task.created')
    const admitted = decision.facts.find((entry) => entry.type === 'event.admitted')
    expect(admitted?.payload).toEqual({
      eventId: 'event-1',
      ruleId: 'rule-1',
      strength: 'explicit',
      basis: 'addressed',
      mode: 'auto',
      policyVersion: 4,
    })
  })

  it('命中多条启用规则时每条一条 admitted', () => {
    const rules = [rule(), rule({ id: 'rule-2', name: '第二条' })]
    const decision = decide(
      view({ authority: authority(), rules }),
      received(human()),
      NOW,
      env(),
    )
    const admitted = decision.facts.filter((entry) => entry.type === 'event.admitted')
    expect(admitted.map((fact) => (fact.payload as { ruleId: string }).ruleId)).toEqual([
      'rule-1',
      'rule-2',
    ])
  })

  it('停用的规则不产 admitted', () => {
    const rules = [rule(), rule({ id: 'rule-2', name: '第二条', enabled: false })]
    const decision = decide(
      view({ authority: authority(), rules }),
      received(human()),
      NOW,
      env(),
    )
    const admitted = decision.facts.filter((entry) => entry.type === 'event.admitted')
    expect(admitted).toHaveLength(1)
  })
})

describe('event.received — 拒绝', () => {
  it('名单外点名：只入账 + denied，不建任务', () => {
    const decision = decide(view({ authority: authority() }), received(human('stranger')), NOW, env())
    expect(types(decision.facts)).toEqual(['event.received', 'event.denied'])
    expect(decision.facts[1]?.payload).toEqual({
      eventId: 'event-1',
      ruleId: null,
      reason: 'not-listed',
      policyVersion: 4,
    })
  })

  it('来源未配置：denied not-listed', () => {
    const decision = decide(
      view({ authority: authority({ sources: [] }) }),
      received(human()),
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['event.received', 'event.denied'])
  })

  it('off 模式 + 推断候选：denied mode-off', () => {
    const strict = authority({
      mode: 'off',
      sources: [
        {
          id: 'github',
          allowed: ['octocat'],
          bots: [],
          receiveAll: false,
          admission: { ...DEFAULT_ADMISSION_TABLE, unlistedAddressed: 'inferred' },
        },
      ],
    })
    const decision = decide(view({ authority: strict }), received(human('stranger')), NOW, env())
    expect(types(decision.facts)).toEqual(['event.received', 'event.denied'])
    expect(decision.facts[1]?.payload).toMatchObject({ reason: 'mode-off' })
  })

  it('被拒的事件连停用规则的 skipped 留痕都不产', () => {
    const rules = [rule({ id: 'rule-2', name: '停用', enabled: false })]
    const decision = decide(
      view({ authority: authority(), rules }),
      received(human('stranger')),
      NOW,
      env(),
    )
    expect(types(decision.facts)).not.toContain('event.skipped')
  })
})
