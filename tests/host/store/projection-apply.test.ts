// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Change } from '../../../src/kernel/core/types'
import type {
  Agent,
  Conversation,
  RunRow,
  Runtime,
  Task,
  WorkflowStage,
} from '../../../src/protocol/entities'
import type { PluginSettingsRow } from '../../../src/protocol/plugins'
import type { AutomationRule, RuleFireRow, RuleSetRow } from '../../../src/protocol/rules'
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

/** 规则样例（`rule_sets.rules_json` 的逐字对比用）。 */
const ruleOne: AutomationRule = {
  id: 'rule-1',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
}

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
  it('五表 upsert 逐列写入（含 last_probe_json / enabled / 智能体执行配置 / 阶段 created_at）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    // M27：运行时只有连接字段，执行配置写进智能体
    const runtime = sample.runtime({
      enabled: false,
      lastProbe: sampleProbe,
    })
    const agent = sample.agent({
      model: 'dsh/模型',
      reasoningEffort: 'high',
      maxConcurrent: 3,
      permissionMode: 'read-only',
      workdir: 'D:\\Codes\\workbench',
      env: { CI: '1' },
    })
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
          `SELECT id, name, executor_key, command, profile, args_template, enabled,
                  last_probe_json, created_at
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
      enabled: 0,
      last_probe_json: JSON.stringify(sampleProbe),
      created_at: SAMPLE_AT,
    })
    expect(
      db
        .prepare(
          `SELECT id, name, description, runtime_id, system_prompt, model, reasoning_effort,
                  max_concurrent, permission_mode, workdir, env_json, created_at
           FROM agents`,
        )
        .get(),
    ).toEqual({
      id: 'ag-1',
      name: '实现者',
      description: '',
      runtime_id: 'rt-1',
      system_prompt: '',
      model: 'dsh/模型',
      reasoning_effort: 'high',
      max_concurrent: 3,
      permission_mode: 'read-only',
      workdir: 'D:\\Codes\\workbench',
      env_json: JSON.stringify({ CI: '1' }),
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
                  exits_json, handoffs_json, judge_json, created_at
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
      exits_json: '{}',
      handoffs_json: '[]',
      judge_json: 'null',
      created_at: SAMPLE_AT,
    })
    expect(
      db
        .prepare(
          `SELECT id, title, description, workflow_id, current_stage_id, status, origin, rule_id,
                  external_ref, labels_json, thread_id, parent_task_id, created_at, updated_at
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
      origin: 'manual',
      rule_id: null,
      external_ref: null,
      labels_json: '[]',
      thread_id: null,
      parent_task_id: null,
      created_at: SAMPLE_AT,
      updated_at: SAMPLE_AT,
    })
  })

  it('老智能体行缺执行配置六列：写入时归一为默认值（M27 前的 agent.* 事实 replay 兼容）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const runtime = sample.runtime()
    writer.apply({ table: 'runtimes', key: runtime.id, row: runtime }, SAMPLE_AT)
    // M27 前的 Agent 行只有身份字段（执行配置那时在运行时上）
    const legacyRow = {
      ...sample.agent(),
      model: undefined,
      reasoningEffort: undefined,
      maxConcurrent: undefined,
      permissionMode: undefined,
      workdir: undefined,
      env: undefined,
    } as unknown as Agent
    writer.apply({ table: 'agents', key: legacyRow.id, row: legacyRow }, SAMPLE_AT)

    expect(
      db
        .prepare(
          'SELECT model, reasoning_effort, max_concurrent, permission_mode, workdir, env_json FROM agents',
        )
        .get(),
    ).toEqual({
      model: null,
      reasoning_effort: null,
      max_concurrent: 1,
      permission_mode: 'workspace-write',
      workdir: null,
      env_json: '{}',
    })
  })

  it('tasks 新列（M6）：规则来源四列整行 upsert，再次写入覆盖来源列', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const workflow = sample.workflow()
    const stage = sample.stage()
    writer.apply({ table: 'workflows', key: workflow.id, row: workflow }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: stage.id, row: stage }, SAMPLE_AT)
    const ruleTask = sample.task({
      origin: 'rule',
      ruleId: 'rule-1',
      externalRef: 'issue-1',
      labels: ['bug', 'ui'],
    })
    writer.apply({ table: 'tasks', key: ruleTask.id, row: ruleTask }, SAMPLE_AT)
    expect(
      db.prepare('SELECT origin, rule_id, external_ref, labels_json FROM tasks').get(),
    ).toEqual({
      origin: 'rule',
      rule_id: 'rule-1',
      external_ref: 'issue-1',
      labels_json: '["bug","ui"]',
    })

    // 整行 upsert：同一 id 再写入时来源列随行覆盖（不做字段合并）
    writer.apply(
      {
        table: 'tasks',
        key: ruleTask.id,
        row: sample.task({ title: '改回手工', origin: 'manual', ruleId: null, labels: [] }),
      },
      LATER_AT,
    )
    expect(
      db.prepare('SELECT title, origin, rule_id, external_ref, labels_json FROM tasks').get(),
    ).toEqual({
      title: '改回手工',
      origin: 'manual',
      rule_id: null,
      external_ref: null,
      labels_json: '[]',
    })
    expect(countRows(db, 'tasks')).toBe(1)
  })

  it('老任务行缺来源四列：写入时归一为 manual / null / []（老事实 replay 兼容）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const workflow = sample.workflow()
    const stage = sample.stage()
    writer.apply({ table: 'workflows', key: workflow.id, row: workflow }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: stage.id, row: stage }, SAMPLE_AT)
    // M6 前的 Task 行没有这四个字段（历史事实 / 直接构造的变更）
    const legacyRow = {
      ...sample.task(),
      origin: undefined,
      ruleId: undefined,
      externalRef: undefined,
      labels: undefined,
    } as unknown as Task
    writer.apply({ table: 'tasks', key: legacyRow.id, row: legacyRow }, SAMPLE_AT)
    expect(
      db.prepare('SELECT origin, rule_id, external_ref, labels_json FROM tasks').get(),
    ).toEqual({ origin: 'manual', rule_id: null, external_ref: null, labels_json: '[]' })
    // M6.5：老行同样没有线程两列 → 归一为 null（投影边界第二道防线）
    expect(db.prepare('SELECT thread_id, parent_task_id FROM tasks').get()).toEqual({
      thread_id: null,
      parent_task_id: null,
    })
  })

  it('tasks 新列（M6.5）：thread_id / parent_task_id 整行 upsert，再次写入时随行覆盖', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, SAMPLE_AT)

    const childTask = sample.task({ threadId: 'th-1', parentTaskId: 'tk-parent' })
    writer.apply({ table: 'tasks', key: childTask.id, row: childTask }, SAMPLE_AT)
    expect(
      db.prepare('SELECT thread_id, parent_task_id FROM tasks WHERE id = ?').get('tk-1'),
    ).toEqual({ thread_id: 'th-1', parent_task_id: 'tk-parent' })

    // 整行 upsert：同 id 再写入时两列随行覆盖（解绑回 null 也不保留旧值）
    writer.apply(
      {
        table: 'tasks',
        key: childTask.id,
        row: sample.task({ threadId: null, parentTaskId: null }),
      },
      LATER_AT,
    )
    expect(
      db.prepare('SELECT thread_id, parent_task_id FROM tasks WHERE id = ?').get('tk-1'),
    ).toEqual({ thread_id: null, parent_task_id: null })
  })

  it('threads 整行 upsert：四个 JSON 列序列化，重复写入覆盖状态 / 笔记 / 事件', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const note = { id: 'note-1', author: 'agent' as const, text: '实现完成', at: SAMPLE_AT }
    const event = {
      eventId: 'ev-1',
      type: 'issues.opened',
      subject: '#1',
      summary: '新 Issue',
      link: 'https://example.com/1',
      detailRef: null,
      at: SAMPLE_AT,
    }
    const thread = sample.thread({
      taskIds: ['tk-1', 'tk-2'],
      rootTaskIds: ['tk-1'],
      notesVersion: 1,
      notes: [note],
      events: [event],
    })
    writer.apply({ table: 'threads', key: thread.id, row: thread }, SAMPLE_AT)
    expect(
      db
        .prepare(
          `SELECT source, external_ref, title, status, task_ids_json, root_task_ids_json,
                  concurrency, notes_version, notes_json, events_json, last_activity_at, created_at
           FROM threads WHERE id = ?`,
        )
        .get(thread.id),
    ).toEqual({
      source: 'github',
      external_ref: 'issue-1',
      title: 'Issue 一号',
      status: 'open',
      task_ids_json: '["tk-1","tk-2"]',
      root_task_ids_json: '["tk-1"]',
      concurrency: 1,
      notes_version: 1,
      notes_json: JSON.stringify([note]),
      events_json: JSON.stringify([event]),
      last_activity_at: SAMPLE_AT,
      created_at: SAMPLE_AT,
    })

    // `thread.*` 事实携带完整行：状态 / 笔记 / 事件整批覆盖（不做字段合并）
    const closed = sample.thread({
      status: 'closed',
      taskIds: ['tk-1', 'tk-2'],
      rootTaskIds: ['tk-1'],
      notesVersion: 2,
      notes: [note, { ...note, id: 'note-2', text: '已关闭', at: LATER_AT }],
      events: [event],
      lastActivityAt: LATER_AT,
    })
    writer.apply({ table: 'threads', key: closed.id, row: closed }, LATER_AT)
    expect(
      db
        .prepare(
          `SELECT status, notes_version, notes_json, last_activity_at FROM threads WHERE id = ?`,
        )
        .get(closed.id),
    ).toEqual({
      status: 'closed',
      notes_version: 2,
      notes_json: JSON.stringify(closed.notes),
      last_activity_at: LATER_AT,
    })
    expect(countRows(db, 'threads')).toBe(1)

    // 删除：row = null 只删目标行
    writer.apply({ table: 'threads', key: closed.id, row: null }, LATER_AT)
    expect(countRows(db, 'threads')).toBe(0)
  })

  it('task_comments 纯追加：逐列写入；重复 id 撞主键报错；任务删除按父键联删（M7.5）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, SAMPLE_AT)
    const task = sample.task()
    writer.apply({ table: 'tasks', key: task.id, row: task }, SAMPLE_AT)

    const comment = {
      id: 'tc-1',
      taskId: task.id,
      author: 'owner' as const,
      text: '按钮改成粉色',
      createdAt: SAMPLE_AT,
    }
    writer.apply({ table: 'task_comments', key: comment.id, row: comment }, SAMPLE_AT)
    expect(
      db
        .prepare('SELECT task_id, author, text, created_at FROM task_comments WHERE id = ?')
        .get(comment.id),
    ).toEqual({
      task_id: task.id,
      author: 'owner',
      text: '按钮改成粉色',
      created_at: SAMPLE_AT,
    })

    // 追加语义：同一个 id 不能被覆盖
    expect(() =>
      writer.apply({ table: 'task_comments', key: comment.id, row: comment }, LATER_AT),
    ).toThrow()
    expect(countRows(db, 'task_comments')).toBe(1)

    // 任务删除：评论随父键一起消失（重建事务关外键，走显式联删）
    writer.apply({ table: 'tasks', key: task.id, row: null }, LATER_AT)
    expect(countRows(db, 'tasks')).toBe(0)
    expect(countRows(db, 'task_comments')).toBe(0)
  })

  it('review_reports 整行 upsert：findings / checks / artifact 序列化；任务删除联删（M14）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    writer.apply({ table: 'workflows', key: 'wf-1', row: sample.workflow() }, SAMPLE_AT)
    writer.apply({ table: 'workflow_stages', key: 'st-1', row: sample.stage() }, SAMPLE_AT)
    const task = sample.task()
    writer.apply({ table: 'tasks', key: task.id, row: task }, SAMPLE_AT)

    const row = {
      id: 'run-1:1',
      taskId: task.id,
      stageId: 'st-1',
      runId: 'run-1',
      threadId: null,
      rev: 1,
      verdict: 'fail' as const,
      checks: [{ cmd: 'pnpm check', exitCode: 1 }],
      findings: [
        {
          id: 'run-1:1#R1',
          key: 'R1',
          severity: 'high' as const,
          location: 'src/a.ts:64',
          claim: 'BOM 文件被判非法 JSON',
          evidence: null,
          requiredAction: '改成 utf-8-sig 后复跑',
          status: 'open' as const,
          note: null,
          addressedByRunId: null,
          updatedAt: SAMPLE_AT,
        },
      ],
      artifact: { path: '/artifacts/report.md', sha256: 'abc', bytes: 10 },
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
    }
    writer.apply({ table: 'review_reports', key: row.id, row }, SAMPLE_AT)
    const stored = db
      .prepare(
        'SELECT task_id, rev, verdict, checks_json, findings_json, artifact_json FROM review_reports WHERE id = ?',
      )
      .get(row.id) as unknown as Record<string, unknown>
    expect(stored.task_id).toBe(task.id)
    expect(stored.rev).toBe(1)
    expect(stored.verdict).toBe('fail')
    expect(JSON.parse(stored.checks_json as string)).toEqual([{ cmd: 'pnpm check', exitCode: 1 }])
    expect(JSON.parse(stored.findings_json as string)[0].id).toBe('run-1:1#R1')
    expect(JSON.parse(stored.artifact_json as string).path).toBe('/artifacts/report.md')

    // 整行覆盖：逐条处置后同一行 id 换成新状态（不做局部合并）
    const closed = {
      ...row,
      findings: [{ ...row.findings[0], status: 'addressed' as const, addressedByRunId: 'run-2' }],
      updatedAt: LATER_AT,
    }
    writer.apply({ table: 'review_reports', key: row.id, row: closed }, LATER_AT)
    expect(countRows(db, 'review_reports')).toBe(1)
    const after = db
      .prepare('SELECT findings_json, updated_at FROM review_reports WHERE id = ?')
      .get(row.id) as unknown as { findings_json: string; updated_at: string }
    expect(JSON.parse(after.findings_json)[0].status).toBe('addressed')
    expect(after.updated_at).toBe(LATER_AT)

    // 任务删除：报告随父键一起消失
    writer.apply({ table: 'tasks', key: task.id, row: null }, LATER_AT)
    expect(countRows(db, 'review_reports')).toBe(0)
  })

  it('rule_sets 单行整行替换：版本与规则清单一起换，不合并旧规则', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const first: RuleSetRow = { id: 'current', version: 1, replacedAt: SAMPLE_AT, rules: [ruleOne] }
    writer.apply({ table: 'rule_sets', key: 'current', row: first }, SAMPLE_AT)
    expect(db.prepare('SELECT id, version, replaced_at, rules_json FROM rule_sets').get()).toEqual({
      id: 'current',
      version: 1,
      replaced_at: SAMPLE_AT,
      rules_json: JSON.stringify([ruleOne]),
    })

    const second: RuleSetRow = { id: 'current', version: 2, replacedAt: LATER_AT, rules: [] }
    writer.apply({ table: 'rule_sets', key: 'current', row: second }, LATER_AT)
    expect(db.prepare('SELECT version, replaced_at, rules_json FROM rule_sets').get()).toEqual({
      version: 2,
      replaced_at: LATER_AT,
      rules_json: '[]',
    })
    expect(countRows(db, 'rule_sets')).toBe(1)
  })

  it('rule_fires 纯追加：重复 id 撞主键报错，不覆盖历史触发', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const fire: RuleFireRow = {
      id: 'fire-1',
      ruleId: 'rule-1',
      version: 1,
      scheduledFor: SAMPLE_AT,
      firedAt: SAMPLE_AT,
      taskId: 'tk-1',
    }
    writer.apply({ table: 'rule_fires', key: fire.id, row: fire }, SAMPLE_AT)
    expect(
      db
        .prepare('SELECT id, rule_id, version, scheduled_for, fired_at, task_id FROM rule_fires')
        .get(),
    ).toEqual({
      id: 'fire-1',
      rule_id: 'rule-1',
      version: 1,
      scheduled_for: SAMPLE_AT,
      fired_at: SAMPLE_AT,
      task_id: 'tk-1',
    })
    expect(() =>
      writer.apply(
        {
          table: 'rule_fires',
          key: 'fire-1',
          row: { ...fire, scheduledFor: LATER_AT, firedAt: LATER_AT },
        },
        LATER_AT,
      ),
    ).toThrow()
    expect(countRows(db, 'rule_fires')).toBe(1)
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

  it('存量 runtime 行缺 M3 新列：executor_key 按旧协议族映射，args_template 补空串', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    // M1/v2 行没有 executorKey / argsTemplate：一个带旧 protocolFamily，一个两样都缺。
    const withFamily = {
      ...sample.runtime({ id: 'rt-legacy', name: '旧运行时' }),
      executorKey: undefined,
      argsTemplate: undefined,
      protocolFamily: 'dsh',
    } as unknown as Runtime
    const bare = {
      ...sample.runtime({ id: 'rt-bare', name: '无键运行时' }),
      executorKey: undefined,
      argsTemplate: undefined,
    } as unknown as Runtime

    writer.apply({ table: 'runtimes', key: withFamily.id, row: withFamily }, SAMPLE_AT)
    writer.apply({ table: 'runtimes', key: bare.id, row: bare }, SAMPLE_AT)

    expect(
      db.prepare('SELECT id, executor_key, args_template FROM runtimes ORDER BY id').all(),
    ).toEqual([
      { id: 'rt-bare', executor_key: '', args_template: '' },
      { id: 'rt-legacy', executor_key: 'dsh', args_template: '' },
    ])
  })

  it('存量 run 行缺 prompt / output：写入时补空串（不留 null）', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const legacy = {
      ...sample.run({
        id: 'run-no-text',
        taskId: null,
        stageId: null,
        agentId: null,
        runtimeId: null,
      }),
      prompt: undefined,
      output: undefined,
    } as unknown as RunRow

    writer.apply({ table: 'runs', key: legacy.id, row: legacy }, SAMPLE_AT)

    expect(db.prepare("SELECT prompt, output FROM runs WHERE id = 'run-no-text'").get()).toEqual({
      prompt: '',
      output: '',
    })
  })

  it('clear 清空十四张投影表（重建事务关外键）', () => {
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
    const thread = sample.thread()
    const settings: PluginSettingsRow = {
      id: 'current',
      version: 1,
      replacedAt: SAMPLE_AT,
      settings: [],
    }
    const ruleSet: RuleSetRow = {
      id: 'current',
      version: 1,
      replacedAt: SAMPLE_AT,
      rules: [ruleOne],
    }
    const fire: RuleFireRow = {
      id: 'fire-1',
      ruleId: 'rule-1',
      version: 1,
      scheduledFor: SAMPLE_AT,
      firedAt: SAMPLE_AT,
      taskId: null,
    }
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
      { table: 'rule_sets', key: ruleSet.id, row: ruleSet },
      { table: 'rule_fires', key: fire.id, row: fire },
      { table: 'threads', key: thread.id, row: thread },
      { table: 'plugin_settings', key: settings.id, row: settings },
    ] as Change[]) {
      writer.apply(change, SAMPLE_AT)
    }
    expect(countRows(db, 'run_events')).toBe(1)
    expect(countRows(db, 'cards')).toBe(1)
    expect(countRows(db, 'rule_sets')).toBe(1)
    expect(countRows(db, 'rule_fires')).toBe(1)
    expect(countRows(db, 'threads')).toBe(1)
    expect(countRows(db, 'plugin_settings')).toBe(1)

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
      'rule_sets',
      'rule_fires',
      'threads',
      'plugin_settings',
    ]) {
      expect(countRows(db, table)).toBe(0)
    }
  })
})

describe('createProjectionWriter：列默认值兜底', () => {
  it('workflow_stages：阶段行缺 instructions 时按空串落库', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const workflow = sample.workflow()
    writer.apply({ table: 'workflows', key: workflow.id, row: workflow }, SAMPLE_AT)
    // 兼容旧快照：阶段负载可能不带 instructions，投影按空串归一
    const stage = { ...sample.stage(), instructions: undefined } as unknown as WorkflowStage
    writer.apply({ table: 'workflow_stages', key: stage.id, row: stage }, SAMPLE_AT)
    expect(
      db.prepare('SELECT instructions FROM workflow_stages WHERE id = ?').get(stage.id),
    ).toEqual({ instructions: '' })
  })

  it('conversations：project_id 逐列落库；老行缺 projectId 按 null（默认目录）归一', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const runtime = sample.runtime()
    const agent = sample.agent()
    writer.apply({ table: 'runtimes', key: runtime.id, row: runtime }, SAMPLE_AT)
    writer.apply({ table: 'agents', key: agent.id, row: agent }, SAMPLE_AT)

    const assigned = sample.conversation({ id: 'cv-assigned', projectId: 'pj-1' })
    writer.apply({ table: 'conversations', key: assigned.id, row: assigned }, SAMPLE_AT)
    // 兼容旧快照（M11 前的快照导入行）：负载里没有 projectId
    const legacy = {
      ...sample.conversation({ id: 'cv-legacy' }),
      projectId: undefined,
    } as unknown as Conversation
    writer.apply({ table: 'conversations', key: legacy.id, row: legacy }, SAMPLE_AT)

    expect(db.prepare('SELECT id, project_id FROM conversations ORDER BY id').all()).toEqual([
      { id: 'cv-assigned', project_id: 'pj-1' },
      { id: 'cv-legacy', project_id: null },
    ])

    // 项目删除后内核产 conversation.updated{projectId:null}：整行覆盖，项目引用被清掉
    writer.apply(
      {
        table: 'conversations',
        key: assigned.id,
        row: { ...assigned, projectId: null, updatedAt: LATER_AT },
      },
      SAMPLE_AT,
    )
    expect(
      db.prepare('SELECT project_id, updated_at FROM conversations WHERE id = ?').get(assigned.id),
    ).toEqual({ project_id: null, updated_at: LATER_AT })
  })
})

describe('createProjectionWriter：M20 验收列的旧快照兜底', () => {
  it('workflow_stages：阶段负载缺 acceptance（M20 补列前）时按空数组落库', () => {
    const db = memory()
    const writer = createProjectionWriter(db)
    const workflow = sample.workflow()
    writer.apply({ table: 'workflows', key: workflow.id, row: workflow }, SAMPLE_AT)
    const stage = { ...sample.stage(), acceptance: undefined } as unknown as WorkflowStage
    writer.apply({ table: 'workflow_stages', key: stage.id, row: stage }, SAMPLE_AT)
    expect(
      db.prepare('SELECT acceptance_json FROM workflow_stages WHERE id = ?').get(stage.id),
    ).toEqual({ acceptance_json: '[]' })
  })
})
