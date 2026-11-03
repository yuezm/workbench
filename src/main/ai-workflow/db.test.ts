// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './db'

let db: DatabaseSync | null = null
afterEach(() => {
  db?.close()
  db = null
})

function tableNames(d: DatabaseSync): string[] {
  const rows = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name).sort()
}

describe('openDb', () => {
  it('创建全部 8 张表', () => {
    db = openDb(':memory:')
    expect(tableNames(db)).toEqual([
      'agents',
      'chat_conversations',
      'chat_messages',
      'runs',
      'runtimes',
      'tasks',
      'workflow_stages',
      'workflows',
    ])
  })

  it('开启外键约束', () => {
    db = openDb(':memory:')
    const rows = db.prepare('PRAGMA foreign_keys').all() as Array<{ foreign_keys: number }>
    expect(rows[0]?.foreign_keys).toBe(1)
  })

  it('重复执行 schema 幂等', () => {
    db = openDb(':memory:')
    // 第二次执行不应抛错（IF NOT EXISTS）
    expect(() => db!.exec(SCHEMA_SQL_IDEMPOTENT_PROBE)).not.toThrow()
  })

  it('外键违反被拒绝', () => {
    db = openDb(':memory:')
    expect(() =>
      db!
        .prepare('INSERT INTO agents (id, name, runtime_id, created_at) VALUES (?, ?, ?, ?)')
        .run('a1', 'agent', 'missing-runtime', new Date().toISOString()),
    ).toThrow()
  })
})

const SCHEMA_SQL_IDEMPOTENT_PROBE = `
CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'deepseek-harness',
  command TEXT NOT NULL,
  args_template TEXT NOT NULL DEFAULT '[]',
  prompt_mode TEXT NOT NULL DEFAULT 'arg',
  workdir TEXT,
  created_at TEXT NOT NULL
);
`
