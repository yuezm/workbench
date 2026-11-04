// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './db'
import { SCHEMA_SQL } from './schema'

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
  it('创建全部 9 张表', () => {
    db = openDb(':memory:')
    expect(tableNames(db)).toEqual([
      'agents',
      'chat_conversations',
      'chat_messages',
      'run_events',
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
    expect(() => db!.exec(SCHEMA_SQL)).not.toThrow()
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
