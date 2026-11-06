import { describe, expect, it } from 'vitest'
import type { RunRow, Task } from '../../src/protocol/entities'
import { THREAD_LIMITS, type ThreadEventRef, type ThreadRow } from '../../src/protocol/thread'
import type { Environment, Limits, View } from '../../src/kernel/types'
import {
  activeTasksOfThread,
  closeIfAllDone,
  eventRefOf,
  findThreadByKey,
  inactivityFacts,
  makeNote,
  openThreadRow,
  queuedRunOfTask,
  runCountOfTask,
  tasksOfThread,
  threadSessions,
  threadTitle,
  withBinding,
  withEvent,
  withNote,
  withStatus,
  withTask,
} from '../../src/kernel/threads'

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
  const counters = new Map<string, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
  }
}

const eventPayload = (over: Partial<Parameters<typeof eventRefOf>[0]> = {}) => ({
  eventId: 'event-1',
  source: 'github',
  type: 'issues.opened',
  subject: 'issue-1',
  summary: '新 Issue',
  detailRef: '/tmp/a.md',
  link: null,
  hops: 1,
  originRunId: null,
  dedupeKey: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: 'th-1',
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
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
  threadId: 'th-1',
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
  status: 'succeeded',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: 'sess-1',
  usage: null,
  durationMs: 1,
  leaseId: null,
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  startedAt: CREATED,
  endedAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const emptyView = (over: Partial<View> = {}): View => ({
  seq: 1,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
  ...over,
})

describe('kernel/threads 行原语', () => {
  it('openThreadRow：source/externalRef/title/空清单，默认并发 1', () => {
    const thread = openThreadRow(env(), {
      source: 'github',
      externalRef: 'issue-1',
      title: 'issue-1',
      now: NOW,
    })
    expect(thread).toMatchObject({
      id: 'thread-1',
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
      lastActivityAt: NOW,
      createdAt: NOW,
    })
  })

  it('空 title 回落到 source；超长截断', () => {
    const thread = openThreadRow(env(), {
      source: 'mail',
      externalRef: null,
      title: '  ',
      now: NOW,
    })
    expect(thread.title).toBe('mail')
    const long = openThreadRow(env(), {
      source: 'mail',
      externalRef: null,
      title: 'x'.repeat(300),
      now: NOW,
    })
    expect(long.title).toHaveLength(THREAD_LIMITS.title)
  })

  it('findThreadByKey：只匹配非空 externalRef', () => {
    const thread = openThreadRow(env(), {
      source: 'github',
      externalRef: 'issue-1',
      title: 't',
      now: NOW,
    })
    const view = emptyView({ threads: new Map([[thread.id, thread]]) })
    expect(findThreadByKey(view, 'github', 'issue-1')?.id).toBe(thread.id)
    expect(findThreadByKey(view, 'github', 'issue-2')).toBeUndefined()
    expect(findThreadByKey(view, 'mail', 'issue-1')).toBeUndefined()
    expect(findThreadByKey(view, 'github', null)).toBeUndefined()
  })

  it('withEvent：同 eventId 只记一次；保最新 50 条；重开状态与活动时间推进', () => {
    let thread = openThreadRow(env(), {
      source: 'github',
      externalRef: 'issue-1',
      title: 't',
      now: CREATED,
    })
    thread = withStatus(thread, 'closed', CREATED)
    thread = withEvent(thread, eventPayload(), NOW)
    expect(thread.status).toBe('open')
    expect(thread.events).toHaveLength(1)
    expect(thread.lastActivityAt).toBe(NOW)
    expect(thread.events[0]).toMatchObject({ eventId: 'event-1', detailRef: '/tmp/a.md' })
    const same = withEvent(thread, eventPayload(), NOW)
    expect(same.events).toHaveLength(1)
    for (let index = 0; index < 60; index += 1) {
      thread = withEvent(thread, eventPayload({ eventId: `event-${index}` }), NOW)
    }
    expect(thread.events).toHaveLength(THREAD_LIMITS.events)
    expect(thread.events.at(-1)?.eventId).toBe('event-59')
  })

  it('withTask：taskIds 追加、根任务只收无父任务；withNote 计数与上限', () => {
    const base = openThreadRow(env(), { source: 'manual', externalRef: null, title: 't', now: NOW })
    const root = withTask(base, task(), NOW)
    expect(root.taskIds).toEqual(['task-1'])
    expect(root.rootTaskIds).toEqual(['task-1'])
    const child = withTask(root, task({ id: 'task-2', parentTaskId: 'task-1' }), NOW)
    expect(child.taskIds).toEqual(['task-1', 'task-2'])
    expect(child.rootTaskIds).toEqual(['task-1'])

    let noted = child
    for (let index = 0; index < 55; index += 1) {
      const note = makeNote(env(), 'owner', `笔记 ${index}`, NOW)
      noted = withNote(noted, note, NOW)
    }
    expect(noted.notes).toHaveLength(THREAD_LIMITS.notes)
    expect(noted.notesVersion).toBe(55)
    expect(noted.notes.at(-1)?.text).toBe('笔记 54')
  })

  it('withBinding：只改 source/externalRef 与活动时间', () => {
    const base = openThreadRow(env(), { source: 'manual', externalRef: null, title: 't', now: NOW })
    const bound = withBinding(base, 'github', 'issue-9', NOW)
    expect(bound).toMatchObject({ source: 'github', externalRef: 'issue-9', lastActivityAt: NOW })
  })
})

describe('kernel/threads 兜底分支', () => {
  it('threadTitle：subject/summary 都空回落 source，超长截断', () => {
    expect(threadTitle('mail', { subject: '  ', summary: '  ' })).toBe('mail')
    expect(threadTitle('github', { subject: 'issue-1', summary: '摘要' })).toBe('issue-1')
    expect(threadTitle('github', { subject: '', summary: '只有摘要' })).toBe('只有摘要')
    expect(threadTitle('github', { subject: 'x'.repeat(300), summary: '' })).toHaveLength(
      THREAD_LIMITS.title,
    )
  })

  it('withTask 同一任务重复挂载不重复入列', () => {
    const base = openThreadRow(env(), { source: 'm', externalRef: null, title: 't', now: NOW })
    const once = withTask(base, task(), NOW)
    const twice = withTask(once, task(), NOW)
    expect(twice.taskIds).toEqual(['task-1'])
    expect(twice.rootTaskIds).toEqual(['task-1'])
  })

  it('queuedRunOfTask 同 queueSeq 按 id 稳定排序', () => {
    const runs = [
      run({ id: 'run-b', status: 'queued', queueSeq: 5 }),
      run({ id: 'run-a', status: 'queued', queueSeq: 5 }),
    ]
    const view = emptyView({ runs: new Map(runs.map((row) => [row.id, row])) })
    expect(queuedRunOfTask(view, 'task-1')?.id).toBe('run-a')
  })

  it('threadSessions：agentId 缺失 / 非终态的 run 不参与', () => {
    const runs = [
      run({ id: 'run-no-agent', agentId: null }),
      run({ id: 'run-waiting', status: 'waiting', leaseId: null }),
      run({ id: 'run-ok', sessionId: 'sess-ok' }),
    ]
    const view = emptyView({ runs: new Map(runs.map((row) => [row.id, row])) })
    expect(threadSessions(view, 'th-1')).toEqual({ 'ag-1': 'sess-ok' })
  })
})

describe('kernel/threads 读视图', () => {
  it('tasksOfThread / activeTasksOfThread 跳过已删任务', () => {
    const thread = openThreadRow(env(), { source: 'm', externalRef: null, title: 't', now: NOW })
    const rows = new Map([
      ['task-1', task({ id: 'task-1' })],
      ['task-2', task({ id: 'task-2', status: 'completed' })],
      ['task-3', task({ id: 'task-3' })],
    ])
    const withIds = withTask(
      withTask(thread, rows.get('task-1') as Task, NOW),
      rows.get('task-2') as Task,
      NOW,
    )
    const view = emptyView({ tasks: rows, threads: new Map([[withIds.id, withIds]]) })
    expect(tasksOfThread(view, withIds).map((row) => row.id)).toEqual(['task-1', 'task-2'])
    expect(activeTasksOfThread(view, withIds).map((row) => row.id)).toEqual(['task-1'])
  })

  it('threadSessions：每个 agent 取最近一次终态 run 的 sessionId，首轮 / 非终态不计', () => {
    const runs = [
      run({ id: 'run-1', endedAt: '2026-11-01T00:00:00.000Z', sessionId: 'sess-1' }),
      run({ id: 'run-2', endedAt: '2026-11-02T00:00:00.000Z', sessionId: 'sess-2' }),
      run({
        id: 'run-3',
        agentId: 'ag-2',
        endedAt: '2026-11-02T00:00:00.000Z',
        sessionId: 'sess-b',
      }),
      run({ id: 'run-4', status: 'running', sessionId: 'sess-live', endedAt: null }),
      run({ id: 'run-5', agentId: 'ag-3', sessionId: null }),
      run({ id: 'run-6', threadId: 'th-2', sessionId: 'sess-other' }),
    ]
    const view = emptyView({ runs: new Map(runs.map((row) => [row.id, row])) })
    expect(threadSessions(view, 'th-1')).toEqual({ 'ag-1': 'sess-2', 'ag-2': 'sess-b' })
  })

  it('threadSessions：终态 run 缺 endedAt 时按 createdAt 兜底，与插入顺序无关', () => {
    // 历史 / 脏投影里终态 run 可能没有 endedAt：取 `createdAt` 参与排序，
    // 后写覆盖先写，因此两种插入顺序都必须落到同一条最新会话。
    const ended = run({ id: 'run-new', endedAt: '2026-11-02T00:00:00.000Z', sessionId: 'sess-new' })
    const noEnd = run({
      id: 'run-old',
      endedAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      sessionId: 'sess-old',
    })

    const endedFirst = emptyView({
      runs: new Map([
        [ended.id, ended],
        [noEnd.id, noEnd],
      ]),
    })
    expect(threadSessions(endedFirst, 'th-1')).toEqual({ 'ag-1': 'sess-new' })

    const noEndFirst = emptyView({
      runs: new Map([
        [noEnd.id, noEnd],
        [ended.id, ended],
      ]),
    })
    expect(threadSessions(noEndFirst, 'th-1')).toEqual({ 'ag-1': 'sess-new' })
  })

  it('runCountOfTask / queuedRunOfTask', () => {
    const runs = [
      run({ id: 'run-1', status: 'succeeded' }),
      run({ id: 'run-2', status: 'queued', queueSeq: 9 }),
      run({ id: 'run-3', status: 'queued', queueSeq: 3 }),
      run({ id: 'run-4', taskId: null }),
    ]
    const view = emptyView({ runs: new Map(runs.map((row) => [row.id, row])) })
    expect(runCountOfTask(view, 'task-1')).toBe(3)
    expect(queuedRunOfTask(view, 'task-1')?.id).toBe('run-3')
    expect(queuedRunOfTask(view, 'task-9')).toBeUndefined()
  })
})

describe('kernel/threads 生命周期', () => {
  it('closeIfAllDone：有 active 任务不关闭；全完成 / 已删 / overrides 完成时关闭', () => {
    const thread = openThreadRow(env(), { source: 'm', externalRef: null, title: 't', now: NOW })
    const withTwo = withTask(
      withTask(thread, task({ id: 'task-1' }), NOW),
      task({ id: 'task-2' }),
      NOW,
    )
    const view = emptyView({
      tasks: new Map([
        ['task-1', task({ id: 'task-1' })],
        ['task-2', task({ id: 'task-2' })],
      ]),
      threads: new Map([[withTwo.id, withTwo]]),
    })
    expect(closeIfAllDone(view, withTwo, NOW, { kind: 'kernel' })).toEqual([])
    expect(
      closeIfAllDone(view, withTwo, NOW, { kind: 'kernel' }, new Map([['task-1', 'completed']])),
    ).toEqual([])
    const facts = closeIfAllDone(
      view,
      withTwo,
      NOW,
      { kind: 'kernel' },
      new Map([
        ['task-1', 'completed'],
        ['task-2', 'completed'],
      ]),
    )
    expect(facts.map((fact) => fact.type)).toEqual(['thread.closed'])
    const closed = (facts[0]?.payload as { thread: ThreadRow }).thread
    expect(closed.status).toBe('closed')
    expect(facts[0]?.payload).toMatchObject({ reason: 'all-tasks-done' })
    // 已关闭幂等
    const closedView = emptyView({ threads: new Map([[closed.id, closed]]) })
    expect(closeIfAllDone(closedView, closed, NOW, { kind: 'kernel' })).toEqual([])
  })

  it('inactivityFacts：14 天无活动的 open 线程归档，未到期与已关闭不动', () => {
    const base = openThreadRow(env(), { source: 'm', externalRef: null, title: 't', now: CREATED })
    const stale = { ...base, id: 'th-stale', lastActivityAt: '2026-10-01T00:00:00.000Z' }
    const fresh = { ...base, id: 'th-fresh', lastActivityAt: '2026-11-04T00:00:00.000Z' }
    const closed = { ...base, id: 'th-closed', status: 'closed' as const }
    const view = emptyView({
      threads: new Map([
        [stale.id, stale],
        [fresh.id, fresh],
        [closed.id, closed],
      ]),
    })
    const facts = inactivityFacts(view, NOW, { kind: 'host', via: 'timer' })
    expect(facts.map((fact) => (fact.payload as { thread: ThreadRow }).thread.id)).toEqual([
      'th-stale',
    ])
    expect(facts[0]?.payload).toMatchObject({ reason: 'inactivity' })
  })
})

describe('kernel/threads 事件引用', () => {
  it('eventRefOf：摘要截断 200、资料指针保留', () => {
    const ref: ThreadEventRef = eventRefOf(eventPayload({ summary: 'x'.repeat(300) }), NOW)
    expect(ref).toMatchObject({ eventId: 'event-1', type: 'issues.opened', at: NOW })
    expect(ref.summary).toHaveLength(200)
    expect(ref.detailRef).toBe('/tmp/a.md')
  })
})
