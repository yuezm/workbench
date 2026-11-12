// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENTS_M27_ADD_COLUMN_SQL,
  AGENTS_M27_ADDED_COLUMNS,
  CONVERSATIONS_M11_ADD_COLUMN_SQL,
  CONVERSATIONS_M11_ADDED_COLUMNS,
  FACTS_SQL,
  PROJECTION_DDL,
  PROJECTION_TABLES,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  STAGES_M18_ADD_COLUMN_SQL,
  STAGES_M18_ADDED_COLUMNS,
  STAGES_M20_ADDED_COLUMNS,
  STAGES_M20_ADD_COLUMN_SQL,
  STAGES_M26_ADDED_COLUMNS,
  STAGES_M26_ADD_COLUMN_SQL,
  formatOfProjection,
  projectionFormat,
  tableDdl,
  withTx,
} from '../../src/host/schema'
import { PROJECTION_TABLES as KERNEL_PROJECTION_TABLES } from '../../src/kernel/types'

const SAMPLE_AT = '2026-01-01T00:00:00.000Z'

/**
 * 改前（M1 之前的 src/main/ai-workflow/schema.ts，HEAD a2697e7）五张业务表的 DDL 原样抄录。
 * 只用于对照：新 schema 必须逐列、逐索引、逐外键与它一致。
 */
const PRE_M1_FIVE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  protocol_family TEXT NOT NULL DEFAULT 'dsh' CHECK (protocol_family IN ('dsh')),
  command TEXT NOT NULL DEFAULT 'dsh',
  profile TEXT NOT NULL DEFAULT 'multica',
  permission_mode TEXT NOT NULL DEFAULT 'workspace-write'
    CHECK (permission_mode IN ('read-only','workspace-write','danger-full-access')),
  model TEXT,
  reasoning_effort TEXT,
  workdir TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_probe_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_stages (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  entry_mode TEXT NOT NULL CHECK (entry_mode IN ('none','agent','user')),
  agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  on_complete_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  on_reject_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, position)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  current_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

const PRE_M1_FIVE_TABLE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_stages_workflow ON workflow_stages(workflow_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
`

/**
 * 静态表：DDL 自 M1 起未变（`runtimes` 在 M3 换成 `executor_key`；`tasks` 在 M6 / M7 追加列；
 * `workflow_stages` 在 M7 追加交接两列；`agents` 在 M27 追加执行配置六列；各自单独断言）。
 */
const STATIC_TABLES = ['workflows']

/** M7 tasks 列（顺序与 DDL 一致）：来源四列 + 线程两列 + 交接两列，时间列仍在末尾。 */
const TASKS_M7_COLUMNS = [
  'id',
  'title',
  'description',
  'workflow_id',
  'current_stage_id',
  'status',
  'origin',
  'rule_id',
  'external_ref',
  'labels_json',
  'thread_id',
  'parent_task_id',
  'spawned_by_run_id',
  'batch_no',
  'spawn_key',
  'handoff_from_task_id',
  'handoff_from_stage_id',
  'project_id',
  // M11：闸门预算
  'gate_fails',
  'created_at',
  'updated_at',
]

/** M29 workflow_stages 列（顺序与 DDL 一致）：派单列插在 on_reject_stage_id 之后，旧 M7 两列仍保留。 */
const STAGES_M7_COLUMNS = [
  'id',
  'workflow_id',
  'name',
  'position',
  'entry_mode',
  'agent_id',
  'on_complete_stage_id',
  'on_reject_stage_id',
  'handoffs_json',
  'handoff_workflow_id',
  'handoff_stage_id',
  'subtask_stage_id',
  'on_children_settled',
  'spawn_policy',
  // M9：阶段要干什么
  'instructions',
  // M20：验收条目（JSON 数组文本）
  'acceptance_json',
  // M21：阶段内轮次上限（NULL = 不续轮）
  'max_rounds',
  // M26：阶段单轮运行超时（NULL = 用全局缺省 60 min）
  'run_timeout_ms',
  // M11：闸门三列
  'gate_max_fails',
  'gate_on_pass_stage_id',
  'gate_on_fail_stage_id',
  // M18：内置阶段键（null = 自己添加的阶段）
  'builtin',
  'created_at',
]

/** M3 runtimes 列（顺序与 DDL 一致）：`protocol_family` 被 `executor_key` + `args_template` 取代。 */
const RUNTIMES_M3_COLUMNS = [
  'id',
  'name',
  'executor_key',
  'command',
  'profile',
  'args_template',
  'enabled',
  'last_probe_json',
  'created_at',
]

/** M27 起运行时不再携带的执行配置列（搬到 agents 上）。 */
const RUNTIMES_M27_REMOVED_COLUMNS = [
  'permission_mode',
  'model',
  'reasoning_effort',
  'workdir',
  'max_concurrent',
]

/** M27 agents 列（顺序与 DDL 一致）：身份五列之后追加执行配置六列，时间列仍在末尾。 */
const AGENTS_M27_COLUMNS = [
  'id',
  'name',
  'description',
  'runtime_id',
  'system_prompt',
  'model',
  'reasoning_effort',
  'max_concurrent',
  'permission_mode',
  'workdir',
  'env_json',
  'created_at',
]

let dbs: DatabaseSync[] = []

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs) db.close()
  dbs = []
})

function columnShape(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<
    Record<string, unknown>
  >
  return rows.map((row) =>
    [row.name, row.type, row.notnull, row.dflt_value, row.pk].map(String).join('|'),
  )
}

function indexShape(db: DatabaseSync, table: string): string[] {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as unknown as Array<
    Record<string, unknown>
  >
  return indexes
    .map((index) => {
      const columns = db
        .prepare(`PRAGMA index_info(${String(index.name)})`)
        .all() as unknown as Array<Record<string, unknown>>
      const columnList = columns.map((column) => String(column.name)).join(',')
      return [
        index.name,
        `unique=${String(index.unique)}`,
        `origin=${String(index.origin)}`,
        `partial=${String(index.partial)}`,
        `columns=${columnList}`,
      ].join('|')
    })
    .sort()
}

function foreignKeyShape(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as Array<
    Record<string, unknown>
  >
  return rows
    .map((row) =>
      [row.id, row.seq, row.table, row['from'], row.to, row.on_update, row.on_delete, row.match]
        .map(String)
        .join('|'),
    )
    .sort()
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>
  return rows.map((row) => row.name).sort()
}

describe('静态表与改前 DDL 一致；runtimes 按 M3 结构；agents 按 M27 结构', () => {
  it('runtimes 按 M3 结构：executor_key + args_template，无 protocol_family', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(columnShape(db, 'runtimes').map((column) => column.split('|')[0])).toEqual(
      RUNTIMES_M3_COLUMNS,
    )
    expect(columnShape(db, 'runtimes').join('\n')).not.toContain('protocol_family')
  })

  it('M27：runtimes 只剩连接字段，执行配置五列全部搬走', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    const columns = columnShape(db, 'runtimes').map((column) => column.split('|')[0])
    for (const column of RUNTIMES_M27_REMOVED_COLUMNS) {
      expect(columns, column).not.toContain(column)
    }
  })

  it('agents 按 M27 结构：身份列逐列不变，执行配置六列插在 system_prompt 与时间列之间', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    expect(columnShape(current, 'agents').map((column) => column.split('|')[0])).toEqual(
      AGENTS_M27_COLUMNS,
    )
    // M1 的智能体五列（名 / 类型 / NOT NULL / 默认值 / 主键）逐列原样保留
    const byName = new Map(
      columnShape(current, 'agents').map((shape) => [shape.split('|')[0], shape] as const),
    )
    for (const shape of columnShape(legacy, 'agents')) {
      const name = shape.split('|')[0]
      expect(byName.get(name), name).toBe(shape)
    }
    // 执行配置新列：可空 / 有默认值 / 权限列带 CHECK
    expect(byName.get('model')).toBe('model|TEXT|0|null|0')
    expect(byName.get('reasoning_effort')).toBe('reasoning_effort|TEXT|0|null|0')
    expect(byName.get('max_concurrent')).toBe('max_concurrent|INTEGER|1|1|0')
    expect(byName.get('permission_mode')).toBe("permission_mode|TEXT|1|'workspace-write'|0")
    expect(byName.get('workdir')).toBe('workdir|TEXT|0|null|0')
    expect(byName.get('env_json')).toBe("env_json|TEXT|1|'{}'|0")
  })

  it('agents 索引与外键与 M1 一致：runtime_id → runtimes ON DELETE RESTRICT', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    expect(indexShape(current, 'agents')).toEqual(indexShape(legacy, 'agents'))
    expect(foreignKeyShape(current, 'agents')).toEqual(foreignKeyShape(legacy, 'agents'))
  })

  it('M27 智能体补列清单与 DDL 同步：六列、默认值 / CHECK 与建表语句同口径', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect([...AGENTS_M27_ADDED_COLUMNS]).toEqual([
      'model',
      'reasoning_effort',
      'max_concurrent',
      'permission_mode',
      'workdir',
      'env_json',
    ])
    expect(AGENTS_M27_ADD_COLUMN_SQL.model).toBe('ALTER TABLE agents ADD COLUMN model TEXT')
    expect(AGENTS_M27_ADD_COLUMN_SQL.max_concurrent).toContain(
      'ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 1',
    )
    expect(AGENTS_M27_ADD_COLUMN_SQL.permission_mode).toContain("DEFAULT 'workspace-write'")
    expect(AGENTS_M27_ADD_COLUMN_SQL.permission_mode).toContain(
      "CHECK (permission_mode IN ('read-only','workspace-write','danger-full-access'))",
    )
    expect(AGENTS_M27_ADD_COLUMN_SQL.env_json).toContain("DEFAULT '{}'")

    // 补列语句逐条执行后与建表 DDL 的列形状一致（旧库补列口径）
    const memory = new DatabaseSync(':memory:')
    try {
      memory.exec('CREATE TABLE agents (id TEXT PRIMARY KEY)')
      for (const column of AGENTS_M27_ADDED_COLUMNS) {
        memory.exec(AGENTS_M27_ADD_COLUMN_SQL[column])
      }
      expect(columnShape(memory, 'agents').map((column) => column.split('|')[0])).toEqual([
        'id',
        ...AGENTS_M27_ADDED_COLUMNS,
      ])
    } finally {
      memory.close()
    }
  })

  it('tasks 按 M7/M8 结构：来源四列 + 线程两列 + spawn 三列 + 交接两列插在 status 与时间列之间，旧 8 列逐列不变', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    expect(columnShape(current, 'tasks').map((column) => column.split('|')[0])).toEqual(
      TASKS_M7_COLUMNS,
    )
    // 旧 v2 的 8 列（名 / 类型 / NOT NULL / 默认值 / 主键）逐列原样保留
    const byName = new Map(
      columnShape(current, 'tasks').map((shape) => [shape.split('|')[0], shape] as const),
    )
    for (const shape of columnShape(legacy, 'tasks')) {
      const name = shape.split('|')[0]
      expect(byName.get(name), name).toBe(shape)
    }
  })

  it('workflow_stages 按 M7/M8/M18 结构：交接两列 + 子任务三列插在 on_reject_stage_id 与时间列之间，M1 列逐列不变', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)
    legacy.exec(PRE_M1_FIVE_TABLE_INDEXES)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    expect(columnShape(current, 'workflow_stages').map((column) => column.split('|')[0])).toEqual(
      STAGES_M7_COLUMNS,
    )
    const byName = new Map(
      columnShape(current, 'workflow_stages').map((shape) => [shape.split('|')[0], shape] as const),
    )
    for (const shape of columnShape(legacy, 'workflow_stages')) {
      const name = shape.split('|')[0]
      expect(byName.get(name), name).toBe(shape)
    }
    // 交接两列是弱引用：不改变既有外键与唯一约束
    expect(foreignKeyShape(current, 'workflow_stages')).toEqual(
      foreignKeyShape(legacy, 'workflow_stages'),
    )
    expect(indexShape(current, 'workflow_stages')).toEqual(indexShape(legacy, 'workflow_stages'))
  })

  it('M20 验收列与 M21 轮次列：默认值与 CHECK 与 DDL 同口径', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    const shapeOf = (name: string): string | undefined =>
      columnShape(db, 'workflow_stages').find((shape) => shape.split('|')[0] === name)
    // name | type | notnull | default | pk
    expect(shapeOf('acceptance_json')).toBe("acceptance_json|TEXT|1|'[]'|0")
    expect(shapeOf('max_rounds')).toBe('max_rounds|INTEGER|0|null|0')
    expect(STAGES_M20_ADDED_COLUMNS).toEqual(['acceptance_json', 'max_rounds'])
    expect(STAGES_M20_ADD_COLUMN_SQL.acceptance_json).toContain('ADD COLUMN acceptance_json TEXT')
    expect(STAGES_M20_ADD_COLUMN_SQL.acceptance_json).toContain("DEFAULT '[]'")
    expect(STAGES_M20_ADD_COLUMN_SQL.max_rounds).toContain('ADD COLUMN max_rounds INTEGER')
    expect(STAGES_M20_ADD_COLUMN_SQL.max_rounds).toContain('BETWEEN 1 AND 5')
  })

  it('M26 阶段超时列：可空无默认、CHECK 认 5 min–4 h，补列语句与 DDL 同口径', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    const shapeOf = (name: string): string | undefined =>
      columnShape(db, 'workflow_stages').find((shape) => shape.split('|')[0] === name)
    // name | type | notnull | default | pk
    expect(shapeOf('run_timeout_ms')).toBe('run_timeout_ms|INTEGER|0|null|0')
    expect(STAGES_M26_ADDED_COLUMNS).toEqual(['run_timeout_ms'])
    expect(STAGES_M26_ADD_COLUMN_SQL.run_timeout_ms).toContain('ADD COLUMN run_timeout_ms INTEGER')
    expect(STAGES_M26_ADD_COLUMN_SQL.run_timeout_ms).toContain('BETWEEN 300000 AND 14400000')
  })

  it('M18 内置阶段列：builtin 可空无默认、只认四个内置键，补列语句与 DDL 同口径', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    const builtin = columnShape(db, 'workflow_stages').find(
      (shape) => shape.split('|')[0] === 'builtin',
    )
    // name | type | notnull | default | pk
    expect(builtin).toBe('builtin|TEXT|0|null|0')
    expect(STAGES_M18_ADDED_COLUMNS).toEqual(['builtin'])
    expect(STAGES_M18_ADD_COLUMN_SQL.builtin).toContain(
      "CHECK (builtin IN ('todo','blocked','done','cancelled'))",
    )
    expect(STAGES_M18_ADD_COLUMN_SQL.builtin).toContain('ADD COLUMN builtin TEXT')

    db.exec(
      "INSERT INTO workflows (id, name, created_at) VALUES ('wf-18', '流程', '2026-01-01T00:00:00.000Z')",
    )
    const insert = db.prepare(
      `INSERT INTO workflow_stages (id, workflow_id, name, position, entry_mode, builtin, created_at)
       VALUES (?, 'wf-18', ?, ?, 'none', ?, '2026-01-01T00:00:00.000Z')`,
    )
    // null = 自己添加的阶段；四个内置键各自可写
    insert.run('st-user', '自己加的', 0, null)
    ;(['todo', 'blocked', 'done', 'cancelled'] as const).forEach((key, index) => {
      insert.run(`st-${key}`, `内置 ${key}`, index + 1, key)
    })
    expect(
      db.prepare('SELECT builtin FROM workflow_stages WHERE id = ?').get('st-user') as {
        builtin: string | null
      },
    ).toEqual({ builtin: null })
    // 五个键之外的值被 CHECK 拒
    expect(() => insert.run('st-bad', '非法', 9, 'archived')).toThrow()
  })

  it('tasks 新列默认值 / CHECK：旧行与手工任务 origin=manual、线程与交接列为 null，非法来源被拒', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    db.exec(
      "INSERT INTO workflows (id, name, created_at) VALUES ('wf-1', '流程', '2026-01-01T00:00:00.000Z')",
    )
    db.prepare(
      `INSERT INTO tasks (id, title, workflow_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('tk-manual', '手工任务', 'wf-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    expect(
      db
        .prepare(
          `SELECT origin, rule_id, external_ref, labels_json, thread_id, parent_task_id,
                  spawned_by_run_id, batch_no, spawn_key,
                  handoff_from_task_id, handoff_from_stage_id
           FROM tasks WHERE id = ?`,
        )
        .get('tk-manual'),
    ).toEqual({
      origin: 'manual',
      rule_id: null,
      external_ref: null,
      labels_json: '[]',
      thread_id: null,
      parent_task_id: null,
      spawned_by_run_id: null,
      batch_no: null,
      spawn_key: null,
      handoff_from_task_id: null,
      handoff_from_stage_id: null,
    })

    db.prepare(
      `INSERT INTO tasks (id, title, workflow_id, origin, rule_id, external_ref, labels_json,
                          thread_id, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, 'rule', 'rule-1', 'issue-1', '["bug"]', 'th-1', 'tk-parent', ?, ?)`,
    ).run('tk-rule', '规则任务', 'wf-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    expect(
      db
        .prepare(
          `SELECT origin, rule_id, external_ref, labels_json, thread_id, parent_task_id,
                  spawned_by_run_id, batch_no, spawn_key,
                  handoff_from_task_id, handoff_from_stage_id
           FROM tasks WHERE id = ?`,
        )
        .get('tk-rule'),
    ).toEqual({
      origin: 'rule',
      rule_id: 'rule-1',
      external_ref: 'issue-1',
      labels_json: '["bug"]',
      thread_id: 'th-1',
      parent_task_id: 'tk-parent',
      spawned_by_run_id: null,
      batch_no: null,
      spawn_key: null,
      handoff_from_task_id: null,
      handoff_from_stage_id: null,
    })

    expect(() =>
      db.prepare("UPDATE tasks SET origin = 'agent' WHERE id = 'tk-manual'").run(),
    ).toThrow()
  })

  it('逐列一致（列名 / 类型 / NOT NULL / 默认值 / 主键）', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)
    legacy.exec(PRE_M1_FIVE_TABLE_INDEXES)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    expect(SCHEMA_VERSION).toBe(2)
    for (const table of STATIC_TABLES) {
      expect(columnShape(current, table), table).toEqual(columnShape(legacy, table))
    }
  })

  it('索引与唯一约束一致', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)
    legacy.exec(PRE_M1_FIVE_TABLE_INDEXES)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    for (const table of STATIC_TABLES) {
      expect(indexShape(current, table), table).toEqual(indexShape(legacy, table))
    }
  })

  it('外键与删除动作一致', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)
    legacy.exec(PRE_M1_FIVE_TABLE_INDEXES)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    for (const table of STATIC_TABLES) {
      expect(foreignKeyShape(current, table), table).toEqual(foreignKeyShape(legacy, table))
    }
  })

  it('SCHEMA_SQL 建 17 张表：十七张投影（旧聊天表已由 T14b 迁成事实并删除）', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(tableNames(db)).toEqual([
      'agents',
      'cards',
      'conversations',
      'messages',
      'plugin_settings',
      'projects',
      'review_reports',
      'rule_fires',
      'rule_sets',
      'run_events',
      'runs',
      'runtimes',
      'task_comments',
      'tasks',
      'threads',
      'workflow_stages',
      'workflows',
    ])
  })

  it('旧聊天表名不进投影白名单 / 指纹（T14b 已删除旧表）', () => {
    expect(PROJECTION_TABLES).not.toContain('chat_conversations')
    expect(PROJECTION_TABLES).not.toContain('chat_messages')
    expect(PROJECTION_DDL).not.toContain('chat_conversations')
    expect(PROJECTION_DDL).not.toContain('chat_messages')
  })
})

describe('facts / projection_meta', () => {
  it('facts 列与自增主键', () => {
    const db = memoryDb()
    db.exec(FACTS_SQL)
    const columns = db.prepare('PRAGMA table_info(facts)').all() as unknown as Array<
      Record<string, unknown>
    >
    expect(columns.map((column) => String(column.name))).toEqual([
      'seq',
      'type',
      'actor_json',
      'at',
      'cause',
      'hops',
      'payload',
    ])
    expect(columns.find((column) => column.name === 'seq')?.pk).toBe(1)
    expect(
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'")
          .get() as unknown as { sql: string }
      ).sql,
    ).toContain('AUTOINCREMENT')

    const insert = db.prepare(
      'INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)',
    )
    insert.run('task.created', '{}', '2026-01-01T00:00:00.000Z', '{}')
    insert.run('task.moved', '{}', '2026-01-01T00:00:01.000Z', '{}')
    insert.run('task.removed', '{}', '2026-01-01T00:00:02.000Z', '{}')
    expect(
      (
        db.prepare('SELECT seq FROM facts ORDER BY seq').all() as unknown as Array<{ seq: number }>
      ).map((row) => row.seq),
    ).toEqual([1, 2, 3])

    // AUTOINCREMENT：删掉最大 seq 后不复用旧号
    db.prepare('DELETE FROM facts WHERE seq = 3').run()
    insert.run('task.created', '{}', '2026-01-01T00:00:03.000Z', '{}')
    expect(
      (db.prepare('SELECT MAX(seq) AS max FROM facts').get() as unknown as { max: number }).max,
    ).toBe(4)
  })

  it('facts 索引 type / cause', () => {
    const db = memoryDb()
    db.exec(FACTS_SQL)
    expect(indexShape(db, 'facts')).toEqual([
      'idx_facts_cause|unique=0|origin=c|partial=0|columns=cause',
      'idx_facts_type|unique=0|origin=c|partial=0|columns=type',
    ])
  })

  it('projection_meta 单行且列固定', () => {
    const db = memoryDb()
    db.exec(FACTS_SQL)
    const columns = db.prepare('PRAGMA table_info(projection_meta)').all() as unknown as Array<
      Record<string, unknown>
    >
    expect(columns.map((column) => String(column.name))).toEqual(['id', 'format', 'seq'])
    expect(columns.find((column) => column.name === 'id')?.pk).toBe(1)

    db.prepare('INSERT INTO projection_meta (id, format, seq) VALUES (1, ?, ?)').run('fmt', 0)
    expect(
      (
        db.prepare('SELECT format, seq FROM projection_meta').get() as unknown as {
          format: string
          seq: number
        }
      ).format,
    ).toBe('fmt')
    expect(() =>
      db.prepare('INSERT INTO projection_meta (id, format, seq) VALUES (2, ?, ?)').run('fmt', 0),
    ).toThrow()
  })

  it('FACTS_SQL 幂等：重复执行不报错、不清数据', () => {
    const db = memoryDb()
    db.exec(FACTS_SQL)
    db.prepare('INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)').run(
      'task.created',
      '{}',
      '2026-01-01T00:00:00.000Z',
      '{}',
    )
    expect(() => db.exec(FACTS_SQL)).not.toThrow()
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM facts').get() as unknown as { n: number }).n,
    ).toBe(1)
  })
})

describe('投影白名单与指纹', () => {
  it('白名单固定为十七张投影表（实体五表 + projects + 运行/聊天四表 + cards + 规则两表 + threads + plugin_settings + task_comments + review_reports）', () => {
    expect(PROJECTION_TABLES).toEqual([
      'tasks',
      'workflows',
      'workflow_stages',
      'agents',
      'runtimes',
      'projects',
      'runs',
      'run_events',
      'conversations',
      'messages',
      'cards',
      'rule_sets',
      'rule_fires',
      'threads',
      'plugin_settings',
      'task_comments',
      'review_reports',
    ])
  })

  it('host 与 kernel 两份投影表清单一致（顺序也一致，指纹/重建才能同源）', () => {
    expect(PROJECTION_TABLES).toEqual(KERNEL_PROJECTION_TABLES)
  })

  it('PROJECTION_DDL 覆盖十五表、取自 tableDdl、不含账本表', () => {
    for (const table of PROJECTION_TABLES) {
      expect(PROJECTION_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`)
    }
    expect(PROJECTION_DDL).toContain(tableDdl.tasks())
    expect(PROJECTION_DDL).toContain(tableDdl.stages())
    expect(PROJECTION_DDL).toContain(tableDdl.cards())
    expect(PROJECTION_DDL).toContain(tableDdl.ruleSets())
    expect(PROJECTION_DDL).toContain(tableDdl.ruleFires())
    expect(PROJECTION_DDL).toContain(tableDdl.threads())
    expect(PROJECTION_DDL).toContain(tableDdl.pluginSettings())
    expect(PROJECTION_DDL).toContain(tableDdl.taskComments())
    expect(PROJECTION_DDL).not.toContain('facts')
  })

  it('指纹 = sha256(十五表 DDL + 内核版本)', () => {
    const expected = createHash('sha256').update(`${PROJECTION_DDL}\nkernel-1`).digest('hex')
    expect(projectionFormat('kernel-1')).toBe(expected)
    expect(projectionFormat('kernel-1')).toMatch(/^[0-9a-f]{64}$/)
    expect(projectionFormat('kernel-1')).toBe(projectionFormat('kernel-1'))
    expect(projectionFormat('kernel-2')).not.toBe(projectionFormat('kernel-1'))
  })

  it('投影 DDL 改一个字符，指纹即不同', () => {
    const mutated = PROJECTION_DDL.replace(
      'position INTEGER NOT NULL',
      'position INTEGER NOT NULL ',
    )
    expect(mutated).not.toBe(PROJECTION_DDL)
    expect(formatOfProjection(mutated, 'kernel-1')).not.toBe(projectionFormat('kernel-1'))
  })
})

describe('cards 投影（M4）', () => {
  it('列顺序与 Card 行逐列对应', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(columnShape(db, 'cards').map((column) => column.split('|')[0])).toEqual([
      'id',
      'run_id',
      'task_id',
      'conversation_id',
      'title',
      'text',
      'kind',
      'options_json',
      'key',
      'version',
      'status',
      'delivery',
      'delivery_ref',
      'option_index',
      'answered_by',
      'answered_at',
      'created_at',
      'updated_at',
    ])
  })

  it('索引覆盖 status / run_id / delivery', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    const indexes = indexShape(db, 'cards')
    expect(indexes).toContain(
      'idx_cards_status|unique=0|origin=c|partial=0|columns=status,created_at',
    )
    expect(indexes).toContain('idx_cards_run|unique=0|origin=c|partial=0|columns=run_id,created_at')
    expect(indexes).toContain('idx_cards_delivery|unique=0|origin=c|partial=0|columns=delivery')
  })

  it('status / delivery / answered_by 由 CHECK 收口', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    db.exec(
      "INSERT INTO runs (id, status, executor_key, created_at) VALUES ('run-1', 'queued', 'dsh', '2026-01-01T00:00:00.000Z')",
    )
    db.exec(
      `INSERT INTO cards (id, run_id, title, status, delivery, created_at, updated_at)
       VALUES ('card-1', 'run-1', 't', 'open', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    expect(() => db.prepare("UPDATE cards SET status = 'done' WHERE id = 'card-1'").run()).toThrow()
    expect(() =>
      db.prepare("UPDATE cards SET delivery = 'sent' WHERE id = 'card-1'").run(),
    ).toThrow()
    expect(() =>
      db.prepare("UPDATE cards SET answered_by = 'agent' WHERE id = 'card-1'").run(),
    ).toThrow()
  })
})

describe('规则投影（M6）', () => {
  it('rule_sets 单行：列固定，id 只能是 current', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(columnShape(db, 'rule_sets').map((column) => column.split('|')[0])).toEqual([
      'id',
      'version',
      'replaced_at',
      'rules_json',
    ])
    db.prepare(
      "INSERT INTO rule_sets (id, version, replaced_at, rules_json) VALUES ('current', 1, ?, '[]')",
    ).run('2026-01-01T00:00:00.000Z')
    expect(() =>
      db
        .prepare(
          "INSERT INTO rule_sets (id, version, replaced_at, rules_json) VALUES ('current', 2, ?, '[]')",
        )
        .run('2026-01-01T00:00:01.000Z'),
    ).toThrow()
    expect(() =>
      db
        .prepare(
          "INSERT INTO rule_sets (id, version, replaced_at, rules_json) VALUES ('other', 1, ?, '[]')",
        )
        .run('2026-01-01T00:00:00.000Z'),
    ).toThrow()
  })

  it('rule_fires 纯追加：列固定、重复主键撞约束、无外键', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(columnShape(db, 'rule_fires').map((column) => column.split('|')[0])).toEqual([
      'id',
      'rule_id',
      'version',
      'scheduled_for',
      'fired_at',
      'task_id',
    ])
    const insert = db.prepare(
      `INSERT INTO rule_fires (id, rule_id, version, scheduled_for, fired_at, task_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insert.run('fire-1', 'rule-1', 1, '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:01.000Z', null)
    expect(() =>
      insert.run(
        'fire-1',
        'rule-1',
        1,
        '2026-01-01T10:00:00.000Z',
        '2026-01-01T10:00:01.000Z',
        'tk-1',
      ),
    ).toThrow()
    // 触发记录不因任务删除而消失：task_id 是弱引用，不设外键
    expect(foreignKeyShape(db, 'rule_fires')).toEqual([])
  })

  it('rule_fires 索引覆盖 (rule_id, scheduled_for)：cron 基线按计划时刻聚合', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(indexShape(db, 'rule_fires')).toContain(
      'idx_rule_fires_rule|unique=0|origin=c|partial=0|columns=rule_id,scheduled_for',
    )
  })
})

describe('线程投影（M6.5）', () => {
  it('threads 列顺序与 ThreadRow 逐列对应（JSON 列 + 时间列）', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(columnShape(db, 'threads').map((column) => column.split('|')[0])).toEqual([
      'id',
      'source',
      'external_ref',
      'title',
      'status',
      'task_ids_json',
      'root_task_ids_json',
      'concurrency',
      'notes_version',
      'notes_json',
      'events_json',
      'last_activity_at',
      'created_at',
    ])
    // 旧行缺省：JSON 列空数组、并发 1、笔记版本 0；`sessions` 不落列
    expect(
      db
        .prepare(
          `SELECT task_ids_json, root_task_ids_json, concurrency, notes_version, notes_json,
                  events_json
           FROM threads WHERE id = ?`,
        )
        .get('missing'),
    ).toBeUndefined()
    db.prepare(
      `INSERT INTO threads (id, source, title, status, last_activity_at, created_at)
       VALUES (?, ?, ?, 'open', ?, ?)`,
    ).run('th-default', 'manual', '隐式线程', SAMPLE_AT, SAMPLE_AT)
    expect(
      db
        .prepare(
          `SELECT task_ids_json, root_task_ids_json, concurrency, notes_version, notes_json,
                  events_json
           FROM threads WHERE id = 'th-default'`,
        )
        .get(),
    ).toEqual({
      task_ids_json: '[]',
      root_task_ids_json: '[]',
      concurrency: 1,
      notes_version: 0,
      notes_json: '[]',
      events_json: '[]',
    })
  })

  it('status 由 CHECK 收口（open / closed）', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    const insert = db.prepare(
      `INSERT INTO threads (id, source, title, status, last_activity_at, created_at)
       VALUES (?, 'github', '线程', ?, ?, ?)`,
    )
    insert.run('th-1', 'open', SAMPLE_AT, SAMPLE_AT)
    expect(() => insert.run('th-2', 'archived', SAMPLE_AT, SAMPLE_AT)).toThrow()
    expect(() =>
      db.prepare("UPDATE threads SET status = 'archived' WHERE id = 'th-1'").run(),
    ).toThrow()
  })

  it('idx_threads_key 覆盖 (source, external_ref)：按入口键找线程', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(indexShape(db, 'threads')).toContain(
      'idx_threads_key|unique=0|origin=c|partial=0|columns=source,external_ref',
    )
  })

  it('线程行无外键：任务 / 运行删除不抹掉线程历史', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(foreignKeyShape(db, 'threads')).toEqual([])
  })
})

describe('会话投影（M9 / M11）', () => {
  it('conversations 列：project_id 落在 agent_id 与 session_id 之间，可空、无 DEFAULT', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(columnShape(db, 'conversations').map((column) => column.split('|')[0])).toEqual([
      'id',
      'title',
      'agent_id',
      'project_id',
      'session_id',
      'archived_at',
      'created_at',
      'updated_at',
    ])
    const byName = new Map(
      columnShape(db, 'conversations').map((shape) => [shape.split('|')[0], shape] as const),
    )
    // 弱引用：可空、无默认值（NULL = 默认目录）
    expect(byName.get('project_id')).toBe('project_id|TEXT|0|null|0')
    expect(byName.get('archived_at')).toBe('archived_at|TEXT|0|null|0')
  })

  it('补列清单与 DDL 同步：M11 只给 conversations 加 project_id', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect([...CONVERSATIONS_M11_ADDED_COLUMNS]).toEqual(['project_id'])
    expect(CONVERSATIONS_M11_ADD_COLUMN_SQL.project_id).toBe(
      'ALTER TABLE conversations ADD COLUMN project_id TEXT',
    )
    // 直接执行补列语句（幂等前提：列的列不存在时才用）；这里验证语句与 DDL 列定义一致
    const memory = new DatabaseSync(':memory:')
    try {
      memory.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY)')
      memory.exec(CONVERSATIONS_M11_ADD_COLUMN_SQL.project_id)
      expect(columnShape(memory, 'conversations').map((column) => column.split('|')[0])).toEqual([
        'id',
        'project_id',
      ])
    } finally {
      memory.close()
    }
  })
})

describe('插件设置投影（M7）', () => {
  it('plugin_settings 单行：列固定，id 只能是 current', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(columnShape(db, 'plugin_settings').map((column) => column.split('|')[0])).toEqual([
      'id',
      'version',
      'replaced_at',
      'settings_json',
    ])
    const insert = db.prepare(
      `INSERT INTO plugin_settings (id, version, replaced_at, settings_json)
       VALUES (?, ?, ?, ?)`,
    )
    insert.run('current', 1, SAMPLE_AT, '[]')
    expect(() => insert.run('current', 2, SAMPLE_AT, '[]')).toThrow()
    expect(() => insert.run('other', 1, SAMPLE_AT, '[]')).toThrow()
  })
})

describe('withTx', () => {
  it('正常返回提交，并把回调结果透传', () => {
    const db = memoryDb()
    db.exec(FACTS_SQL)
    const result = withTx(db, () => {
      db.prepare('INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)').run(
        'task.created',
        '{}',
        '2026-01-01T00:00:00.000Z',
        '{}',
      )
      return 42
    })
    expect(result).toBe(42)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM facts').get() as unknown as { n: number }).n,
    ).toBe(1)
  })

  it('回调抛错则回滚并原样抛出', () => {
    const db = memoryDb()
    db.exec(FACTS_SQL)
    expect(() =>
      withTx(db, () => {
        db.prepare('INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)').run(
          'task.created',
          '{}',
          '2026-01-01T00:00:00.000Z',
          '{}',
        )
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM facts').get() as unknown as { n: number }).n,
    ).toBe(0)
  })
})
