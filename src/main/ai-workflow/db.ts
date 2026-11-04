import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../host/db'
import { migrate } from './migrate'

/**
 * 打开（或创建）ai-workflow 数据库并迁移到当前 schema 版本。
 *
 * 组合 host/db 的开库基础设施（busy_timeout / integrity_check / WAL / facts 建表），
 * 再在关闭外键的窗口内执行 v1 → v2 迁移；失败时关闭连接再抛，避免锁住数据库文件。
 *
 * @param filePath SQLite 文件路径；`:memory:` 用于测试。
 */
export function openDb(filePath: string): DatabaseSync {
  const db = openDatabase(filePath)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    migrate(db)
    db.exec('PRAGMA foreign_keys = ON')
    return db
  } catch (e) {
    db.close()
    throw e
  }
}
