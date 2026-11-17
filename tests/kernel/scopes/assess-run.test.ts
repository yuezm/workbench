// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Agent, Runtime } from '@workbench/protocol/entities'
import type { Authority } from '@workbench/protocol/authority'
import type { AutomationRule } from '@workbench/protocol/rules'
import type { Environment, Limits, View } from '@workbench/kernel/core/types'
import { assessRunFacts, assessPrompt } from '@workbench/kernel/scopes/assess'
import type { EventRow } from '@workbench/kernel/core/types'

const NOW = '2026-11-17T14:00:00.000Z'
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

const agent: Agent = {
  id: 'judge-agent',
  name: '研判者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'read-only',
  workdir: '/tmp/judge',
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
  prompt: '只接登录 / 支付相关的问题',
  enabled: true,
  ...over,
})

const event = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'event-1',
  source: 'github',
  type: 'issues.opened',
  subject: '#42 登录页 500',
  summary: '登录页报 500',
  detailRef: 'artifacts/event-1.md',
  link: 'https://example.invalid/42',
  hops: 0,
  originRunId: null,
  dedupeKey: null,
  receivedAt: CREATED,
  ...over,
})

const authority = (over: Partial<Authority> = {}): Authority => ({
  mode: 'observe',
  sources: [],
  assessorAgentId: 'judge-agent',
  assessBatch: 8,
  assessWindowMs: 5000,
  ...over,
})

const view = (seed: { rules?: AutomationRule[]; authority?: Authority | null } = {}): View => ({
  seq: 10,
  workflows: new Map(),
  stages: new Map(),
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
  rules: seed.rules ?? [rule()],
  rulesVersion: 6,
  ruleSetReplacedAt: CREATED,
  authority: seed.authority === undefined ? authority() : seed.authority,
  ruleFiredAt: new Map(),
  mandates: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

describe('assessPrompt', () => {
  it('只放已校验字段与规则清单，事件正文以资料路径出现', () => {
    const prompt = assessPrompt({
      rules: [rule()],
      events: [event()],
      artifactsRoot: '/data',
    })
    expect(prompt).toContain('# 研判（本轮只做判定，不做工作）')
    expect(prompt).toContain('rule-1')
    expect(prompt).toContain('只接登录 / 支付相关的问题')
    expect(prompt).toContain('issues.opened')
    expect(prompt).toContain('#42 登录页 500')
    expect(prompt).toContain('/data/artifacts/event-1.md')
    expect(prompt).toContain('assessments')
  })

  it('资料路径缺失时说明「没有全文」，不编造正文', () => {
    const prompt = assessPrompt({
      rules: [rule()],
      events: [event({ detailRef: null })],
      artifactsRoot: '/data',
    })
    expect(prompt).toContain('（没有正文资料）')
  })
})

describe('assessRunFacts', () => {
  it('产一条 purpose=assess 的 run.queued：taskId 为 null、hops=0、带批内事件', () => {
    const facts = assessRunFacts({
      view: view(),
      events: [event(), event({ id: 'event-2', subject: '#43 支付回调失败' })],
      now: NOW,
      env: env(),
    })
    expect(facts).toHaveLength(1)
    const run = (facts[0]?.payload as { run: ReturnType<typeof Object> }).run as {
      purpose: string
      taskId: string | null
      hops: number
      eventIds: string[]
      agentId: string
      rulesVersion: number
      access: string
    }
    expect(run).toMatchObject({
      purpose: 'assess',
      taskId: null,
      hops: 0,
      eventIds: ['event-1', 'event-2'],
      agentId: 'judge-agent',
      rulesVersion: 6,
      access: 'read',
    })
  })

  it('提示词里带上规则说明与资料路径', () => {
    const facts = assessRunFacts({ view: view(), events: [event()], now: NOW, env: env() })
    const prompt = (facts[0]?.payload as { run: { prompt: string } }).run.prompt
    expect(prompt).toContain('rule-1')
    expect(prompt).toContain('#42 登录页 500')
  })

  it('没有研判智能体 / 智能体或运行时缺失：零事实（调用方按模式兜底）', () => {
    expect(
      assessRunFacts({
        view: view({ authority: authority({ assessorAgentId: null }) }),
        events: [event()],
        now: NOW,
        env: env(),
      }),
    ).toEqual([])
    const noAgent = view()
    noAgent.agents.clear()
    expect(assessRunFacts({ view: noAgent, events: [event()], now: NOW, env: env() })).toEqual([])
  })

  it('兼容模式（没有准入配置）不研判', () => {
    expect(
      assessRunFacts({
        view: view({ authority: null }),
        events: [event()],
        now: NOW,
        env: env(),
      }),
    ).toEqual([])
  })

  it('批内事件按 assessBatch 截断、按到达时间排序', () => {
    const facts = assessRunFacts({
      view: view({ authority: authority({ assessBatch: 2 }) }),
      events: [
        event({ id: 'event-3', receivedAt: '2026-11-16T03:00:00.000Z' }),
        event({ id: 'event-1', receivedAt: '2026-11-16T01:00:00.000Z' }),
        event({ id: 'event-2', receivedAt: '2026-11-16T02:00:00.000Z' }),
      ],
      now: NOW,
      env: env(),
    })
    expect((facts[0]?.payload as { run: { eventIds: string[] } }).run.eventIds).toEqual([
      'event-1',
      'event-2',
    ])
  })

  it('没有候选事件：零事实', () => {
    expect(assessRunFacts({ view: view(), events: [], now: NOW, env: env() })).toEqual([])
  })
})
