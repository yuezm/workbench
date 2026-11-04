// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/host/db'
import { SCHEMA_SQL, SCHEMA_VERSION } from '../../src/host/schema'

let db: DatabaseSync | null = null
afterEach(() => {
  db?.close()
  db = null
})

function tableNames(d: DatabaseSync): string[] {
  const rows = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>
  return rows.map((row) => row.name).sort()
}

function userVersion(d: DatabaseSync): number {
  return (d.prepare('PRAGMA user_version').get() as unknown as { user_version: number })
    .user_version
}

describe('openDatabase', () => {
  it(':memory: 建全 schema（9 张业务表 + facts / projection_meta）并写 user_version', () => {
    db = openDatabase(':memory:')
    expect(tableNames(db)).toEqual([
      'agents',
      'chat_conversations',
      'chat_messages',
      'facts',
      'projection_meta',
      'run_events',
      'runs',
      'runtimes',
      'tasks',
      'workflow_stages',
      'workflows',
    ])
    expect(userVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('不动 foreign_keys：保持连接默认（node:sqlite 默认开启外键约束）', () => {
    db = openDatabase(':memory:')
    const rows = db.prepare('PRAGMA foreign_keys').all() as unknown as Array<{
      foreign_keys: number
    }>
    expect(rows[0]?.foreign_keys).toBe(1)
  })

  it('外键约束生效：引用不存在的运行时被拒绝', () => {
    db = openDatabase(':memory:')
    expect(() =>
      db!
        .prepare('INSERT INTO agents (id, name, runtime_id, created_at) VALUES (?, ?, ?, ?)')
        .run('ag1', 'agent', 'missing-runtime', '2026-01-01T00:00:00.000Z'),
    ).toThrow()
  })

  it('已有 v2 旧库：不重建、不清数据，user_version 保持当前版本', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-legacy-'))
    const file = path.join(root, 'ai-workflow.db')
    const seeded = new DatabaseSync(file)
    try {
      seeded.exec(SCHEMA_SQL)
      seeded.exec('PRAGMA user_version = 2')
      seeded
        .prepare('INSERT INTO runtimes (id, name, created_at) VALUES (?, ?, ?)')
        .run('rt1', '旧运行时', '2026-01-01T00:00:00.000Z')
    } finally {
      seeded.close()
    }

    const local = openDatabase(file)
    try {
      expect(tableNames(local)).toEqual([
        'agents',
        'chat_conversations',
        'chat_messages',
        'facts',
        'projection_meta',
        'run_events',
        'runs',
        'runtimes',
        'tasks',
        'workflow_stages',
        'workflows',
      ])
      expect(
        (local.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as unknown as { n: number }).n,
      ).toBe(1)
      expect(userVersion(local)).toBe(SCHEMA_VERSION)
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('结构已是 v2 但版本号落后：补索引与版本号，数据保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-version-'))
    const file = path.join(root, 'ai-workflow.db')
    const seeded = new DatabaseSync(file)
    try {
      seeded.exec(SCHEMA_SQL)
      seeded.exec('PRAGMA user_version = 0')
      seeded
        .prepare('INSERT INTO runtimes (id, name, created_at) VALUES (?, ?, ?)')
        .run('rt1', '旧运行时', '2026-01-01T00:00:00.000Z')
    } finally {
      seeded.close()
    }

    const local = openDatabase(file)
    try {
      expect(userVersion(local)).toBe(SCHEMA_VERSION)
      expect(
        (local.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as unknown as { n: number }).n,
      ).toBe(1)
      expect(
        (
          local
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_workflow'",
            )
            .get() as unknown as { name: string } | undefined
        )?.name,
      ).toBe('idx_tasks_workflow')
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('重复打开幂等：账本表与已有事实保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-reopen-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      const first = openDatabase(file)
      try {
        first
          .prepare('INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)')
          .run('task.created', '{}', '2026-01-01T00:00:00.000Z', '{}')
      } finally {
        first.close()
      }
      const second = openDatabase(file)
      try {
        expect(
          (second.prepare('SELECT COUNT(*) AS n FROM facts').get() as unknown as { n: number }).n,
        ).toBe(1)
      } finally {
        second.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('文件库启用 WAL 并设置 busy_timeout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-wal-'))
    const file = path.join(root, 'workbench.db')
    const local = openDatabase(file)
    try {
      expect(
        (local.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string })
          .journal_mode,
      ).toBe('wal')
      expect(
        (local.prepare('PRAGMA busy_timeout').get() as unknown as { timeout: number }).timeout,
      ).toBe(5000)
      expect(
        (local.prepare('PRAGMA integrity_check').get() as unknown as { integrity_check: string })
          .integrity_check,
      ).toBe('ok')
      // WAL 真正落盘：建表写入后主库旁应有 -wal 侧车
      expect(existsSync(`${file}-wal`)).toBe(true)
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('完整性检查失败：关闭连接并抛出可读错误', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-corrupt-'))
    const file = path.join(root, 'workbench.db')
    const seeded = new DatabaseSync(file)
    const pageSize = (seeded.prepare('PRAGMA page_size').get() as unknown as { page_size: number })
      .page_size
    try {
      seeded.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
      const insert = seeded.prepare('INSERT INTO payload (body) VALUES (?)')
      seeded.exec('BEGIN')
      for (let i = 0; i < 200; i++) insert.run('x'.repeat(300))
      seeded.exec('COMMIT')
    } finally {
      seeded.close()
    }
    // 只破坏最后一个数据页（文件头与 schema 页保持合法）：仍能打开，但 integrity_check 必然非 ok
    const buf = readFileSync(file)
    for (let i = buf.length - pageSize + 12; i < buf.length; i++) buf[i] = 0xab
    writeFileSync(file, buf)

    try {
      expect(() => openDatabase(file)).toThrow(/数据库完整性检查失败/)
      // 抛错前连接已关闭：Windows 上句柄未释放时删除会 EBUSY
      expect(() => rmSync(file, { force: true })).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
