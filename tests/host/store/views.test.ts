// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Runtime } from '../../../src/protocol/entities'
import type { ViewId } from '../../../src/protocol/views'
import type { Change } from '../../../src/kernel/types'
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
