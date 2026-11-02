import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL } from './schema'

/**
 * 打开（或创建）ai-workflow 数据库并确保 schema 就绪。
 * @param filePath SQLite 文件路径；`:memory:` 用于测试。
 */
export function openDb(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return db
}
