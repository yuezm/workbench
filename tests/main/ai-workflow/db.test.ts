// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../../../src/main/ai-workflow/db'
import { SCHEMA_SQL } from '../../../src/main/ai-workflow/schema'

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
  it('创建全部 13 张表（九张投影 + 两张过渡期 legacy chat + 账本）', () => {
    db = openDb(':memory:')
    expect(tableNames(db)).toEqual([
      'agents',
      'chat_conversations',
      'chat_messages',
      'conversations',
      'facts',
      'messages',
      'projection_meta',
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

  it(':memory: 库可正常打开（WAL 不适用，不报错）', () => {
    db = openDb(':memory:')
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as unknown as { n: number }).n,
    ).toBe(0)
    expect(
      (db.prepare('PRAGMA integrity_check').get() as unknown as { integrity_check: string })
        .integrity_check,
    ).toBe('ok')
  })

  it('文件库启用 WAL 并设置 busy_timeout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwf-wal-'))
    const file = path.join(root, 'ai-workflow.db')
    const local = openDb(file)
    try {
      expect(
        (local.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string })
          .journal_mode,
      ).toBe('wal')
      expect(
        (local.prepare('PRAGMA busy_timeout').get() as unknown as { timeout: number }).timeout,
      ).toBe(5000)
      // WAL 真正落盘：迁移写入后主库旁应有 -wal 侧车
      expect(existsSync(`${file}-wal`)).toBe(true)
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('完整性检查失败：关闭连接并抛出可读错误', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwf-corrupt-'))
    const file = path.join(root, 'ai-workflow.db')
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
      expect(() => openDb(file)).toThrow(/数据库完整性检查失败/)
      // 抛错前连接已关闭：Windows 上句柄未释放时删除会 EBUSY
      expect(() => rmSync(file, { force: true })).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
