import { describe, expect, it } from 'vitest'
import type {
  Agent,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { EventReceivedPayload } from '../../src/protocol/facts'
import type { AutomationRule } from '../../src/protocol/rules'
import type { ThreadRow } from '../../src/protocol/thread'
import type { Environment, Limits, View } from '../../src/kernel/types'
import {
  cronDue,
  eventThreadFacts,
  externalRefOf,
  manualTriggerFacts,
  ruleMatchesEvent,
  ruleTypeMatches,
  validateRuleBatch,
} from '../../src/kernel/rules'

const NOW = '2026-11-05T09:00:00.000Z'
const CREATED = '2026-11-04T00:00:00.000Z'

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

const env = (timezone = 'UTC'): Environment => {
  const counters = new Map<string, number>()
  return {
    timezone,
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
  }
}

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
  ...over,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '实现',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  exits: {},
  judge: null,
  handoffs: [],
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  // 执行配置在智能体上（运行时只管连接）
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
  ...over,
})

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: 'dsh',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '旧任务',
  description: '',
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
  stageFails: 0,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const runRow = (over: Partial<RunRow> = {}): RunRow => ({
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
  status: 'queued',
  prompt: '',
  output: '',
  error: null,
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
  threads?: ThreadRow[]
}

const view = (seed: Seed = {}): View => ({
  seq: 10,
  workflows: new Map([workflow()].map((row) => [row.id, row])),
  stages: new Map(
    [stage(), stage({ id: 'st-2', position: 1, name: '完成', entryMode: 'none' })].map((row) => [
      row.id,
      row,
    ]),
  ),
  agents: new Map([agent()].map((row) => [row.id, row])),
  runtimes: new Map([runtime()].map((row) => [row.id, row])),
  projects: new Map(),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map((seed.threads ?? []).map((row) => [row.id, row])),
  taskComments: new Map(),
  reviewReports: new Map(),
  rules: seed.rules ?? [],
  rulesVersion: seed.rulesVersion ?? 1,
  ruleSetReplacedAt: seed.replacedAt === undefined ? CREATED : seed.replacedAt,
  ruleFiredAt: new Map(seed.firedAt ?? []),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'th-1',
  source: 'github',
  externalRef: 'issue-1',
  title: 'issue-1',
  status: 'open',
  taskIds: [],
  rootTaskIds: [],
  concurrency: 1,
  notesVersion: 0,
  notes: [],
  events: [],
  lastActivityAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const event: EventReceivedPayload = {
  eventId: 'event-1',
  source: 'github',
  type: 'issues.opened',
  subject: 'issue-1',
  summary: '新 Issue',
  detailRef: null,
  link: null,
  hops: 1,
  originRunId: null,
  dedupeKey: 'github:issue-1',
}

describe('kernel/rules 匹配', () => {
  it('type 模式：精确 / * / 前缀', () => {
    expect(ruleTypeMatches('issues.opened', 'issues.opened')).toBe(true)
    expect(ruleTypeMatches('issues.opened', 'issues.closed')).toBe(false)
    expect(ruleTypeMatches('*', 'anything.at-all')).toBe(true)
    expect(ruleTypeMatches('issues.*', 'issues.opened')).toBe(true)
    expect(ruleTypeMatches('issues.*', 'issues')).toBe(false)
    expect(ruleTypeMatches('issue.*', 'issues.opened')).toBe(false)
  })

  it('source 精确或 *；cron 规则不参与事件匹配；停用不算命中', () => {
    expect(ruleMatchesEvent(rule(), event)).toBe(true)
    expect(ruleMatchesEvent(rule({ when: { source: '*', types: ['*'] } }), event)).toBe(true)
    expect(ruleMatchesEvent(rule({ when: { source: 'mail', types: ['*'] } }), event)).toBe(false)
    expect(ruleMatchesEvent(rule({ when: { cron: '0 9 * * *' } }), event)).toBe(false)
    expect(ruleMatchesEvent(rule({ enabled: false }), event)).toBe(false)
  })

  it('externalRef：缺省 subject，externalRef 取 dedupeKey', () => {
    expect(externalRefOf(rule(), event)).toBe('issue-1')
    expect(
      externalRefOf(
        rule({ to: { workflowId: 'wf-1', thread: { keyFrom: 'externalRef' } } }),
        event,
      ),
    ).toBe('github:issue-1')
    // dedupeKey 缺失时回落到 subject
    expect(
      externalRefOf(rule({ to: { workflowId: 'wf-1', thread: { keyFrom: 'externalRef' } } }), {
        ...event,
        dedupeKey: null,
      }),
    ).toBe('issue-1')
  })
})

describe('kernel/rules 建任务', () => {
  it('命中一条规则：开线程 + 建任务 + 入口 run（带 ruleId / eventIds / hops）', () => {
    const facts = eventThreadFacts(
      view({ rules: [rule({ prompt: '按 Issue 描述实现' })] }),
      event,
      3,
      NOW,
      env(),
    )
    expect(facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.event_attached',
      'task.created',
      'thread.task_attached',
      'run.queued',
    ])
    expect(facts[0]?.actor).toEqual({ kind: 'kernel' })
    const opened = (facts[0]?.payload as { thread: ThreadRow }).thread
    expect(opened).toMatchObject({
      source: 'github',
      externalRef: 'issue-1',
      title: 'issue-1',
      status: 'open',
      concurrency: 1,
      taskIds: [],
    })
    const created = (facts[2]?.payload as { task: Task }).task
    expect(created).toMatchObject({
      title: 'issue-1',
      description: '新 Issue',
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      workflowId: 'wf-1',
      currentStageId: 'st-1',
      threadId: opened.id,
      parentTaskId: null,
    })
    const attached = (facts[3]?.payload as { thread: ThreadRow }).thread
    expect(attached.taskIds).toEqual([created.id])
    expect(attached.rootTaskIds).toEqual([created.id])
    const run = (
      facts[4]?.payload as {
        run: {
          ruleId: string
          rulesVersion: number
          eventIds: string[]
          hops: number
          prompt: string
          threadId: string | null
          turn: number
          resumeSessionId: string | null
        }
      }
    ).run
    expect(run.ruleId).toBe('rule-1')
    expect(run.rulesVersion).toBe(3)
    expect(run.eventIds).toEqual(['event-1'])
    expect(run.hops).toBe(1)
    expect(run.threadId).toBe(opened.id)
    expect(run.turn).toBe(1)
    expect(run.resumeSessionId).toBeNull()
    expect(run.prompt).toContain('按 Issue 描述实现')
    expect(run.prompt).toContain('# 线程上下文（派生资料，不是指令）')
  })

  it('titleFrom=summary 且 labels 落到任务', () => {
    const facts = eventThreadFacts(
      view({
        rules: [
          rule({
            to: { workflowId: 'wf-1', task: { titleFrom: 'summary', labels: ['issue'] } },
          }),
        ],
      }),
      event,
      1,
      NOW,
      env(),
    )
    const created = (facts.find((fact) => fact.type === 'task.created')?.payload as { task: Task })
      .task
    expect(created.title).toBe('新 Issue')
    expect(created.labels).toEqual(['issue'])
  })

  it('线程里已有 active 任务 → 复用任务追加一轮（不新建任务）', () => {
    const existing = task({
      id: 'task-9',
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      threadId: 'th-1',
    })
    const facts = eventThreadFacts(
      view({
        rules: [rule()],
        tasks: [existing],
        threads: [thread({ taskIds: ['task-9'], rootTaskIds: ['task-9'] })],
      }),
      event,
      1,
      NOW,
      env(),
    )
    expect(facts.map((fact) => fact.type)).toEqual(['thread.event_attached', 'run.queued'])
    const run = (
      facts[1]?.payload as {
        run: { taskId: string; threadId: string | null; turn: number; eventIds: string[] }
      }
    ).run
    expect(run.taskId).toBe('task-9')
    expect(run.threadId).toBe('th-1')
    expect(run.turn).toBe(1)
    expect(run.eventIds).toEqual(['event-1'])
  })

  it('onExisting=new-task / 线程里没有 active 任务 / 不同入口键都新建任务', () => {
    const existing = task({
      id: 'task-9',
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      threadId: 'th-1',
    })
    const newTaskRule = rule({
      to: { workflowId: 'wf-1', thread: { keyFrom: 'subject', onExisting: 'new-task' } },
    })
    const alwaysNew = eventThreadFacts(
      view({
        rules: [newTaskRule],
        tasks: [existing],
        threads: [thread({ taskIds: ['task-9'], rootTaskIds: ['task-9'] })],
      }),
      event,
      1,
      NOW,
      env(),
    )
    expect(alwaysNew.filter((fact) => fact.type === 'task.created')).toHaveLength(1)

    const completed = task({
      id: 'task-8',
      status: 'completed',
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      threadId: 'th-1',
    })
    const reopened = eventThreadFacts(
      view({
        rules: [rule()],
        tasks: [completed],
        threads: [thread({ taskIds: ['task-8'], rootTaskIds: ['task-8'] })],
      }),
      event,
      1,
      NOW,
      env(),
    )
    expect(reopened.filter((fact) => fact.type === 'task.created')).toHaveLength(1)

    const otherKey = eventThreadFacts(
      view({
        rules: [rule()],
        tasks: [task({ id: 'task-9', origin: 'rule', ruleId: 'rule-1', externalRef: 'x' })],
        threads: [thread({ externalRef: 'x', taskIds: ['task-9'], rootTaskIds: ['task-9'] })],
      }),
      event,
      1,
      NOW,
      env(),
    )
    expect(otherKey.filter((fact) => fact.type === 'task.created')).toHaveLength(1)
    expect(otherKey.filter((fact) => fact.type === 'thread.opened')).toHaveLength(1)
  })

  it('线程里有 queued run → 事件合并（不新建任务 / run）', () => {
    const existing = task({
      id: 'task-9',
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      threadId: 'th-1',
    })
    const queued = runRow({ id: 'run-queued', taskId: 'task-9', threadId: 'th-1' })
    const seeded = view({
      rules: [rule()],
      tasks: [existing],
      threads: [thread({ taskIds: ['task-9'], rootTaskIds: ['task-9'] })],
    })
    const facts = eventThreadFacts(
      { ...seeded, runs: new Map([[queued.id, queued]]) },
      event,
      1,
      NOW,
      env(),
    )
    expect(facts.map((fact) => fact.type)).toEqual(['thread.event_attached', 'event.merged'])
    const merged = (facts[1]?.payload as { run: { eventIds: string[] } }).run
    expect(merged.eventIds).toEqual(['event-1'])
  })

  it('同一事件命中多条规则全部建任务（不排序、不取最优）', () => {
    const facts = eventThreadFacts(
      view({
        rules: [
          rule({ id: 'rule-a', name: 'A' }),
          rule({ id: 'rule-b', name: 'B', to: { workflowId: 'wf-1', stageId: 'st-2' } }),
        ],
      }),
      event,
      2,
      NOW,
      env(),
    )
    const tasks = facts
      .filter((fact) => fact.type === 'task.created')
      .map((fact) => (fact.payload as { task: Task }).task)
    expect(tasks.map((row) => row.ruleId)).toEqual(['rule-a', 'rule-b'])
    // 两条规则同一入口键 → 同一线程；st-2 是 none 入口 → 只有第一条任务产 run
    expect(facts.filter((fact) => fact.type === 'thread.opened')).toHaveLength(1)
    expect(facts.filter((fact) => fact.type === 'run.queued')).toHaveLength(1)
  })

  it('目标工作流 / 阶段不存在时跳过（不产事实）', () => {
    const missingWorkflow = rule({ to: { workflowId: 'wf-gone' } })
    expect(eventThreadFacts(view({ rules: [missingWorkflow] }), event, 1, NOW, env())).toEqual([])
    const wrongStage = rule({ to: { workflowId: 'wf-1', stageId: 'st-gone' } })
    expect(eventThreadFacts(view({ rules: [wrongStage] }), event, 1, NOW, env())).toEqual([])
  })

  it('目标工作流没有阶段：建任务但不产 run（currentStageId=null）', () => {
    const scratch = view({ rules: [rule()] })
    const facts = eventThreadFacts({ ...scratch, stages: new Map() }, event, 1, NOW, env())
    expect(facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.event_attached',
      'task.created',
      'thread.task_attached',
    ])
    const created = (facts[2]?.payload as { task: Task }).task
    expect(created.currentStageId).toBeNull()
  })

  it('标题取字：空 subject 按规则名截断、超长截断、summary 为空回落到 subject', () => {
    const createdOf = (facts: ReturnType<typeof eventThreadFacts>): Task =>
      (facts.find((fact) => fact.type === 'task.created')?.payload as { task: Task }).task
    const noSubject = { ...event, subject: '   ' }
    const fallback = eventThreadFacts(view({ rules: [rule()] }), noSubject, 1, NOW, env())
    expect(createdOf(fallback).title).toBe('Issue 进研发')

    const longSubject = { ...event, subject: 'x'.repeat(201) }
    const truncated = eventThreadFacts(view({ rules: [rule()] }), longSubject, 1, NOW, env())
    expect(createdOf(truncated).title).toHaveLength(200)

    const summaryRule = rule({ to: { workflowId: 'wf-1', task: { titleFrom: 'summary' } } })
    const fallbackSummary = eventThreadFacts(
      view({ rules: [summaryRule] }),
      { ...event, summary: '' },
      1,
      NOW,
      env(),
    )
    expect(createdOf(fallbackSummary).title).toBe('issue-1')
  })

  it('同一事件的多条规则入口键不同：各开各的线程（本批线程查找不串）', () => {
    const facts = eventThreadFacts(
      view({
        rules: [
          rule({ id: 'rule-a', name: 'A' }),
          rule({
            id: 'rule-b',
            name: 'B',
            to: { workflowId: 'wf-1', thread: { keyFrom: 'externalRef' } },
          }),
        ],
      }),
      event,
      1,
      NOW,
      env(),
    )
    expect(facts.filter((fact) => fact.type === 'thread.opened')).toHaveLength(2)
    expect(facts.filter((fact) => fact.type === 'task.created')).toHaveLength(2)
  })

  it('复用任务但当前阶段不是 agent 入口：只挂事件、不产 run', () => {
    const existing = task({
      id: 'task-9',
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      threadId: 'th-1',
      currentStageId: 'st-user',
    })
    const seeded = view({
      rules: [rule()],
      tasks: [existing],
      threads: [thread({ taskIds: ['task-9'], rootTaskIds: ['task-9'] })],
    })
    const facts = eventThreadFacts(
      {
        ...seeded,
        stages: new Map([
          ...seeded.stages,
          ['st-user', stage({ id: 'st-user', entryMode: 'user' })],
        ]),
      },
      event,
      1,
      NOW,
      env(),
    )
    expect(facts.map((fact) => fact.type)).toEqual(['thread.event_attached'])
  })

  it('已关闭线程收到新事件：先重开再归并', () => {
    const existing = task({
      id: 'task-9',
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      threadId: 'th-1',
    })
    const seeded = view({
      rules: [rule()],
      tasks: [existing],
      threads: [thread({ status: 'closed', taskIds: ['task-9'], rootTaskIds: ['task-9'] })],
    })
    const facts = eventThreadFacts(seeded, event, 1, NOW, env())
    expect(facts.map((fact) => fact.type)).toEqual([
      'thread.reopened',
      'thread.event_attached',
      'run.queued',
    ])
    expect((facts[0]?.payload as { thread: ThreadRow }).thread.status).toBe('open')
  })

  it('回执派生事件：按父任务归线程并记 parentTaskId（永远新建子任务）', () => {
    const parent = task({ id: 'task-parent', origin: 'rule', ruleId: 'rule-1', threadId: 'th-1' })
    const parentRun = runRow({ id: 'run-parent', taskId: 'task-parent', threadId: 'th-1' })
    const seeded = view({
      rules: [rule()],
      tasks: [parent],
      threads: [thread({ taskIds: ['task-parent'], rootTaskIds: ['task-parent'] })],
    })
    const derived = {
      ...event,
      eventId: 'event-child',
      originRunId: 'run-parent',
      subject: 'child',
    }
    const facts = eventThreadFacts(
      { ...seeded, runs: new Map([[parentRun.id, parentRun]]) },
      derived,
      1,
      NOW,
      env(),
    )
    const created = (facts.find((fact) => fact.type === 'task.created')?.payload as { task: Task })
      .task
    expect(created.threadId).toBe('th-1')
    expect(created.parentTaskId).toBe('task-parent')
    expect(created.externalRef).toBe('child')
  })
})
describe('kernel/rules cron', () => {
  it('baseline = replacedAt：只补最近一次到点', () => {
    const due = cronDue(
      view({
        rules: [rule({ when: { cron: '0 9 * * *' } })],
        replacedAt: '2026-11-01T00:00:00.000Z',
      }),
      NOW,
      'UTC',
    )
    expect(due).toHaveLength(1)
    // 11-01 ~ 11-05 每天 09:00 都到点，只补最近一次（11-05 09:00）
    expect(due[0]?.scheduledFor).toBe('2026-11-05T09:00:00.000Z')
  })

  it('已触发过的时刻不再重复；lastFired 之后的到点才触发', () => {
    const rules = [rule({ when: { cron: '0 9 * * *' } })]
    expect(
      cronDue(
        view({ rules, firedAt: [['rule-1', '2026-11-05T09:00:00.000Z']], replacedAt: CREATED }),
        NOW,
        'UTC',
      ),
    ).toEqual([])
    const next = cronDue(
      view({ rules, firedAt: [['rule-1', '2026-11-04T09:00:00.000Z']], replacedAt: CREATED }),
      NOW,
      'UTC',
    )
    expect(next[0]?.scheduledFor).toBe('2026-11-05T09:00:00.000Z')
  })

  it('未启用 / 非 cron 规则不触发；无 replacedAt 基线不触发', () => {
    expect(
      cronDue(
        view({
          rules: [rule({ when: { cron: '0 9 * * *' }, enabled: false })],
          replacedAt: CREATED,
        }),
        NOW,
        'UTC',
      ),
    ).toEqual([])
    expect(cronDue(view({ rules: [rule()], replacedAt: CREATED }), NOW, 'UTC')).toEqual([])
    expect(
      cronDue(
        view({ rules: [rule({ when: { cron: '0 9 * * *' } })], replacedAt: null }),
        NOW,
        'UTC',
      ),
    ).toEqual([])
  })

  it('时区：Asia/Shanghai 的 09:00 对应 01:00Z', () => {
    const due = cronDue(
      view({
        rules: [rule({ when: { cron: '0 9 * * *' } })],
        replacedAt: '2026-11-04T16:00:00.000Z',
      }),
      '2026-11-05T01:00:00.000Z',
      'Asia/Shanghai',
    )
    expect(due[0]?.scheduledFor).toBe('2026-11-05T01:00:00.000Z')
  })

  it('非法 cron 跳过（规则未经整批校验直接进视图的防御）', () => {
    expect(
      cronDue(view({ rules: [rule({ when: { cron: 'bad' } })], replacedAt: CREATED }), NOW, 'UTC'),
    ).toEqual([])
  })
})

describe('kernel/rules 手动触发', () => {
  it('规则不存在 / 停用 → reject', () => {
    expect(manualTriggerFacts(view(), 'rule-x', NOW, env()).reject).toMatchObject({
      code: 'not_found',
    })
    const disabled = manualTriggerFacts(
      view({ rules: [rule({ enabled: false })] }),
      'rule-1',
      NOW,
      env(),
    )
    expect(disabled.reject).toMatchObject({ code: 'conflict' })
  })

  it('启用规则 → 隐式线程 + 建任务（externalRef=null）+ run', () => {
    const decision = manualTriggerFacts(view({ rules: [rule()] }), 'rule-1', NOW, env())
    expect(decision.reject).toBeUndefined()
    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'run.queued',
    ])
    const created = (decision.facts[2]?.payload as { task: Task }).task
    expect(created.title).toBe('Issue 进研发')
    expect(created.origin).toBe('rule')
    expect(created.externalRef).toBeNull()
    const openedThread = (decision.facts[0]?.payload as { thread: ThreadRow }).thread
    expect(created.threadId).toBe(openedThread.id)
    expect(decision.facts[2]?.actor).toEqual({ kind: 'owner', via: 'ui' })
    const opened = (decision.facts[0]?.payload as { thread: ThreadRow }).thread
    expect(opened).toMatchObject({ source: 'manual', externalRef: null, title: 'Issue 进研发' })
  })

  it('目标工作流已删 → reject conflict（不建任务）', () => {
    const decision = manualTriggerFacts(
      view({ rules: [rule({ to: { workflowId: 'wf-gone' } })] }),
      'rule-1',
      NOW,
      env(),
    )
    expect(decision.facts).toEqual([])
    expect(decision.reject).toMatchObject({ code: 'conflict' })
  })
})

describe('kernel/rules 规则批量校验', () => {
  it('合法批次：版本 +1，id/name 去空白', () => {
    const result = validateRuleBatch(view(), [rule({ id: ' rule-1 ', name: ' 事件 ' })])
    expect('error' in result).toBe(false)
    const ok = result as { rules: AutomationRule[]; version: number }
    expect(ok.version).toBe(2)
    expect(ok.rules[0]).toMatchObject({ id: 'rule-1', name: '事件' })
  })

  it('工作流 / 阶段 / id / cron 非法整批报错', () => {
    expect(validateRuleBatch(view(), [rule({ to: { workflowId: 'wf-x' } })])).toMatchObject({
      error: '规则「Issue 进研发」: 工作流不存在: wf-x',
    })
    expect(
      validateRuleBatch(view(), [rule({ to: { workflowId: 'wf-1', stageId: 'st-2' } })]),
    ).toEqual({ rules: [rule({ to: { workflowId: 'wf-1', stageId: 'st-2' } })], version: 2 })
    expect(
      validateRuleBatch(view(), [rule({ to: { workflowId: 'wf-1', stageId: 'st-x' } })]),
    ).toMatchObject({ error: '规则「Issue 进研发」: 起始阶段不属于该工作流: st-x' })
    expect(validateRuleBatch(view(), [rule(), rule()])).toMatchObject({
      error: '规则 id 重复: rule-1',
    })
    expect(validateRuleBatch(view(), [rule({ when: { cron: 'bad' } })])).toMatchObject({
      error: '规则「Issue 进研发」: cron 表达式非法: bad',
    })
    expect(validateRuleBatch(view(), [rule({ when: { source: '', types: ['*'] } })])).toMatchObject(
      { error: '规则「Issue 进研发」: source 必填' },
    )
    expect(
      validateRuleBatch(view(), [rule({ when: { source: 'github', types: [] } })]),
    ).toMatchObject({ error: '规则「Issue 进研发」: types 至少 1 项' })
  })

  it('缺条 / 空 id / 空名 / 空 cron 逐项报错', () => {
    expect(validateRuleBatch(view(), [undefined as unknown as AutomationRule])).toMatchObject({
      error: '规则 1: 缺失',
    })
    expect(validateRuleBatch(view(), [rule({ id: '   ' })])).toMatchObject({
      error: '规则 1: id 必填',
    })
    expect(validateRuleBatch(view(), [rule({ name: '   ' })])).toMatchObject({
      error: '规则 1: 名称必填',
    })
    expect(validateRuleBatch(view(), [rule({ when: { cron: '   ' } })])).toMatchObject({
      error: '规则「Issue 进研发」: cron 必填',
    })
  })
})
