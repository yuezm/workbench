import type { DatabaseSync } from 'node:sqlite'
import { INDEX_SQL, SCHEMA_SQL, SCHEMA_VERSION, tableDdl } from './schema'

/** 读取当前 schema 版本（user_version）。 */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as
    { user_version: number } | undefined
  return row?.user_version ?? 0
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as unknown as { name: string } | undefined
  return row !== undefined
}

function tableColumns(db: DatabaseSync, name: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as unknown as Array<{
    name: string
  }>
  return rows.map((r) => r.name)
}

/**
 * v1 → v2：重建 runtimes / runs / chat_conversations，新增 run_events。
 *
 * 重建（而不是 ADD/DROP COLUMN）是因为 v2 删掉了 v1 的
 * kind / args_template / prompt_mode，且新增列带 CHECK 约束。
 * 步骤与 SQLite 官方 12-step 一致：建新表 → 拷数据 → 删旧表 → 重命名。
 */
function upgradeV1ToV2(db: DatabaseSync): void {
  // runtimes：保留 id/name/command/workdir/created_at，其余取 v2 默认值
  db.exec(tableDdl.runtimes('runtimes_v2'))
  db.exec(`
    INSERT INTO runtimes_v2
      (id, name, protocol_family, command, profile, permission_mode,
       model, reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at)
    SELECT id, name, 'dsh', command, 'multica', 'workspace-write',
           NULL, NULL, workdir, 1, 1, NULL, created_at
    FROM runtimes
  `)
  db.exec('DROP TABLE runtimes')
  db.exec('ALTER TABLE runtimes_v2 RENAME TO runtimes')

  // runs：历史错误统一归为「非零退出」（v1 只知道退出码）
  db.exec(tableDdl.runs('runs_v2'))
  db.exec(`
    INSERT INTO runs_v2
      (id, task_id, stage_id, agent_id, runtime_id, status, prompt, output,
       error, error_code, exit_code, session_id, usage_json, duration_ms,
       started_at, ended_at, created_at)
    SELECT id, task_id, stage_id, agent_id, NULL, status, prompt, output,
           error,
           CASE WHEN error IS NOT NULL AND status = 'failed' THEN 'exit_nonzero' ELSE NULL END,
           NULL, NULL, NULL, NULL,
           started_at, ended_at, created_at
    FROM runs
  `)
  db.exec('DROP TABLE runs')
  db.exec('ALTER TABLE runs_v2 RENAME TO runs')

  // 对话：新增 session_id（v1 每轮重发全部历史，没有会话可续接）
  db.exec(tableDdl.conversations('chat_conversations_v2'))
  db.exec(`
    INSERT INTO chat_conversations_v2 (id, title, agent_id, session_id, created_at, updated_at)
    SELECT id, title, agent_id, NULL, created_at, updated_at
    FROM chat_conversations
  `)
  db.exec('DROP TABLE chat_conversations')
  db.exec('ALTER TABLE chat_conversations_v2 RENAME TO chat_conversations')

  // 事件表是 v2 新增的
  db.exec(tableDdl.runEvents())
}

/**
 * 打开数据库时把 schema 迁移到当前版本。
 *
 * - 空库：直接建 v2 全量 schema。
 * - v1 库（有 runtimes 但没有 user_version / protocol_family）：重建为 v2，保留数据。
 * - 已是 v2：幂等返回。
 *
 * @param db 已打开的数据库连接
 */
export function migrate(db: DatabaseSync): void {
  const version = schemaVersion(db)
  if (version === SCHEMA_VERSION) return
  if (version > SCHEMA_VERSION) {
    throw new Error(`数据库 schema 版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}`)
  }

  const fresh = !hasTable(db, 'runtimes')
  const isV1 = !fresh && !tableColumns(db, 'runtimes').includes('protocol_family')

  // 重建父表期间必须关外键；PRAGMA 在事务内无效，所以放在 BEGIN 之前
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    try {
      if (fresh) {
        db.exec(SCHEMA_SQL)
      } else if (isV1) {
        upgradeV1ToV2(db)
        // 重建的表没有索引：补齐（IF NOT EXISTS，不影响未重建的表）
        db.exec(INDEX_SQL)
      } else {
        // 结构已是 v2，只是版本号落后：补齐索引与版本号
        db.exec(INDEX_SQL)
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
