// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '@workbench/protocol/entities'
import type { Mandate, Authority } from '@workbench/protocol/authority'
import { DEFAULT_ADMISSION_TABLE } from '@workbench/protocol/authority'
import type { AutomationRule } from '@workbench/protocol/rules'
import type { Environment, Limits, View } from '@workbench/kernel/core/types'
import { decide } from '@workbench/kernel/decide'

const NOW = '2026-11-17T12:00:00.000Z'
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
const agent = (mode: Agent['permissionMode'] = 'workspace-write'): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: mode,
  workdir: null,
  env: {},
  createdAt: CREATED,
})
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

const rule: AutomationRule = {
  id: 'rule-1',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
}

const authority: Authority = {
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
}

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '修登录页',
  description: '',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  archivedAt: null,
  origin: 'rule',
  ruleId: 'rule-1',
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  spawnedByRunId: null,
  batchNo: null,
  spawnKey: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
  projectId: null,
  gateFails: 0,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 'task-1',
  conversationId: null,
  stageId: 'st-1',
  agentId: 'ag-1',
  script: null,
  runtimeId: 'rt-1',
  ruleId: 'rule-1',
  rulesVersion: 4,
  executorKey: 'dsh',
  threadId: null,
  cwd: '/tmp',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  status: 'queued',
  prompt: 'p',
  output: '',
  error: '',
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  leaseId: null,
  attempt: 0,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  startedAt: null,
  endedAt: null,
  createdAt: CREATED,
  ...over,
})

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
  policyVersion: 4,
  ruleIds: ['rule-1'],
  by: {
    kind: 'identity',
    source: 'github',
    identity: { kind: 'human', id: 'octocat', addressed: true },
  },
  grantedAt: CREATED,
  revokedAt: null,
  revokedReason: null,
  legacy: false,
  ...over,
})

interface Seed {
  authority?: Authority | null
  agentPermission?: Agent['permissionMode']
  tasks?: Task[]
  runs?: RunRow[]
  mandates?: Map<string, Mandate>
}

const view = (seed: Seed = {}): View => ({
  seq: 10,
  workflows: new Map([[workflow.id, workflow]]),
  stages: new Map([[stage.id, stage]]),
  agents: new Map([[agent().id, agent(seed.agentPermission)]]),
  runtimes: new Map([[runtime.id, runtime]]),
  projects: new Map(),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  rules: [rule],
  rulesVersion: 4,
  ruleSetReplacedAt: CREATED,
  authority: seed.authority === undefined ? authority : seed.authority,
  ruleFiredAt: new Map(),
  mandates: seed.mandates ?? new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const received = {
  type: 'event.received' as const,
  event: {
    source: 'github',
    type: 'issues.opened',
    subject: '#42 登录页报错',
    identity: { kind: 'human' as const, id: 'octocat', addressed: true },
  },
  hops: 1,
}

const types = (facts: Array<{ type: string }>): string[] => facts.map((fact) => fact.type)

describe('A2 建任务时授予', () => {
  it('事件建任务同批产 mandate.granted（强度 / 依据 / 版本 / 来源都对得上）', () => {
    const decision = decide(view(), received, NOW, env())
    expect(types(decision.facts)).toContain('mandate.granted')
    const granted = decision.facts.find((fact) => fact.type === 'mandate.granted')
    expect(granted?.payload).toMatchObject({
      mandate: {
        taskId: 'task-1',
        strength: 'explicit',
        basis: 'addressed',
        policyVersion: 4,
        ruleIds: ['rule-1'],
        by: {
          kind: 'identity',
          source: 'github',
          identity: { kind: 'human', id: 'octocat', addressed: true },
        },
        revokedAt: null,
        legacy: false,
      },
    })
    expect((granted?.payload as { mandate: Mandate }).mandate.scope).toEqual({
      workflowId: 'wf-1',
      stageId: 'st-1',
      projectId: null,
      access: 'edit',
      maxRuns: null,
      maxTokens: null,
      expiresAt: null,
    })
  })

  it('兼容模式（没有准入配置）不授予：与 M45 一致，不灌无用事实', () => {
    const decision = decide(view({ authority: null }), received, NOW, env())
    expect(types(decision.facts)).toContain('task.created')
    expect(types(decision.facts)).not.toContain('mandate.granted')
  })

  it('人工停止同时撤销授权', () => {
    const decision = decide(
      view({ tasks: [task()], runs: [run()], mandates: new Map([['task-1', mandate()]]) }),
      { type: 'task.stop', commandId: 'c1', id: 'task-1' },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['run.cancel_requested', 'mandate.revoked'])
    expect(decision.facts[1]?.payload).toMatchObject({
      mandate: { revokedReason: 'stop', revokedAt: NOW },
    })
  })

  it('没有授权的任务停止：零撤销事实（老任务不必造授权）', () => {
    const decision = decide(
      view({ tasks: [task()], runs: [run()] }),
      { type: 'task.stop', commandId: 'c1', id: 'task-1' },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['run.cancel_requested'])
  })
})

describe('A2 领活前重校验', () => {
  it('授权成立：照常领取', () => {
    const decision = decide(
      view({ tasks: [task()], runs: [run()], mandates: new Map([['task-1', mandate()]]) }),
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 1 },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['run.claimed'])
  })

  it('已撤销：不领取、零事实（重试也不刷日志）', () => {
    const revoked = mandate({ revokedAt: CREATED, revokedReason: 'stop' })
    const decision = decide(
      view({ tasks: [task()], runs: [run()], mandates: new Map([['task-1', revoked]]) }),
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 1 },
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
  })

  it('重校验失败：不领取，并当场撤销 + 留痕', () => {
    const strict: Authority = {
      ...authority,
      sources: authority.sources.map((item) => ({ ...item, allowed: [] })),
    }
    const decision = decide(
      view({
        authority: strict,
        tasks: [task()],
        runs: [run()],
        mandates: new Map([['task-1', mandate()]]),
      }),
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 1 },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['mandate.revalidated', 'mandate.revoked'])
    expect(decision.facts[0]?.payload).toMatchObject({ ok: false, taskId: 'task-1' })
    expect(decision.facts[1]?.payload).toMatchObject({
      mandate: { revokedReason: 'revalidate' },
    })
  })

  it('没有授权的老任务：照旧领取（不因缺授权而卡住）', () => {
    const decision = decide(
      view({ tasks: [task()], runs: [run()] }),
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 1 },
      NOW,
      env(),
    )
    expect(types(decision.facts)).toEqual(['run.claimed'])
  })
})

describe('A2 权限只收紧不放宽', () => {
  it('智能体 full + 授权 read → run.access 收到 read', () => {
    const decision = decide(
      view({
        agentPermission: 'danger-full-access',
        mandates: new Map([['task-1', mandate({ scope: { ...mandate().scope, access: 'read' } })]]),
      }),
      {
        type: 'task.create',
        commandId: 'c1',
        input: { title: '新任务', description: '', workflowId: 'wf-1', stageId: 'st-1' },
      } as never,
      NOW,
      env(),
    )
    const queued = decision.facts.find((fact) => fact.type === 'run.queued')
    expect((queued?.payload as { run: RunRow }).run.access).toBe('read')
  })
})
