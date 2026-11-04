import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrate'

/**
 * 打开（或创建）ai-workflow 数据库并迁移到当前 schema 版本。
 * @param filePath SQLite 文件路径；`:memory:` 用于测试。
 */
export function openDb(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    migrate(db)
    db.exec('PRAGMA foreign_keys = ON')
    return db
  } catch (e) {
    // 迁移失败：关掉连接再抛，避免锁住数据库文件
    db.close()
    throw e
  }
}
