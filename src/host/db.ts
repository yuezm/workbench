import { DatabaseSync } from 'node:sqlite'
import { FACTS_SQL, INDEX_SQL, SCHEMA_SQL, SCHEMA_VERSION, withTx } from './schema'

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
 * 打开（或创建）数据库文件并建好全库 schema：busy_timeout、打开时 integrity_check、
 * 文件库启用 WAL、五张业务表 + 运行/聊天表 + 账本表（全部 IF NOT EXISTS）、
 * `PRAGMA user_version = SCHEMA_VERSION`。
 *
 * 手写 v1 → v2 迁移已删除：v2 存量数据由 `host/store/import.ts` 写成 `snapshot.imported`
 * 事实后重建投影，因此这里只保证「库结构与当前版本对齐」。
 *
 * 不设置 foreign_keys：保持连接默认（node:sqlite 默认开启），组合方需要时自行切换。
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
    withTx(db, () => {
      db.exec(SCHEMA_SQL)
      db.exec(INDEX_SQL)
      db.exec(FACTS_SQL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
    return db
  } catch (e) {
    // 完整性检查或建表失败：关掉连接再抛，避免锁住数据库文件。
    // 构造函数在 try 之外，进入这里的连接一定还开着，直接关闭即可。
    db.close()
    throw e
  }
}
