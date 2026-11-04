/**
 * 投影元信息（指纹 + 已折叠 seq）与重建。
 *
 * 触发条件（SPEC-host「存储与单实例」）：`format` 与当前「投影 DDL + 内核版本」算出的
 * 指纹不符，或 `meta.seq` 落后于 `max(facts.seq)`。
 *
 * 重建清空白名单九表（实体五表 + runs / run_events / conversations / messages），
 * 再按 seq 顺序重放全部事实。为了让清 `tasks` 不级联删掉运行记录
 * （`runs.task_id ON DELETE CASCADE`），重建事务外临时关闭外键、结束后在 `finally`
 * 里恢复；`run_events` / `messages` 的删除顺序由 writer 的 `clear()` 固定。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { KernelPort } from '../../kernel/types'
import { KERNEL_VERSION } from '../../kernel/types'
import { projectionFormat, withTx } from '../schema'
import { allFacts, lastSeq } from './facts'
import { createProjectionWriter, type ProjectionWrite } from './projection-apply'

export interface ProjectionMeta {
  format: string
  seq: number
}

/** 读投影元信息；新库尚未写过返回 null。 */
export function readProjectionMeta(db: DatabaseSync): ProjectionMeta | null {
  const row = db
    .prepare('SELECT format, seq FROM projection_meta WHERE id = 1')
    .get() as unknown as ProjectionMeta | undefined
  return row ?? null
}

export function writeProjectionMeta(db: DatabaseSync, format: string, seq: number): void {
  db.prepare(
    `INSERT INTO projection_meta (id, format, seq) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET format = excluded.format, seq = excluded.seq`,
  ).run(format, seq)
}

/** 当前内核版本的投影指纹（与 host/schema.ts 的 PROJECTION_DDL 绑定）。 */
export function currentProjectionFormat(): string {
  return projectionFormat(KERNEL_VERSION)
}

interface ForeignKeysRow {
  foreign_keys: number
}

const readForeignKeys = (db: DatabaseSync): boolean => {
  const row = db.prepare('PRAGMA foreign_keys').get() as unknown as ForeignKeysRow
  return row.foreign_keys === 1
}

/** 强制重建：清空白名单九表 → 按 seq 顺序 fold `project` → 写回元信息（单事务）。 */
export function rebuildProjection(db: DatabaseSync, kernel: KernelPort): void {
  const format = currentProjectionFormat()
  const facts = allFacts(db)
  const writes: ProjectionWrite[] = []
  for (const fact of facts) {
    for (const change of kernel.project(fact)) writes.push({ change, at: fact.at })
  }
  const writer = createProjectionWriter(db)
  const foreignKeys = readForeignKeys(db)
  if (foreignKeys) db.exec('PRAGMA foreign_keys = OFF')
  try {
    withTx(db, () => {
      writer.clear()
      writer.applyAll(writes)
      writeProjectionMeta(db, format, lastSeq(db))
    })
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys = ON')
  }
}

export interface EnsureProjectionResult {
  rebuilt: boolean
}

/**
 * 启动对账：指纹失配或 seq 落后则重建。
 *
 * 全新的空库（facts 0 条且还没有 meta）只写一条 `{ format, seq: 0 }` 元信息，
 * 不清表——刚建库时本来就没有投影可清。
 */
export function ensureProjection(db: DatabaseSync, kernel: KernelPort): EnsureProjectionResult {
  const meta = readProjectionMeta(db)
  const seq = lastSeq(db)
  if (meta === null && seq === 0) {
    writeProjectionMeta(db, currentProjectionFormat(), 0)
    return { rebuilt: false }
  }
  if (meta !== null && meta.format === currentProjectionFormat() && meta.seq >= seq) {
    return { rebuilt: false }
  }
  rebuildProjection(db, kernel)
  return { rebuilt: true }
}
