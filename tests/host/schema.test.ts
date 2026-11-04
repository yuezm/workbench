// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FACTS_SQL,
  PROJECTION_DDL,
  PROJECTION_TABLES,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  formatOfProjection,
  projectionFormat,
  tableDdl,
  withTx,
} from '../../src/host/schema'

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

const FIVE_TABLES = ['tasks', 'workflows', 'workflow_stages', 'agents', 'runtimes']

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

describe('五张投影表与改前 DDL 一致', () => {
  it('逐列一致（列名 / 类型 / NOT NULL / 默认值 / 主键）', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)
    legacy.exec(PRE_M1_FIVE_TABLE_INDEXES)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    expect(SCHEMA_VERSION).toBe(2)
    for (const table of FIVE_TABLES) {
      expect(columnShape(current, table), table).toEqual(columnShape(legacy, table))
    }
  })

  it('索引与唯一约束一致', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)
    legacy.exec(PRE_M1_FIVE_TABLE_INDEXES)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    for (const table of FIVE_TABLES) {
      expect(indexShape(current, table), table).toEqual(indexShape(legacy, table))
    }
  })

  it('外键与删除动作一致', () => {
    const legacy = memoryDb()
    legacy.exec(PRE_M1_FIVE_TABLE_DDL)
    legacy.exec(PRE_M1_FIVE_TABLE_INDEXES)

    const current = memoryDb()
    current.exec(SCHEMA_SQL)

    for (const table of FIVE_TABLES) {
      expect(foreignKeyShape(current, table), table).toEqual(foreignKeyShape(legacy, table))
    }
  })

  it('SCHEMA_SQL 建 9 张表：九张投影（旧聊天表已由 T14b 迁成事实并删除）', () => {
    const db = memoryDb()
    db.exec(SCHEMA_SQL)
    expect(tableNames(db)).toEqual([
      'agents',
      'conversations',
      'messages',
      'run_events',
      'runs',
      'runtimes',
      'tasks',
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
  it('白名单固定为九张投影表（实体五表 + 运行/聊天四表）', () => {
    expect(PROJECTION_TABLES).toEqual([
      'tasks',
      'workflows',
      'workflow_stages',
      'agents',
      'runtimes',
      'runs',
      'run_events',
      'conversations',
      'messages',
    ])
  })

  it('PROJECTION_DDL 覆盖五表、取自 tableDdl、不含账本表', () => {
    for (const table of PROJECTION_TABLES) {
      expect(PROJECTION_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`)
    }
    expect(PROJECTION_DDL).toContain(tableDdl.tasks())
    expect(PROJECTION_DDL).toContain(tableDdl.stages())
    expect(PROJECTION_DDL).not.toContain('facts')
  })

  it('指纹 = sha256(九表 DDL + 内核版本)', () => {
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
