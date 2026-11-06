// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { KERNEL_VERSION } from '../../../src/kernel/types'
import type { Command } from '../../../src/protocol/commands'
import { projectionFormat } from '../../../src/host/schema'
import { createStore } from '../../../src/host/store/index'
import { createFakeKernel } from './fake-kernel'
import { readProjectionMeta, rebuildProjection } from '../../../src/host/store/projection'
import {
  SAMPLE_AT,
  countRows,
  createMemoryDb,
  dumpProjection,
  sample,
  sequenceIds,
} from './test-support'

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

const workflowCreate = (name: string, stages: number): Command => ({
  type: 'workflow.create',
  commandId: `create-${name}`,
  input: {
    name,
    stages: Array.from({ length: stages }, (_, index) => ({
      name: `阶段 ${index + 1}`,
      entryMode: 'none' as const,
    })),
  },
})

describe('ensureProjection', () => {
  it('空库：只写 { format, seq: 0 } 元信息，不视为重建', () => {
    const db = memory()
    const store = createStore({ db, kernel: createFakeKernel() })

    expect(store.ensureProjection()).toEqual({ rebuilt: false })
    expect(readProjectionMeta(db)).toEqual({ format: projectionFormat(KERNEL_VERSION), seq: 0 })
    expect(store.ensureProjection()).toEqual({ rebuilt: false })
    expect(countRows(db, 'runs')).toBe(0)
  })

  it('已是最新：不重建，投影数据不动', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1'),
    })
    store.dispatch(workflowCreate('流程', 1))
    const before = dumpProjection(db)

    expect(store.ensureProjection()).toEqual({ rebuilt: false })
    expect(dumpProjection(db)).toEqual(before)
  })

  it('format 失配：同一事务清表重建并写回新指纹', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })
    store.dispatch(workflowCreate('流程', 2))
    const before = dumpProjection(db)
    db.prepare("UPDATE projection_meta SET format = 'stale'").run()

    expect(store.ensureProjection()).toEqual({ rebuilt: true })

    expect(readProjectionMeta(db)).toEqual({ format: projectionFormat(KERNEL_VERSION), seq: 3 })
    expect(dumpProjection(db)).toEqual(before)
  })

  it('meta.seq 落后且投影被破坏：重建后从事实恢复', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })
    store.dispatch(workflowCreate('流程', 2))
    const before = dumpProjection(db)
    db.prepare('UPDATE projection_meta SET seq = 1').run()
    db.prepare('DELETE FROM workflow_stages').run()

    expect(store.ensureProjection()).toEqual({ rebuilt: true })

    expect(readProjectionMeta(db)).toEqual({ format: projectionFormat(KERNEL_VERSION), seq: 3 })
    expect(dumpProjection(db)).toEqual(before)
  })
})

describe('rebuild：增量应用与重建等价', () => {
  it('同一条事实序列，增量投影与 rebuild 逐表全等（含 tombstone 删除）', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-a', 'st-a1', 'st-a2', 'wf-b', 'st-b1', 'tk-1', 'tk-2'),
    })

    store.dispatch(workflowCreate('流程 A', 2))
    store.dispatch(workflowCreate('流程 B', 1))
    store.dispatch({
      type: 'task.create',
      commandId: 'task-1',
      input: { title: '任务一', workflowId: 'wf-a', stageId: 'st-a1' },
    })
    store.dispatch({ type: 'task.move', commandId: 'move-1', id: 'tk-1', stageId: 'st-a2' })
    store.dispatch({
      type: 'task.create',
      commandId: 'task-2',
      input: { title: '任务二', workflowId: 'wf-b' },
    })
    store.dispatch({ type: 'task.remove', commandId: 'remove-task', id: 'tk-2' })
    store.dispatch({ type: 'workflow.remove', commandId: 'remove-wf', id: 'wf-b' })

    const incremental = dumpProjection(db)
    expect(incremental.workflows).toHaveLength(1)
    expect(incremental.workflow_stages).toHaveLength(2)
    expect(incremental.tasks).toHaveLength(1)
    expect(store.factsCount()).toBe(11)
    expect(store.query('workflows.all')).toEqual([
      {
        id: 'wf-a',
        name: '流程 A',
        description: '',
        createdAt: SAMPLE_AT,
        stages: [
          {
            id: 'st-a1',
            workflowId: 'wf-a',
            name: '阶段 1',
            position: 0,
            entryMode: 'none',
            agentId: null,
            onCompleteStageId: null,
            onRejectStageId: null,
            handoffWorkflowId: null,
            handoffStageId: null,
            subtaskStageId: null,
            onChildrenSettled: null,
            spawnPolicy: null,
          },
          {
            id: 'st-a2',
            workflowId: 'wf-a',
            name: '阶段 2',
            position: 1,
            entryMode: 'none',
            agentId: null,
            onCompleteStageId: null,
            onRejectStageId: null,
            handoffWorkflowId: null,
            handoffStageId: null,
            subtaskStageId: null,
            onChildrenSettled: null,
            spawnPolicy: null,
          },
        ],
      },
    ])
    expect(store.query('tasks.byWorkflow', { workflowId: 'wf-a' })).toEqual([
      {
        id: 'tk-1',
        title: '任务一',
        description: '',
        workflowId: 'wf-a',
        currentStageId: 'st-a2',
        status: 'active',
        origin: 'manual',
        ruleId: null,
        externalRef: null,
        labels: [],
        threadId: null,
        parentTaskId: null,
        spawnedByRunId: null,
        batchNo: null,
        spawnKey: null,
        handoffFromTaskId: null,
        handoffFromStageId: null,
        createdAt: SAMPLE_AT,
        updatedAt: SAMPLE_AT,
      },
    ])

    store.rebuild()

    expect(dumpProjection(db)).toEqual(incremental)
    expect(store.factsCount()).toBe(11)
    expect(store.factsSince(0).at(-1)?.seq).toBe(11)
    expect(readProjectionMeta(db)).toEqual({ format: projectionFormat(KERNEL_VERSION), seq: 11 })

    // 再建一次幂等：同样的结果
    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
  })

  it('重建清空运行/聊天四表：没有事实支撑的行不会保留', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('rt-1', 'ag-1', 'wf-1', 'st-1', 'tk-1'),
    })
    store.dispatch({ type: 'runtime.create', commandId: 'rt', input: { name: '本机 dsh' } })
    store.dispatch({
      type: 'agent.create',
      commandId: 'ag',
      input: { name: '实现者', runtimeId: 'rt-1' },
    })
    store.dispatch(workflowCreate('流程', 1))
    store.dispatch({
      type: 'task.create',
      commandId: 'task',
      input: { title: '任务', workflowId: 'wf-1' },
    })

    // 旧写路径（T16 前仍存在）直接落库的运行/聊天行：重建后必须消失。
    db.prepare('INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)').run(
      'run-1',
      'tk-1',
      'running',
      SAMPLE_AT,
    )
    db.prepare('INSERT INTO run_events (run_id, seq, type, created_at) VALUES (?, ?, ?, ?)').run(
      'run-1',
      1,
      'status',
      SAMPLE_AT,
    )
    db.prepare(
      'INSERT INTO conversations (id, title, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('cv-1', '对话', 'ag-1', SAMPLE_AT, SAMPLE_AT)
    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('ms-1', 'cv-1', 'user', '你好', SAMPLE_AT)

    store.rebuild()

    expect(countRows(db, 'runs')).toBe(0)
    expect(countRows(db, 'run_events')).toBe(0)
    expect(countRows(db, 'conversations')).toBe(0)
    expect(countRows(db, 'messages')).toBe(0)
    // 实体五表由事实重建（不是残留的旧行）
    expect(store.query('runtimes.all')).toEqual([sample.runtime()])
    expect(store.query('agents.all')).toEqual([sample.agent()])
    expect(countRows(db, 'workflow_stages')).toBe(1)
  })

  it('重建后恢复外键开关', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'tk-1'),
    })
    store.dispatch(workflowCreate('流程', 1))
    store.dispatch({
      type: 'task.create',
      commandId: 'task',
      input: { title: '任务', workflowId: 'wf-1' },
    })

    store.rebuild()

    expect(
      (db.prepare('PRAGMA foreign_keys').get() as unknown as { foreign_keys: number }).foreign_keys,
    ).toBe(1)
    expect(() =>
      db
        .prepare('INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)')
        .run('run-2', 'tk-missing', 'queued', SAMPLE_AT),
    ).toThrow()
  })

  it('调用方已关外键：重建不强行打开（保持组合方的连接状态）', () => {
    const db = memory()
    const kernel = createFakeKernel()
    const store = createStore({
      db,
      kernel,
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'tk-1'),
    })
    store.dispatch(workflowCreate('流程', 1))
    store.dispatch({
      type: 'task.create',
      commandId: 'task',
      input: { title: '任务', workflowId: 'wf-1' },
    })

    // 组合方在调用重建前自己关了外键：重建不应把它的开关改回去
    db.exec('PRAGMA foreign_keys = OFF')
    rebuildProjection(db, kernel)

    expect(
      (db.prepare('PRAGMA foreign_keys').get() as unknown as { foreign_keys: number }).foreign_keys,
    ).toBe(0)
    expect(countRows(db, 'workflow_stages')).toBe(1)
    expect(countRows(db, 'tasks')).toBe(1)
  })
})
