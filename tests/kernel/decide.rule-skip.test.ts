// @vitest-environment node
/**
 * 规则暂停与补跑（M35-D）。
 *
 * 现状问题：停用规则命中的事件被**静默丢弃**——不建任务、也不留痕，恢复后无法补跑。
 * 这里定三件事：
 * 1. 命中停用规则 → 记 `event.skipped`（不建任务）；
 * 2. `rule.replay` 按 `(ruleId, eventId)` 把跳过的事件补跑一次，第二次零事实；
 * 3. 停用中的规则拒绝补跑（先恢复再补，避免「补了但还是停用」）。
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Runtime, Workflow, WorkflowStage } from '../../src/protocol/entities'
import type { AutomationRule } from '../../src/protocol/rules'
import { decide } from '../../src/kernel/decide'
import type { Environment, EventRow, Id, Limits, RuleSkip, View } from '../../src/kernel/core/types'

const NOW = '2026-11-14T10:00:00.000Z'
const CREATED = '2026-11-13T00:00:00.000Z'

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
    nextId: (kind): Id => {
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

const eventRow = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'event-1',
  source: 'github',
  type: 'issues.opened',
  subject: '#42 登录页报错',
  summary: '外部摘要',
  detailRef: null,
  link: null,
  hops: 1,
  originRunId: null,
  dedupeKey: null,
  receivedAt: CREATED,
  ...over,
})

const skip = (over: Partial<RuleSkip> = {}): RuleSkip => ({
  ruleId: 'rule-1',
  eventId: 'event-1',
  version: 1,
  skippedAt: CREATED,
  ...over,
})

interface Seed {
  rules?: AutomationRule[]
  events?: EventRow[]
  skips?: RuleSkip[]
}

const view = (seed: Seed = {}): View => ({
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
  events: new Map((seed.events ?? []).map((row) => [row.id, row])),
  ruleSkips: seed.skips ?? [],
  rules: seed.rules ?? [],
  rulesVersion: 1,
  ruleSetReplacedAt: CREATED,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const externalEvent = (type = 'issues.opened') => ({
  type: 'event.received' as const,
  event: { source: 'github', type, subject: '#42 登录页报错', summary: '外部摘要' },
})

const types = (facts: ReadonlyArray<{ type: string }>): string[] => facts.map((fact) => fact.type)

describe('M35-D 停用规则命中：留痕不建任务', () => {
  it('命中停用规则只记 event.skipped（带 eventId 与 ruleId），不建任务', () => {
    const decision = decide(
      view({ rules: [rule({ enabled: false })] }),
      externalEvent(),
      NOW,
      env(),
    )

    expect(types(decision.facts)).toEqual(['event.received', 'event.skipped'])
    const received = decision.facts.find((fact) => fact.type === 'event.received')
    const skipped = decision.facts.find((fact) => fact.type === 'event.skipped')
    expect(skipped?.payload).toMatchObject({
      ruleId: 'rule-1',
      reason: 'rule-disabled',
      version: 1,
    })
    expect((skipped?.payload as { eventId: string }).eventId).toBe(
      (received?.payload as { eventId: string }).eventId,
    )
    expect(types(decision.facts)).not.toContain('task.created')
  })

  it('命中启用规则照常建任务，不产生 skipped', () => {
    const decision = decide(view({ rules: [rule()] }), externalEvent(), NOW, env())

    expect(types(decision.facts)).toContain('task.created')
    expect(types(decision.facts)).not.toContain('event.skipped')
  })

  it('同一事件命中多条规则：只给停用的那几条留痕', () => {
    const rules = [rule({ id: 'rule-on', enabled: true }), rule({ id: 'rule-off', enabled: false })]
    const decision = decide(view({ rules }), externalEvent(), NOW, env())

    const skipped = decision.facts.filter((fact) => fact.type === 'event.skipped')
    expect(skipped.map((fact) => (fact.payload as { ruleId: string }).ruleId)).toEqual(['rule-off'])
  })
})

describe('M35-D 补跑', () => {
  it('补跑跳过的事件：建任务、记 rule.replayed；第二次零事实', () => {
    const world = view({
      rules: [rule()],
      events: [eventRow()],
      skips: [skip()],
    })

    const first = decide(
      world,
      { type: 'rule.replay', commandId: 'rp-1', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(types(first.facts)).toContain('task.created')
    expect(types(first.facts)).toContain('rule.replayed')

    // 补跑过的那条不再是 skipped：再补一次就是零事实
    const replayed = view({
      rules: [rule()],
      events: [eventRow()],
      skips: [skip({ skippedAt: CREATED, version: 1 })],
    })
    // 视图里留下「已补跑」的行由 projection 改状态；这里用空 skips 模拟已消费
    replayed.ruleSkips = []
    const second = decide(
      replayed,
      { type: 'rule.replay', commandId: 'rp-2', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(second.facts).toEqual([])
  })

  it('停用中的规则拒绝补跑（先恢复再补）', () => {
    const decision = decide(
      view({ rules: [rule({ enabled: false })], events: [eventRow()], skips: [skip()] }),
      { type: 'rule.replay', commandId: 'rp-3', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(decision.reject).toMatchObject({ code: 'conflict' })
    expect(decision.facts).toEqual([])
  })

  it('规则不存在 / 没有可补的事件：拒绝或零事实', () => {
    expect(
      decide(view(), { type: 'rule.replay', commandId: 'rp-4', ruleId: 'ghost' }, NOW, env())
        .reject,
    ).toMatchObject({ code: 'not_found' })

    const empty = decide(
      view({ rules: [rule()] }),
      { type: 'rule.replay', commandId: 'rp-5', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(empty.reject).toBeUndefined()
    expect(empty.facts).toEqual([])
  })

  it('since / until 限定补跑范围（区间外的跳过事件不动）', () => {
    const world = view({
      rules: [rule()],
      events: [
        eventRow({ id: 'event-1', receivedAt: '2026-11-01T00:00:00.000Z' }),
        eventRow({ id: 'event-2' }),
      ],
      skips: [skip({ eventId: 'event-1' }), skip({ eventId: 'event-2' })],
    })
    const decision = decide(
      world,
      {
        type: 'rule.replay',
        commandId: 'rp-6',
        ruleId: 'rule-1',
        since: '2026-11-10T00:00:00.000Z',
      },
      NOW,
      env(),
    )
    const replayed = decision.facts.filter((fact) => fact.type === 'rule.replayed')
    expect(replayed.map((fact) => (fact.payload as { eventId: string }).eventId)).toEqual([
      'event-2',
    ])
  })
})

describe('M35-D 补跑边界', () => {
  it('目标工作流失效：仍记 rule.replayed（taskId=null），不反复重试', () => {
    const world = view({
      rules: [rule({ to: { workflowId: 'wf-missing' } })],
      events: [eventRow()],
      skips: [skip()],
    })
    const decision = decide(
      world,
      { type: 'rule.replay', commandId: 'rp-7', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['rule.replayed'])
    expect((decision.facts[0].payload as { taskId: string | null }).taskId).toBeNull()
  })

  it('定时规则拒绝补跑（没有可补的事件）', () => {
    const world = view({ rules: [rule({ when: { cron: '0 9 * * *' } })] })
    const decision = decide(
      world,
      { type: 'rule.replay', commandId: 'rp-8', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(decision.reject).toMatchObject({ code: 'conflict' })
  })

  it('跳过的事件已不在事件投影里：跳过它，不抛错', () => {
    const world = view({ rules: [rule()], events: [], skips: [skip()] })
    const decision = decide(
      world,
      { type: 'rule.replay', commandId: 'rp-9', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
  })

  it('until 也给定时，区间外的事件同样不动', () => {
    const world = view({
      rules: [rule()],
      events: [eventRow({ id: 'event-1', receivedAt: '2026-11-14T09:00:00.000Z' })],
      skips: [skip({ eventId: 'event-1' })],
    })
    const decision = decide(
      world,
      {
        type: 'rule.replay',
        commandId: 'rp-10',
        ruleId: 'rule-1',
        until: '2026-11-01T00:00:00.000Z',
      },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
  })
})
