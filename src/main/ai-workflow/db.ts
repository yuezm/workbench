import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrate'

/** 忙等超时（毫秒）：并发写时等锁，而不是立刻抛 SQLITE_BUSY。 */
const BUSY_TIMEOUT_MS = 5000

/**
 * 打开时校验数据库完整性。正常只返回一行 `ok`；
 * 损坏时可能返回多行诊断（也可能是 `database disk image is malformed` 这一行）。
 */
function assertIntegrity(db: DatabaseSync, filePath: string): void {
  const rows = db.prepare('PRAGMA integrity_check').all() as unknown as Array<{
    integrity_check: string
  }>
  const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok'
  if (!ok) {
    const detail = rows.map((row) => row.integrity_check).join('; ')
    throw new Error(`数据库完整性检查失败（${filePath}）：${detail}`)
  }
}

/**
 * 打开（或创建）ai-workflow 数据库并迁移到当前 schema 版本。
 *
 * 可靠性项：设置 busy_timeout；文件库启用 WAL；打开时做 integrity_check。
 * `:memory:` 没有 WAL（SQLite 会把 journal_mode 设成 memory），不在此分支处理。
 *
 * @param filePath SQLite 文件路径；`:memory:` 用于测试。
 */
export function openDb(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    assertIntegrity(db, filePath)
    if (filePath !== ':memory:') {
      db.prepare('PRAGMA journal_mode = WAL').get()
    }
    db.exec('PRAGMA foreign_keys = OFF')
    migrate(db)
    db.exec('PRAGMA foreign_keys = ON')
    return db
  } catch (e) {
    // 迁移或完整性检查失败：关掉连接再抛，避免锁住数据库文件。
    // 构造函数在 try 之外，进入这里的连接一定还开着，直接关闭即可。
    db.close()
    throw e
  }
}
