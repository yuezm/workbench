import { describe, expect, it } from 'vitest'
import type { Agent, Runtime, Task, Workflow, WorkflowStage } from '../../src/protocol/entities'
import type { AutomationRule } from '../../src/protocol/rules'
import type { Environment, Limits, View } from '../../src/kernel/types'
import { decide } from '../../src/kernel/decide'

const NOW = '2026-11-05T09:00:00.000Z'
const CREATED = '2026-11-04T00:00:00.000Z'
const ACTOR = { kind: 'owner', via: 'ui' } as const

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
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffWorkflowId: null,
  handoffStageId: null,
}
const agent: Agent = {
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  createdAt: CREATED,
}
const runtime: Runtime = {
  id: 'rt-1',
  name: 'dsh',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
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

interface Seed {
  rules?: AutomationRule[]
  rulesVersion?: number
  replacedAt?: string | null
  firedAt?: Array<[string, string]>
  tasks?: Task[]
}

const view = (seed: Seed = {}): View => ({
  seq: 10,
  workflows: new Map([[workflow.id, workflow]]),
  stages: new Map([[stage.id, stage]]),
  agents: new Map([[agent.id, agent]]),
  runtimes: new Map([[runtime.id, runtime]]),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  rules: seed.rules ?? [],
  rulesVersion: seed.rulesVersion ?? 0,
  ruleSetReplacedAt: seed.replacedAt === undefined ? CREATED : seed.replacedAt,
  ruleFiredAt: new Map(seed.firedAt ?? []),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const types = (facts: Array<{ type: string }>): string[] => facts.map((fact) => fact.type)

describe('decide rules.replace', () => {
  it('合法批次产 rules.replaced（版本 +1）', () => {
    const decision = decide(
      view({ rulesVersion: 2 }),
      { type: 'rules.replace', commandId: 'c1', rules: [rule()] },
      NOW,
      env(),
    )
    expect(decision.reject).toBeUndefined()
    expect(types(decision.facts)).toEqual(['rules.replaced'])
    const fact = decision.facts[0]
    expect(fact?.actor).toEqual(ACTOR)
    expect(fact?.payload).toMatchObject({
      ruleSet: { id: 'current', version: 3, replacedAt: NOW, rules: [rule()] },
    })
  })

  it('空批次也合法（清空规则，版本继续 +1）', () => {
    const decision = decide(
      view({ rulesVersion: 5 }),
      { type: 'rules.replace', commandId: 'c1', rules: [] },
      NOW,
      env(),
    )
    expect(decision.facts[0]?.payload).toMatchObject({ ruleSet: { version: 6, rules: [] } })
  })

  it('非法批次整批拒绝且零事实', () => {
    const decision = decide(
      view(),
      { type: 'rules.replace', commandId: 'c1', rules: [rule({ to: { workflowId: 'wf-x' } })] },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject).toMatchObject({ code: 'invalid_input' })
  })
})

describe('decide 事件入口建任务', () => {
  it('event.received：入账 + 命规则建任务（run 带规则元信息）', () => {
    const decision = decide(
      view({ rules: [rule({ prompt: '按描述实现' })], rulesVersion: 1 }),
      {
        type: 'event.received',
        event: { source: 'github', type: 'issues.opened', subject: 'issue-1', summary: '摘要' },
      },
      NOW,
      env(),
    )
    expect(decision.reject).toBeUndefined()
    expect(types(decision.facts)).toEqual([
      'event.received',
      'thread.opened',
      'thread.event_attached',
      'task.created',
      'thread.task_attached',
      'run.queued',
    ])
    expect(decision.facts[0]?.payload).toMatchObject({
      source: 'github',
      type: 'issues.opened',
      subject: 'issue-1',
      hops: 1,
      originRunId: null,
    })
    const run = (
      decision.facts[5]?.payload as {
        run: { ruleId: string; rulesVersion: number; eventIds: string[] }
      }
    ).run
    expect(run.ruleId).toBe('rule-1')
    expect(run.rulesVersion).toBe(1)
    expect(run.eventIds).toEqual(['event-1'])
  })

  it('hops 超限：只写 event.dropped，不建任务', () => {
    const decision = decide(
      view({ rules: [rule()] }),
      {
        type: 'event.received',
        event: { source: 'github', type: 'issues.opened', subject: 'issue-1' },
        hops: 9,
      },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['event.dropped'])
  })

  it('app.event 走同一匹配路径（M6 起可建任务）', () => {
    const decision = decide(
      view({
        rules: [rule({ when: { source: 'app', types: ['pomodoro.completed'] } })],
        rulesVersion: 1,
      }),
      {
        type: 'app.event',
        commandId: 'c1',
        appId: 'pomodoro',
        eventType: 'pomodoro.completed',
        subject: '番茄结束',
      },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual([
      'event.received',
      'thread.opened',
      'thread.event_attached',
      'task.created',
      'thread.task_attached',
      'run.queued',
    ])
  })

  it('无规则命中：只入账', () => {
    const decision = decide(
      view({ rules: [rule({ when: { source: 'mail', types: ['*'] } })] }),
      {
        type: 'event.received',
        event: { source: 'github', type: 'issues.opened', subject: 'issue-1' },
      },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['event.received'])
  })
})

describe('decide clock.tick cron', () => {
  it('到点建任务并记 rule.fired（含 scheduledFor 与 taskId）', () => {
    const decision = decide(
      view({
        rules: [rule({ when: { cron: '0 9 * * *' } })],
        rulesVersion: 4,
        replacedAt: '2026-11-04T00:00:00.000Z',
      }),
      { type: 'clock.tick' },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'run.queued',
      'rule.fired',
    ])
    expect(decision.facts[4]?.payload).toMatchObject({
      fire: {
        ruleId: 'rule-1',
        version: 4,
        scheduledFor: NOW,
        firedAt: NOW,
        taskId: 'task-1',
      },
    })
  })

  it('目标工作流已删：只记 rule.fired（taskId=null）', () => {
    const decision = decide(
      view({
        rules: [rule({ when: { cron: '0 9 * * *' }, to: { workflowId: 'wf-gone' } })],
        replacedAt: '2026-11-04T00:00:00.000Z',
      }),
      { type: 'clock.tick' },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['rule.fired'])
    expect(
      (decision.facts[0]?.payload as { fire: { taskId: string | null } }).fire.taskId,
    ).toBeNull()
  })

  it('已触发过的到点时刻不再触发', () => {
    const decision = decide(
      view({
        rules: [rule({ when: { cron: '0 9 * * *' } })],
        replacedAt: '2026-11-04T00:00:00.000Z',
        firedAt: [['rule-1', NOW]],
      }),
      { type: 'clock.tick' },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
  })
})

describe('decide rule.trigger', () => {
  it('启用规则建一条任务（externalRef=null）', () => {
    const decision = decide(
      view({ rules: [rule()], rulesVersion: 2 }),
      { type: 'rule.trigger', commandId: 'c1', ruleId: 'rule-1' },
      NOW,
      env(),
    )
    expect(decision.reject).toBeUndefined()
    expect(types(decision.facts)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'run.queued',
    ])
    expect((decision.facts[2]?.payload as { task: Task }).task).toMatchObject({
      title: 'Issue 进研发',
      origin: 'rule',
      externalRef: null,
    })
  })

  it('规则不存在 / 停用 → reject 且零事实', () => {
    expect(
      decide(view(), { type: 'rule.trigger', commandId: 'c1', ruleId: 'rule-x' }, NOW, env()),
    ).toMatchObject({ facts: [], reject: { code: 'not_found' } })
    expect(
      decide(
        view({ rules: [rule({ enabled: false })] }),
        { type: 'rule.trigger', commandId: 'c1', ruleId: 'rule-1' },
        NOW,
        env(),
      ),
    ).toMatchObject({ facts: [], reject: { code: 'conflict' } })
  })
})

describe('decide 回执派生事件命中规则', () => {
  it('run.receipt 的 events[] 入账后建任务', () => {
    const run = {
      id: 'run-1',
      purpose: 'stage' as const,
      taskId: null,
      conversationId: null,
      stageId: null,
      agentId: 'ag-1',
      runtimeId: 'rt-1',
      ruleId: null,
      rulesVersion: 0,
      executorKey: 'dsh',
      threadId: null,
      cwd: '',
      access: 'edit' as const,
      skill: null,
      promptRef: null,
      eventIds: [],
      hops: 0,
      turn: 1,
      resumeSessionId: null,
      threadContextRef: null,
      queueSeq: 1,
      status: 'running' as const,
      prompt: 'p',
      output: '',
      error: null,
      errorCode: null,
      exitCode: null,
      sessionId: null,
      usage: null,
      durationMs: null,
      leaseId: 'run-1:1',
      attempt: 1,
      attempts: 0,
      leaseUntil: '2026-11-05T10:00:00.000Z',
      notBefore: null,
      deadlineAt: '2026-11-05T10:00:00.000Z',
      cancelRequested: false,
      startedAt: CREATED,
      endedAt: null,
      createdAt: CREATED,
    }
    const base = view({ rules: [rule()], rulesVersion: 1 })
    const decision = decide(
      { ...base, runs: new Map([[run.id, run]]) },
      {
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'succeeded',
          leaseId: 'run-1:1',
          turn: 1,
          output: 'ok',
          events: [
            { source: 'github', type: 'issues.opened', subject: 'issue-1', summary: '派生事件' },
          ],
        },
      },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toContain('event.received')
    expect(types(decision.facts)).toContain('task.created')
  })
})
