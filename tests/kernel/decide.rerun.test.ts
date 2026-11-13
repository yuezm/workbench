/**
 * `task.rerun`（失败重跑）：执行器崩了 / 关机 / CLI 坏了导致 run 失败后，原地再排一轮。
 *
 * 与 `task.comment{rerun}` 共用进入阶段效果（`turn+1`、线程上下文、会话续接、项目工作目录），
 * 区别只是不追加反馈正文；任务行不动，阶段与闸门预算都保留。
 */
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { ThreadRow } from '../../src/protocol/thread'
import type { Environment, IdKind, Limits, View } from '../../src/kernel/types'
import { decide } from '../../src/kernel/decide'

const CREATED = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-05T09:00:00.000Z'

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
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

const workflow: Workflow = { id: 'wf-1', name: '研发', description: '', createdAt: CREATED }

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '代码评审',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  exits: {},
  judge: null,
  handoffs: [],
  ...over,
})

const agent: Agent = {
  id: 'ag-1',
  name: '评审者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '你是评审者',
  // 执行配置在智能体上（运行时只管连接）
  model: null,
  reasoningEffort: null,
  maxConcurrent: 2,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
}

const runtime: Runtime = {
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
}

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '评审这版代码',
  description: '看下接口改动',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-1',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
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
  runtimeId: 'rt-1',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: '',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  status: 'failed',
  prompt: '',
  output: '',
  error: '执行器失联',
  errorCode: 'executor_lost',
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: 1,
  leaseId: null,
  attempt: 1,
  attempts: 1,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  startedAt: CREATED,
  endedAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'th-1',
  source: 'manual',
  externalRef: null,
  title: '评审这版代码',
  status: 'open',
  taskIds: ['task-1'],
  rootTaskIds: ['task-1'],
  concurrency: 1,
  notesVersion: 0,
  notes: [],
  events: [],
  lastActivityAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const view = (
  seed: {
    stages?: WorkflowStage[]
    tasks?: Task[]
    runs?: RunRow[]
    threads?: ThreadRow[]
    active?: string[]
  } = {},
): View => ({
  seq: 7,
  workflows: new Map([[workflow.id, workflow]]),
  stages: new Map((seed.stages ?? [stage()]).map((row) => [row.id, row])),
  agents: new Map([[agent.id, agent]]),
  runtimes: new Map([[runtime.id, runtime]]),
  projects: new Map(),
  tasks: new Map((seed.tasks ?? [task()]).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? [run()]).map((row) => [row.id, row])),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(seed.active ?? []),
  threads: new Map((seed.threads ?? []).map((row) => [row.id, row])),
  taskComments: new Map(),
  reviewReports: new Map(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const rerun = (v: View, id = 'task-1'): ReturnType<typeof decide> =>
  decide(v, { type: 'task.rerun', commandId: 'c1', id }, NOW, env())

describe('kernel/decide task.rerun', () => {
  it('失败收口后原地再排一轮：run.queued 带当前阶段 / 智能体 / 运行时，轮次 +1', () => {
    const decision = rerun(view())

    expect(decision.reject).toBeUndefined()
    expect(decision.facts.map((fact) => fact.type)).toEqual(['run.queued'])
    const queued = decision.facts[0]?.payload as { run: RunRow }
    expect(queued.run).toMatchObject({
      purpose: 'stage',
      taskId: 'task-1',
      stageId: 'st-1',
      agentId: 'ag-1',
      runtimeId: 'rt-1',
      status: 'queued',
      turn: 2,
      cwd: '',
      access: 'edit',
    })
    expect(decision.facts[0]?.actor).toEqual({ kind: 'owner', via: 'ui' })
  })

  it('挂在有历史的线程上：续接同智能体会话，提示词带线程上下文', () => {
    const decision = rerun(
      view({
        tasks: [task({ threadId: 'th-1' })],
        runs: [run({ threadId: 'th-1', sessionId: 'sess-9' })],
        threads: [
          thread({ notes: [{ id: 'n-1', author: 'owner', text: '先说性能', at: CREATED }] }),
        ],
      }),
    )

    const queued = decision.facts[0]?.payload as { run: RunRow }
    expect(queued.run.threadId).toBe('th-1')
    expect(queued.run.resumeSessionId).toBe('sess-9')
    expect(queued.run.prompt).toContain('# 线程上下文')
    expect(queued.run.prompt).toContain('先说性能')
  })

  it('任务不存在 → not_found，不产事实', () => {
    const decision = rerun(view(), 'task-x')
    expect(decision.reject?.code).toBe('not_found')
    expect(decision.facts).toEqual([])
  })

  it('已完成的任务 → conflict；执行中 → conflict（先停止再重排）', () => {
    const completed = rerun(view({ tasks: [task({ status: 'completed' })] }))
    expect(completed.reject?.code).toBe('conflict')
    expect(completed.reject?.message).toContain('已完成')
    expect(completed.facts).toEqual([])

    const executing = rerun(view({ active: ['task-1'] }))
    expect(executing.reject?.code).toBe('conflict')
    expect(executing.reject?.message).toContain('正在执行')
    expect(executing.facts).toEqual([])
  })

  it('当前阶段不交给智能体（user / none）→ conflict，不静默零事实', () => {
    const user = rerun(view({ stages: [stage({ entryMode: 'user', agentId: null })] }))
    expect(user.reject?.code).toBe('conflict')
    expect(user.reject?.message).toContain('不交给智能体')

    const none = rerun(view({ stages: [stage({ entryMode: 'none', agentId: null })] }))
    expect(none.reject?.code).toBe('conflict')
    expect(none.facts).toEqual([])
  })

  it('阶段无效 / 没有绑定智能体 / 运行时缺失 → conflict', () => {
    const staleStage = rerun(view({ tasks: [task({ currentStageId: 'st-gone' })] }))
    expect(staleStage.reject?.code).toBe('conflict')
    expect(staleStage.reject?.message).toContain('当前阶段无效')

    const noAgent = rerun(view({ stages: [stage({ agentId: null })] }))
    expect(noAgent.reject?.code).toBe('conflict')
    expect(noAgent.reject?.message).toContain('没有可用')

    const empty = view()
    empty.runtimes.clear()
    const noRuntime = rerun(empty)
    expect(noRuntime.reject?.code).toBe('conflict')
    expect(noRuntime.reject?.message).toContain('没有可用')
    expect(noRuntime.facts).toEqual([])
  })

  it('其他工作流的阶段挂到任务上 → conflict（阶段与任务必须同工作流）', () => {
    const decision = rerun(view({ stages: [stage({ workflowId: 'wf-2' })] }))
    expect(decision.reject?.code).toBe('conflict')
    expect(decision.reject?.message).toContain('当前阶段无效')
  })

  it('任务没有当前阶段（工作流还没配阶段就建了任务）→ conflict，不猜阶段', () => {
    const decision = rerun(view({ tasks: [task({ currentStageId: null })] }))
    expect(decision.reject?.code).toBe('conflict')
    expect(decision.reject?.message).toContain('当前阶段无效')
    expect(decision.facts).toEqual([])
  })
})
