// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Change } from '../../../src/kernel/types'
import type { RunRow } from '../../../src/protocol/entities'
import { withTx } from '../../../src/host/schema'
import { StoreError } from '../../../src/host/store/errors'
import { createProjectionWriter } from '../../../src/host/store/projection-apply'
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
          `SELECT id, name, executor_key, command, profile, args_template, permission_mode, model,
                  reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at
           FROM runtimes`,
        )
        .get(),
    ).toEqual({
      id: 'rt-1',
      name: '本机 dsh',
      executor_key: 'dsh',
      command: 'dsh',
      profile: 'multica',
      args_template: '',
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
        { table: 'plugin_config', key: 'x', row: sample.task() } as unknown as Change,
        SAMPLE_AT,
      ),
    )
    expect((unknownRow as StoreError).code).toBe('invalid_input')
  })

  it('存量 run 行缺 M2 新列：写入时补默认值（导入兼容）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    // 模拟 v2 存量：只有 M1 时代 runs 表的列，M2 新列全缺。
    const legacyRuntime = {
      id: 'run-old',
      taskId: null,
      stageId: null,
      agentId: null,
      runtimeId: null,
      status: 'succeeded',
      prompt: '旧提示词',
      output: '旧输出',
      error: null,
      errorCode: null,
      exitCode: 0,
      sessionId: null,
      usage: null,
      durationMs: 12,
      startedAt: SAMPLE_AT,
      endedAt: SAMPLE_AT,
      createdAt: SAMPLE_AT,
    } as unknown as RunRow

    writer.apply({ table: 'runs', key: 'run-old', row: legacyRuntime }, SAMPLE_AT)

    expect(
      db
        .prepare(
          `SELECT purpose, rule_id, rules_version, executor_key, cwd, access, event_ids_json,
                  hops, turn, queue_seq, cancel_requested
           FROM runs WHERE id = 'run-old'`,
        )
        .get(),
    ).toEqual({
      purpose: 'stage',
      rule_id: null,
      rules_version: 0,
      executor_key: '',
      cwd: '',
      access: 'edit',
      event_ids_json: '[]',
      hops: 0,
      turn: 1,
      queue_seq: 0,
      cancel_requested: 0,
    })
  })

  it('clear 清空十张投影表（重建事务关外键）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const runtime = sample.runtime()
    const agent = sample.agent()
    const workflow = sample.workflow()
    const stage = sample.stage()
    const task = sample.task()
    const run = sample.run({ status: 'running' })
    const conversation = sample.conversation()
    const message = sample.message()
    const card = sample.card()
    for (const change of [
      { table: 'runtimes', key: runtime.id, row: runtime },
      { table: 'agents', key: agent.id, row: agent },
      { table: 'workflows', key: workflow.id, row: workflow },
      { table: 'workflow_stages', key: stage.id, row: stage },
      { table: 'tasks', key: task.id, row: task },
      { table: 'runs', key: run.id, row: run },
      { table: 'run_events', key: 'run-1:1', row: sample.runEvent() },
      { table: 'conversations', key: conversation.id, row: conversation },
      { table: 'messages', key: message.id, row: message },
      { table: 'cards', key: card.id, row: card },
    ] as Change[]) {
      writer.apply(change, SAMPLE_AT)
    }
    expect(countRows(db, 'run_events')).toBe(1)
    expect(countRows(db, 'cards')).toBe(1)

    db.exec('PRAGMA foreign_keys = OFF')
    try {
      writer.clear()
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }

    for (const table of [
      'tasks',
      'workflows',
      'workflow_stages',
      'agents',
      'runtimes',
      'runs',
      'run_events',
      'conversations',
      'messages',
      'cards',
    ]) {
      expect(countRows(db, table)).toBe(0)
    }
  })
})
