// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Runtime } from '../../../src/protocol/entities'
import type { ViewId } from '../../../src/protocol/views'
import type { Change } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import { StoreError } from '../../../src/host/store/errors'
import { createProjectionWriter } from '../../../src/host/store/projection-apply'
import { loadView, queryView } from '../../../src/host/store/views'
import { SAMPLE_AT, captureError, createMemoryDb, sample, sampleProbe } from './test-support'

const OLDER_AT = '2025-12-01T00:00:00.000Z'

const runtimeNew = sample.runtime({
  id: 'rt-1',
  name: '较新运行时',
  createdAt: SAMPLE_AT,
  lastProbe: sampleProbe,
})
const runtimeOld = sample.runtime({
  id: 'rt-2',
  name: '较早运行时',
  createdAt: OLDER_AT,
  lastProbe: null,
})
const agent = sample.agent({ createdAt: OLDER_AT })
const workflowOld = sample.workflow({ id: 'wf-2', name: '流程二', createdAt: OLDER_AT })
const workflowNew = sample.workflow({ id: 'wf-1', name: '流程一', createdAt: SAMPLE_AT })
const stageFirst = sample.stage({ id: 'st-1', workflowId: 'wf-1', name: '第一步', position: 0 })
const stageSecond = sample.stage({ id: 'st-2', workflowId: 'wf-1', name: '第二步', position: 1 })
const taskOld = sample.task({
  id: 'tk-1',
  title: '任务一',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  createdAt: OLDER_AT,
})
const taskNew = sample.task({
  id: 'tk-2',
  title: '任务二',
  workflowId: 'wf-1',
  currentStageId: 'st-2',
  createdAt: SAMPLE_AT,
})
const taskOther = sample.task({
  id: 'tk-3',
  title: '别的工作流任务',
  workflowId: 'wf-2',
  currentStageId: null,
  createdAt: SAMPLE_AT,
})

// ---------- runs / conversations / messages 样例行 ----------

const runQueued = sample.run({
  id: 'run-queued',
  taskId: 'tk-1',
  stageId: 'st-1',
  queueSeq: 1,
  createdAt: OLDER_AT,
})
const runRunning = sample.run({
  id: 'run-running',
  taskId: 'tk-1',
  stageId: 'st-1',
  status: 'running',
  queueSeq: 2,
  attempt: 1,
  leaseId: 'run-running:1',
  leaseUntil: '2026-01-01T00:02:00.000Z',
  deadlineAt: '2026-01-01T00:30:00.000Z',
  startedAt: SAMPLE_AT,
})
const runWaiting = sample.run({
  id: 'run-waiting',
  taskId: 'tk-2',
  stageId: 'st-2',
  status: 'waiting',
  queueSeq: 3,
  attempt: 1,
  cancelRequested: true,
})
/** 聊天 run 不挂任务；这里故意给它 task_id，验证查询显式按 purpose 过滤（schema 不禁止该组合）。 */
const runChatOnTask = sample.run({
  id: 'run-chat-on-task',
  purpose: 'chat',
  taskId: 'tk-1',
  stageId: null,
  queueSeq: 4,
})
const runChat = sample.run({
  id: 'run-chat',
  purpose: 'chat',
  taskId: null,
  stageId: null,
  conversationId: 'cv-1',
  queueSeq: 5,
})
const runDone = sample.run({
  id: 'run-done',
  taskId: 'tk-2',
  stageId: 'st-2',
  status: 'succeeded',
  queueSeq: 6,
  eventIds: ['ev-1'],
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  endedAt: SAMPLE_AT,
})
const conversation = sample.conversation({ id: 'cv-1', title: '排查问题' })
const message = sample.message({ id: 'ms-1', conversationId: 'cv-1', content: '你好' })

let openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

/** 用投影 writer 种数据：与真实写入路径同一套行映射。 */
function seed(db: DatabaseSync): void {
  const writer = createProjectionWriter(db)
  const changes: Change[] = [
    { table: 'runtimes', key: runtimeOld.id, row: runtimeOld },
    { table: 'runtimes', key: runtimeNew.id, row: runtimeNew },
    { table: 'workflows', key: workflowOld.id, row: workflowOld },
    { table: 'workflows', key: workflowNew.id, row: workflowNew },
    { table: 'agents', key: agent.id, row: agent },
    { table: 'workflow_stages', key: stageSecond.id, row: stageSecond },
    { table: 'workflow_stages', key: stageFirst.id, row: stageFirst },
    { table: 'tasks', key: taskNew.id, row: taskNew },
    { table: 'tasks', key: taskOld.id, row: taskOld },
    { table: 'tasks', key: taskOther.id, row: taskOther },
  ]
  for (const change of changes) writer.apply(change, SAMPLE_AT)
}

function seedRuns(db: DatabaseSync): void {
  db.prepare(
    'INSERT INTO runs (id, task_id, stage_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('run-queued', 'tk-1', 'st-1', 'queued', OLDER_AT)
  db.prepare(
    'INSERT INTO runs (id, task_id, stage_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('run-running', 'tk-1', 'st-1', 'running', SAMPLE_AT)
  db.prepare(
    'INSERT INTO runs (id, task_id, stage_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('run-done', 'tk-2', 'st-2', 'succeeded', SAMPLE_AT)
}

/** 走投影 writer 种 run / chat 行：与真实写入路径同一套列映射（JSON 列、布尔列都过一遍）。 */
function seedRunProjection(db: DatabaseSync): void {
  const writer = createProjectionWriter(db)
  const changes: Change[] = [
    { table: 'runs', key: runQueued.id, row: runQueued },
    { table: 'runs', key: runRunning.id, row: runRunning },
    { table: 'runs', key: runWaiting.id, row: runWaiting },
    { table: 'runs', key: runChatOnTask.id, row: runChatOnTask },
    { table: 'runs', key: runChat.id, row: runChat },
    { table: 'runs', key: runDone.id, row: runDone },
    { table: 'conversations', key: conversation.id, row: conversation },
    { table: 'messages', key: message.id, row: message },
  ]
  for (const change of changes) writer.apply(change, SAMPLE_AT)
}

describe('loadView：按 viewSpec 装载切片', () => {
  it('只查声明的表，其余为空 Map', () => {
    const db = memory()
    seed(db)

    const view = loadView(db, ['runtimes', 'agents'])

    expect([...view.runtimes.keys()]).toEqual(['rt-2', 'rt-1'])
    expect([...view.agents.keys()]).toEqual(['ag-1'])
    expect(view.workflows.size).toBe(0)
    expect(view.stages.size).toBe(0)
    expect(view.tasks.size).toBe(0)
    expect(view.activeTaskIds.size).toBe(0)
    expect(view.seq).toBe(0)
  })

  it('全量装载：行映射为协议实体，活跃任务集合来自 runs', () => {
    const db = memory()
    seed(db)
    seedRuns(db)

    const view = loadView(db, ['tasks', 'workflows', 'workflow_stages', 'agents', 'runtimes'])

    expect(view.tasks.get('tk-1')).toEqual(taskOld)
    expect(view.tasks.get('tk-2')).toEqual(taskNew)
    expect(view.workflows.get('wf-1')).toEqual(workflowNew)
    expect(view.stages.get('st-1')).toEqual(stageFirst)
    expect(view.agents.get('ag-1')).toEqual(agent)
    expect(view.runtimes.get('rt-1')).toEqual(runtimeNew)
    expect([...view.activeTaskIds]).toEqual(['tk-1'])
  })

  it('view.seq 取事实日志当前最大 seq', () => {
    const db = memory()
    seed(db)
    db.prepare('INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)').run(
      'runtime.created',
      JSON.stringify({ kind: 'owner', via: 'ui' }),
      SAMPLE_AT,
      '{}',
    )

    expect(loadView(db, []).seq).toBe(1)
  })

  it('runs 切片：整行映射为 RunRow（JSON 列与布尔列还原）', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const view = loadView(db, ['runs'])

    expect([...view.runs.keys()]).toEqual([
      'run-queued',
      'run-running',
      'run-waiting',
      'run-chat-on-task',
      'run-chat',
      'run-done',
    ])
    expect(view.runs.get('run-running')).toEqual(runRunning)
    expect(view.runs.get('run-waiting')).toEqual(runWaiting)
    // usage / eventIds / cancelRequested 走 JSON 与 0/1 列，逐字段还原
    expect(view.runs.get('run-done')).toEqual(runDone)
    expect(view.conversations.size).toBe(0)
    expect(view.messages.size).toBe(0)
  })

  it('conversations / messages 切片：行映射为协议实体', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const view = loadView(db, ['conversations', 'messages'])

    expect(view.conversations.get('cv-1')).toEqual(conversation)
    expect(view.messages.get('ms-1')).toEqual(message)
    expect(view.runs.size).toBe(0)
  })

  it('activeTaskIds：queued/running/waiting 且只算 purpose=stage', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    // tk-1: queued + running；tk-2: waiting；聊天 run 与 succeeded 不计
    expect(loadView(db, ['runs']).activeTaskIds).toEqual(new Set(['tk-1', 'tk-2']))
  })

  it('activeTaskIds 不随切片裁剪：未声明 runs 也装载', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const view = loadView(db, [])

    expect(view.runs.size).toBe(0)
    expect(view.activeTaskIds).toEqual(new Set(['tk-1', 'tk-2']))
  })

  it('viewSpec 裁剪：run.claim 只装 runs + runtimes，conversation.send 装 chat 相关切片', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const claimView = loadView(db, viewSpec({ type: 'run.claim', runtimeId: 'rt-1', capacity: 1 }))
    expect(claimView.runs.size).toBe(6)
    expect(claimView.runtimes.size).toBe(2)
    expect(claimView.tasks.size).toBe(0)
    expect(claimView.agents.size).toBe(0)
    expect(claimView.conversations.size).toBe(0)
    expect(claimView.messages.size).toBe(0)

    const chatView = loadView(
      db,
      viewSpec({ type: 'conversation.send', conversationId: 'cv-1', content: '你好' }),
    )
    expect(chatView.conversations.size).toBe(1)
    expect(chatView.messages.size).toBe(1)
    expect(chatView.runs.size).toBe(6)
    expect(chatView.agents.size).toBe(1)
    expect(chatView.runtimes.size).toBe(2)
    expect(chatView.tasks.size).toBe(0)
  })
})

describe('queryView：各视图', () => {
  it('workflows.all：按创建时间排序，阶段按 position 排序', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'workflows.all')).toEqual([
      { ...workflowOld, stages: [] },
      { ...workflowNew, stages: [stageFirst, stageSecond] },
    ])
  })

  it('agents.all / runtimes.all：按创建时间排序并映射 lastProbe', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'agents.all')).toEqual([agent])
    expect(queryView(db, 'runtimes.all')).toEqual([runtimeOld, runtimeNew])
    const runtimes = queryView(db, 'runtimes.all') as Runtime[]
    expect(runtimes[0]?.lastProbe).toBeNull()
    expect(runtimes[1]?.lastProbe).toEqual(sampleProbe)
  })

  it('tasks.byWorkflow：只取该工作流，按创建时间排序', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-1' })).toEqual([taskOld, taskNew])
    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-2' })).toEqual([taskOther])
    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-missing' })).toEqual([])
  })

  it('task.byId：命中返回行，未命中返回 null', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'task.byId', { taskId: 'tk-2' })).toEqual(taskNew)
    expect(queryView(db, 'task.byId', { taskId: 'tk-missing' })).toBeNull()
  })

  it('runs.active-by-task：只取 queued / running，按创建时间排序', () => {
    const db = memory()
    seed(db)
    seedRuns(db)

    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-1' })).toEqual([
      { id: 'run-queued', taskId: 'tk-1', stageId: 'st-1', status: 'queued' },
      { id: 'run-running', taskId: 'tk-1', stageId: 'st-1', status: 'running' },
    ])
    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-2' })).toEqual([])
  })

  it('runs.active-by-task：纳入 waiting，并按 purpose 过滤聊天 run', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-1' })).toEqual([
      { id: 'run-queued', taskId: 'tk-1', stageId: 'st-1', status: 'queued' },
      { id: 'run-running', taskId: 'tk-1', stageId: 'st-1', status: 'running' },
    ])
    // tk-2 的 succeeded run 不算活跃；waiting 算
    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-2' })).toEqual([
      { id: 'run-waiting', taskId: 'tk-2', stageId: 'st-2', status: 'waiting' },
    ])
  })

  it('空库：各视图返回空集合 / null', () => {
    const db = memory()

    expect(queryView(db, 'workflows.all')).toEqual([])
    expect(queryView(db, 'agents.all')).toEqual([])
    expect(queryView(db, 'runtimes.all')).toEqual([])
    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-1' })).toEqual([])
    expect(queryView(db, 'task.byId', { taskId: 'tk-1' })).toBeNull()
    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-1' })).toEqual([])
  })

  it('未知视图与非法参数：StoreError(invalid_input)', () => {
    const db = memory()
    seed(db)

    const unknownView = captureError(() => queryView(db, 'threads.open' as ViewId))
    expect(unknownView).toBeInstanceOf(StoreError)
    expect((unknownView as StoreError).code).toBe('invalid_input')
    expect((unknownView as StoreError).message).toContain('threads.open')

    for (const params of [
      undefined,
      null,
      42,
      {},
      { workflowId: '' },
      { workflowId: 7 },
      { taskId: '' },
    ]) {
      const error = captureError(() => queryView(db, 'tasks.byWorkflow', params))
      expect((error as StoreError).code).toBe('invalid_input')
    }
    const taskParamError = captureError(() => queryView(db, 'task.byId', { taskId: 1 }))
    expect((taskParamError as StoreError).code).toBe('invalid_input')
  })
})
