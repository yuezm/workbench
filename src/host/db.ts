import { DatabaseSync } from 'node:sqlite'
import { FACTS_SQL, withTx } from './schema'

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
 * 打开（或创建）数据库文件并建立账本基础设施，不含 schema 迁移、不设置 foreign_keys：
 * busy_timeout、打开时 integrity_check、文件库启用 WAL、facts / projection_meta 建表。
 *
 * 迁移与 foreign_keys 由调用方组合（过渡期是 main/ai-workflow/db.ts 的 openDb），
 * host 侧不反向依赖 main。
 *
 * `:memory:` 没有 WAL（SQLite 会把 journal_mode 设成 memory），不在此分支处理。
 *
 * @param filePath SQLite 文件路径；`:memory:` 用于测试。
 */
export function openDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    assertIntegrity(db, filePath)
    if (filePath !== ':memory:') {
      db.prepare('PRAGMA journal_mode = WAL').get()
    }
    withTx(db, () => db.exec(FACTS_SQL))
    return db
  } catch (e) {
    // 完整性检查或建表失败：关掉连接再抛，避免锁住数据库文件。
    // 构造函数在 try 之外，进入这里的连接一定还开着，直接关闭即可。
    db.close()
    throw e
  }
}
