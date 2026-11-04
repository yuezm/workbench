import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../host/db'

/**
 * 打开（或创建）ai-workflow 数据库。
 *
 * 过渡期薄封装：schema 建表、PRAGMA、失败关闭都在 `host/db.ts` 的 `openDatabase`；
 * 手写 v1 → v2 迁移已删除，v2 存量改由 `host/store/import.ts` 写成 `snapshot.imported`。
 *
 * @param filePath SQLite 文件路径；`:memory:` 用于测试。
 */
export function openDb(filePath: string): DatabaseSync {
  return openDatabase(filePath)
}
