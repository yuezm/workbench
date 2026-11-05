import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Card,
  Conversation,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { FactPayload, FactType } from '../../src/protocol/facts'
import { IMPORT_ROOT_LABEL, timeline } from '../../src/kernel/timeline'
import type { Fact } from '../../src/kernel/types'

const ACTOR = { kind: 'kernel' } as const
const AT = '2026-11-04T12:00:00.000Z'

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: AT,
  ...over,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  createdAt: AT,
  ...over,
})

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: AT,
  lastProbe: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  status: 'active',
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'queued',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: 'D:/work',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  prompt: '做点什么',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: null,
  endedAt: null,
  createdAt: AT,
  conversationId: null,
  leaseId: null,
  attempt: 0,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  ...over,
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'cv-1',
  title: '新对话',
  agentId: 'ag-1',
  sessionId: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '选一个',
  text: '做哪个？',
  options: ['甲', '乙'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const fact = <T extends FactType>(
  seq: number,
  type: T,
  payload: FactPayload<T>,
  cause?: number,
): Fact<T> => ({ seq, type, actor: ACTOR, at: AT, payload, cause })

const imported = (seq: number, payload: FactPayload<'snapshot.imported'>): Fact => ({
  seq,
  type: 'snapshot.imported',
  actor: ACTOR,
  at: AT,
  payload,
})

const kinds = (entries: ReturnType<typeof timeline>): string[] =>
  entries.map((entry) => `${entry.fact.seq}:${entry.fact.type}`)

describe('kernel/timeline', () => {
  it('任务时间线按 seq 升序，只含该任务的事实', () => {
    const facts: Fact[] = [
      fact(3, 'task.completed', { task: task({ status: 'completed' }) }),
      fact(1, 'task.created', { task: task() }),
      fact(2, 'task.moved', { task: task({ currentStageId: 'st-2' }), from: 'st-1', to: 'st-2' }),
      fact(4, 'task.created', { task: task({ id: 't-2' }) }),
    ]

    const entries = timeline(facts, 'task', 't-1')

    expect(kinds(entries)).toEqual(['1:task.created', '2:task.moved', '3:task.completed'])
    expect(entries.every((entry) => entry.imported === false)).toBe(true)
    expect(entries.every((entry) => entry.label === null)).toBe(true)
  })

  it('沿 cause 链补齐不直接引用该实体的前置事实', () => {
    const facts: Fact[] = [
      fact(1, 'workflow.created', { workflow: workflow() }),
      fact(2, 'task.created', { task: task() }, 1),
      fact(
        3,
        'task.moved',
        { task: task({ currentStageId: 'st-2' }), from: 'st-1', to: 'st-2' },
        2,
      ),
    ]

    expect(kinds(timeline(facts, 'task', 't-1'))).toEqual([
      '1:workflow.created',
      '2:task.created',
      '3:task.moved',
    ])
    // cause 链只向上补前置，不会把该任务的事实带进别的工作流时间线
    expect(kinds(timeline(facts, 'workflow', 'wf-1'))).toEqual(['1:workflow.created'])
  })

  it('迁移导入根标注「迁移导入」，不伪造 cause', () => {
    const facts: Fact[] = [
      imported(1, { table: 'tasks', rows: [task()], importedFrom: 'v2' }),
      fact(2, 'task.moved', {
        task: task({ currentStageId: 'st-2' }),
        from: 'st-1',
        to: 'st-2',
      }),
    ]

    const entries = timeline(facts, 'task', 't-1')

    expect(kinds(entries)).toEqual(['1:snapshot.imported', '2:task.moved'])
    expect(entries[0].imported).toBe(true)
    expect(entries[0].label).toBe(IMPORT_ROOT_LABEL)
    expect(entries[0].fact.cause).toBeUndefined()
    expect(entries[1].imported).toBe(false)
  })

  it('导入根覆盖五张表：按表映射到实体范围', () => {
    const facts: Fact[] = [
      imported(1, { table: 'workflows', rows: [workflow()], importedFrom: 'v2' }),
      imported(2, {
        table: 'workflow_stages',
        rows: [stage()],
        importedFrom: 'v2',
      }),
      imported(3, { table: 'agents', rows: [agent()], importedFrom: 'v2' }),
      imported(4, { table: 'runtimes', rows: [runtime()], importedFrom: 'v2' }),
      imported(5, {
        table: 'tasks',
        rows: [task(), task({ id: 't-2' })],
        importedFrom: 'v2',
      }),
    ]

    expect(kinds(timeline(facts, 'workflow', 'wf-1'))).toEqual(['1:snapshot.imported'])
    expect(kinds(timeline(facts, 'stage', 'st-1'))).toEqual(['2:snapshot.imported'])
    expect(kinds(timeline(facts, 'agent', 'ag-1'))).toEqual(['3:snapshot.imported'])
    expect(kinds(timeline(facts, 'runtime', 'rt-1'))).toEqual(['4:snapshot.imported'])
    expect(kinds(timeline(facts, 'task', 't-2'))).toEqual(['5:snapshot.imported'])
    expect(timeline(facts, 'task', 't-404')).toEqual([])
  })

  it('各类实体事实都按自己的范围命中', () => {
    const facts: Fact[] = [
      fact(1, 'workflow.created', { workflow: workflow() }),
      fact(2, 'workflow.updated', { workflow: workflow() }),
      fact(3, 'workflow.removed', { workflow: workflow() }),
      fact(4, 'stage.created', { stage: stage() }),
      fact(5, 'stage.updated', { stage: stage() }),
      fact(6, 'stage.deleted', { stage: stage() }),
      fact(7, 'agent.created', { agent: agent() }),
      fact(8, 'agent.updated', { agent: agent() }),
      fact(9, 'agent.removed', { agent: agent() }),
      fact(10, 'runtime.created', { runtime: runtime() }),
      fact(11, 'runtime.updated', { runtime: runtime() }),
      fact(12, 'runtime.removed', { runtime: runtime() }),
      fact(13, 'runtime.probed', { runtime: runtime() }),
      fact(14, 'task.created', { task: task() }),
      fact(15, 'task.moved', { task: task(), from: 'st-2', to: 'st-1' }),
      fact(16, 'task.completed', { task: task() }),
      fact(17, 'task.removed', { task: task() }),
    ]

    expect(kinds(timeline(facts, 'workflow', 'wf-1'))).toEqual([
      '1:workflow.created',
      '2:workflow.updated',
      '3:workflow.removed',
    ])
    expect(kinds(timeline(facts, 'stage', 'st-1'))).toEqual([
      '4:stage.created',
      '5:stage.updated',
      '6:stage.deleted',
    ])
    expect(kinds(timeline(facts, 'agent', 'ag-1'))).toEqual([
      '7:agent.created',
      '8:agent.updated',
      '9:agent.removed',
    ])
    expect(kinds(timeline(facts, 'runtime', 'rt-1'))).toEqual([
      '10:runtime.created',
      '11:runtime.updated',
      '12:runtime.removed',
      '13:runtime.probed',
    ])
    expect(kinds(timeline(facts, 'task', 't-1'))).toEqual([
      '14:task.created',
      '15:task.moved',
      '16:task.completed',
      '17:task.removed',
    ])
  })

  it('cause 指向不在序列里的序号时链条截断，不补猜测', () => {
    const facts: Fact[] = [
      fact(5, 'task.created', { task: task() }, 99),
      fact(6, 'task.removed', { task: task() }, 5),
    ]

    expect(kinds(timeline(facts, 'task', 't-1'))).toEqual(['5:task.created', '6:task.removed'])
  })

  it('多条事实共享同一前置时去重，输出与入参顺序无关', () => {
    const facts: Fact[] = [
      fact(
        2,
        'task.moved',
        { task: task({ currentStageId: 'st-2' }), from: 'st-1', to: 'st-2' },
        1,
      ),
      fact(1, 'task.created', { task: task() }),
      fact(3, 'task.completed', { task: task({ status: 'completed' }) }, 1),
    ]

    expect(kinds(timeline(facts, 'task', 't-1'))).toEqual([
      '1:task.created',
      '2:task.moved',
      '3:task.completed',
    ])
    expect(kinds(timeline([...facts].reverse(), 'task', 't-1'))).toEqual([
      '1:task.created',
      '2:task.moved',
      '3:task.completed',
    ])
  })

  it('运行时间线：状态事实按 payload.run.id 命中，帧/审计/删除按 runId 命中', () => {
    const frames = [{ runId: 'run-1', seq: 1, type: 'text' as const, text: 'hi' }]
    const facts: Fact[] = [
      fact(1, 'run.queued', { run: run() }),
      fact(2, 'run.claimed', { run: run({ status: 'running', leaseId: 'run-1:1' }) }),
      fact(3, 'run.frames', { runId: 'run-1', turn: 1, frames }),
      fact(4, 'run.receipt_rejected', {
        runId: 'run-1',
        leaseId: 'run-1:0',
        turn: 1,
        reason: 'stale_lease',
      }),
      fact(5, 'run.removed', { runId: 'run-1' }),
      fact(6, 'run.queued', { run: run({ id: 'run-2' }) }),
    ]

    expect(kinds(timeline(facts, 'run', 'run-1'))).toEqual([
      '1:run.queued',
      '2:run.claimed',
      '3:run.frames',
      '4:run.receipt_rejected',
      '5:run.removed',
    ])
    expect(kinds(timeline(facts, 'run', 'run-2'))).toEqual(['6:run.queued'])
  })

  it('对话时间线：消息同时归到所属对话；消息自身范围只命中 message.appended', () => {
    const facts: Fact[] = [
      fact(1, 'conversation.created', { conversation: conversation() }),
      fact(2, 'message.appended', {
        conversationId: 'cv-1',
        messageId: 'ms-1',
        role: 'user',
        content: '你好',
      }),
      fact(3, 'conversation.updated', {
        conversation: conversation({ title: '改名' }),
      }),
      fact(4, 'message.appended', {
        conversationId: 'cv-2',
        messageId: 'ms-2',
        role: 'user',
        content: '别的对话',
      }),
    ]

    expect(kinds(timeline(facts, 'conversation', 'cv-1'))).toEqual([
      '1:conversation.created',
      '2:message.appended',
      '3:conversation.updated',
    ])
    expect(kinds(timeline(facts, 'message', 'ms-1'))).toEqual(['2:message.appended'])
    expect(kinds(timeline(facts, 'conversation', 'cv-2'))).toEqual(['4:message.appended'])
  })

  it('运行/对话四表导入根落到对应实体范围', () => {
    const facts: Fact[] = [
      imported(1, { table: 'runs', rows: [run()], importedFrom: 'v2' }),
      imported(2, {
        table: 'run_events',
        rows: [{ runId: 'run-1', seq: 1, type: 'text', text: 'hi' }],
        importedFrom: 'v2',
      }),
      imported(3, { table: 'conversations', rows: [conversation()], importedFrom: 'v2' }),
      imported(4, {
        table: 'messages',
        rows: [
          {
            id: 'ms-1',
            conversationId: 'cv-1',
            role: 'user',
            content: '你好',
            error: null,
            createdAt: AT,
          },
        ],
        importedFrom: 'v2',
      }),
    ]

    expect(kinds(timeline(facts, 'run', 'run-1'))).toEqual([
      '1:snapshot.imported',
      '2:snapshot.imported',
    ])
    expect(kinds(timeline(facts, 'conversation', 'cv-1'))).toEqual([
      '3:snapshot.imported',
      '4:snapshot.imported',
    ])
    expect(kinds(timeline(facts, 'message', 'ms-1'))).toEqual(['4:snapshot.imported'])
    expect(timeline(facts, 'run', 'run-404')).toEqual([])
  })

  it('卡片时间线：card.* 按 payload.card.id 命中，同时归到所属 run', () => {
    const facts: Fact[] = [
      fact(1, 'card.opened', { card: card() }),
      fact(2, 'card.answered', {
        card: card({ status: 'answered', optionIndex: 0, answeredBy: 'ui', answeredAt: AT }),
        by: 'ui',
      }),
      fact(3, 'event.received', {
        eventId: 'ev-1',
        source: 'agent',
        type: 'issues.opened',
        subject: 'issue-1',
        summary: '新 issue',
        detailRef: null,
        link: null,
        hops: 1,
        originRunId: 'run-1',
        dedupeKey: null,
      }),
    ]

    expect(kinds(timeline(facts, 'card', 'card-1'))).toEqual(['1:card.opened', '2:card.answered'])
    expect(kinds(timeline(facts, 'run', 'run-1'))).toEqual([
      '1:card.opened',
      '2:card.answered',
      '3:event.received',
    ])
    expect(timeline(facts, 'card', 'card-404')).toEqual([])
  })
})
