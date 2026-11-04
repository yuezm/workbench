// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Change } from '../../kernel/types'
import { withTx } from '../schema'
import { StoreError } from './errors'
import { createProjectionWriter } from './projection-apply'
import {
  SAMPLE_AT,
  captureError,
  countRows,
  createMemoryDb,
  sample,
  sampleProbe,
} from './test-support'

const LATER_AT = '2026-01-02T00:00:00.000Z'

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

describe('createProjectionWriter：显式行映射', () => {
  it('五表 upsert 逐列写入（含 last_probe_json / enabled / 阶段 created_at）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const runtime = sample.runtime({
      enabled: false,
      model: 'dsh/模型',
      reasoningEffort: 'high',
      workdir: 'D:\\Codes\\workbench',
      lastProbe: sampleProbe,
    })
    const agent = sample.agent()
    const workflow = sample.workflow()
    const stage = sample.stage()
    const task = sample.task({ status: 'completed' })

    const changes: Change[] = [
      { table: 'runtimes', key: runtime.id, row: runtime },
      { table: 'agents', key: agent.id, row: agent },
      { table: 'workflows', key: workflow.id, row: workflow },
      { table: 'workflow_stages', key: stage.id, row: stage },
      { table: 'tasks', key: task.id, row: task },
    ]
    for (const change of changes) writer.apply(change, SAMPLE_AT)

    expect(
      db
        .prepare(
          `SELECT id, name, protocol_family, command, profile, permission_mode, model,
                  reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at
           FROM runtimes`,
        )
        .get(),
    ).toEqual({
      id: 'rt-1',
      name: '本机 dsh',
      protocol_family: 'dsh',
      command: 'dsh',
      profile: 'multica',
      permission_mode: 'workspace-write',
      model: 'dsh/模型',
      reasoning_effort: 'high',
      workdir: 'D:\\Codes\\workbench',
      max_concurrent: 1,
      enabled: 0,
      last_probe_json: JSON.stringify(sampleProbe),
      created_at: SAMPLE_AT,
    })
    expect(
      db
        .prepare('SELECT id, name, description, runtime_id, system_prompt, created_at FROM agents')
        .get(),
    ).toEqual({
      id: 'ag-1',
      name: '实现者',
      description: '',
      runtime_id: 'rt-1',
      system_prompt: '',
      created_at: SAMPLE_AT,
    })
    expect(db.prepare('SELECT id, name, description, created_at FROM workflows').get()).toEqual({
      id: 'wf-1',
      name: '默认流程',
      description: '',
      created_at: SAMPLE_AT,
    })
    expect(
      db
        .prepare(
          `SELECT id, workflow_id, name, position, entry_mode, agent_id,
                  on_complete_stage_id, on_reject_stage_id, created_at
           FROM workflow_stages`,
        )
        .get(),
    ).toEqual({
      id: 'st-1',
      workflow_id: 'wf-1',
      name: '待办',
      position: 0,
      entry_mode: 'none',
      agent_id: null,
      on_complete_stage_id: null,
      on_reject_stage_id: null,
      created_at: SAMPLE_AT,
    })
    expect(
      db
        .prepare(
          `SELECT id, title, description, workflow_id, current_stage_id, status, created_at, updated_at
           FROM tasks`,
        )
        .get(),
    ).toEqual({
      id: 'tk-1',
      title: '任务',
      description: '',
      workflow_id: 'wf-1',
      current_stage_id: 'st-1',
      status: 'completed',
      created_at: SAMPLE_AT,
      updated_at: SAMPLE_AT,
    })
  })

  it('upsert 更新已有行；阶段更新保留首次 created_at', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, SAMPLE_AT)

    writer.apply(
      {
        table: 'workflow_stages',
        key: 'st-1',
        row: sample.stage({ name: '处理中', position: 1, entryMode: 'agent', agentId: null }),
      },
      LATER_AT,
    )

    expect(
      db.prepare('SELECT name, position, entry_mode, created_at FROM workflow_stages').get(),
    ).toEqual({ name: '处理中', position: 1, entry_mode: 'agent', created_at: SAMPLE_AT })
    expect(countRows(db, 'workflow_stages')).toBe(1)
  })

  it('同一批次交换 position：先腾位后写入，唯一约束不冲突', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, SAMPLE_AT)
    writer.apply(
      { table: 'workflow_stages', key: 'st-2', row: sample.stage({ id: 'st-2', position: 1 }) },
      SAMPLE_AT,
    )

    writer.applyAll([
      {
        change: {
          table: 'workflow_stages',
          key: 'st-2',
          row: sample.stage({ id: 'st-2', position: 0 }),
        },
        at: SAMPLE_AT,
      },
      {
        change: {
          table: 'workflow_stages',
          key: 'st-1',
          row: sample.stage({ id: 'st-1', position: 1 }),
        },
        at: SAMPLE_AT,
      },
    ])

    expect(db.prepare('SELECT id, position FROM workflow_stages ORDER BY position').all()).toEqual([
      { id: 'st-2', position: 0 },
      { id: 'st-1', position: 1 },
    ])
  })

  it('事实自相矛盾（两阶段最终占同一 position）：批末还原撞唯一约束并回滚', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, SAMPLE_AT)
    writer.apply(
      { table: 'workflow_stages', key: 'st-2', row: sample.stage({ id: 'st-2', position: 1 }) },
      SAMPLE_AT,
    )

    expect(() =>
      withTx(db, () =>
        writer.applyAll([
          {
            change: {
              table: 'workflow_stages',
              key: 'st-2',
              row: sample.stage({ id: 'st-2', position: 0 }),
            },
            at: SAMPLE_AT,
          },
        ]),
      ),
    ).toThrow()
    expect(db.prepare('SELECT id, position FROM workflow_stages ORDER BY id').all()).toEqual([
      { id: 'st-1', position: 0 },
      { id: 'st-2', position: 1 },
    ])
  })

  it('row = null 删除对应行（其它行不受影响）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, SAMPLE_AT)
    const keep = sample.task({ id: 'tk-keep' })
    const remove = sample.task({ id: 'tk-remove' })
    writer.apply({ table: 'tasks', key: keep.id, row: keep }, SAMPLE_AT)
    writer.apply({ table: 'tasks', key: remove.id, row: remove }, SAMPLE_AT)

    writer.apply({ table: 'tasks', key: remove.id, row: null }, LATER_AT)

    expect(db.prepare('SELECT id FROM tasks').all()).toEqual([{ id: 'tk-keep' }])
  })

  it('未知投影表：抛 StoreError(invalid_input)，删除路径同样拦下', () => {
    const db = memory()
    const writer = createProjectionWriter(db)

    const unknownTable = captureError(() =>
      writer.apply({ table: 'rules', key: 'x', row: null } as unknown as Change, SAMPLE_AT),
    )
    expect(unknownTable).toBeInstanceOf(StoreError)
    expect((unknownTable as StoreError).code).toBe('invalid_input')
    expect((unknownTable as StoreError).message).toContain('rules')

    const unknownRow = captureError(() =>
      writer.apply(
        { table: 'cards', key: 'x', row: sample.task() } as unknown as Change,
        SAMPLE_AT,
      ),
    )
    expect((unknownRow as StoreError).code).toBe('invalid_input')
  })

  it('clear 只清五张投影表，运行记录原样保留（重建事务关外键）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const runtime = sample.runtime()
    const agent = sample.agent()
    const workflow = sample.workflow()
    const stage = sample.stage()
    const task = sample.task()
    for (const change of [
      { table: 'runtimes', key: runtime.id, row: runtime },
      { table: 'agents', key: agent.id, row: agent },
      { table: 'workflows', key: workflow.id, row: workflow },
      { table: 'workflow_stages', key: stage.id, row: stage },
      { table: 'tasks', key: task.id, row: task },
    ] as Change[]) {
      writer.apply(change, SAMPLE_AT)
    }
    db.prepare('INSERT INTO runs (id, task_id, status, created_at) VALUES (?, ?, ?, ?)').run(
      'run-1',
      'tk-1',
      'running',
      SAMPLE_AT,
    )

    db.exec('PRAGMA foreign_keys = OFF')
    try {
      writer.clear()
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }

    for (const table of ['tasks', 'workflows', 'workflow_stages', 'agents', 'runtimes']) {
      expect(countRows(db, table)).toBe(0)
    }
    expect(countRows(db, 'runs')).toBe(1)
  })
})
