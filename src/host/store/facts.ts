/**
 * 事实日志读写：只追加、按 seq 读取；列名逐个写死（不 `SELECT *`）。
 *
 * `seq` 由 SQLite `AUTOINCREMENT` 分配（见 host/schema.ts 的 FACTS_SQL），
 * 提交顺序即 seq 顺序；`payload` / `actor_json` 以 JSON 文本存放。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Actor, Fact, FactDraft, Seq } from '../../kernel/types'

interface FactRow {
  seq: number
  type: string
  actor_json: string
  at: string
  cause: number | null
  hops: number | null
  payload: string
}

const toFact = (row: FactRow): Fact => ({
  seq: row.seq,
  type: row.type as Fact['type'],
  actor: JSON.parse(row.actor_json) as Actor,
  at: row.at,
  cause: row.cause ?? undefined,
  hops: row.hops ?? undefined,
  payload: JSON.parse(row.payload) as Fact['payload'],
})

const SELECT_COLUMNS = 'SELECT seq, type, actor_json, at, cause, hops, payload FROM facts'

/** 当前最大 seq；空日志为 0（AUTOINCREMENT 从 1 起，0 可安全表示「还没有事实」）。 */
export function lastSeq(db: DatabaseSync): Seq {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM facts').get() as unknown as {
    seq: number
  }
  return row.seq
}

/**
 * 追加事实并返回带 seq 的完整事实（顺序即 drafts 顺序）。
 * 必须在调用方的事务内执行（与投影变更、投影元信息同一次提交）。
 */
export function appendFacts(db: DatabaseSync, drafts: readonly FactDraft[]): Fact[] {
  const insert = db.prepare(
    'INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES (?, ?, ?, ?, ?, ?)',
  )
  return drafts.map((draft) => {
    const result = insert.run(
      draft.type,
      JSON.stringify(draft.actor),
      draft.at,
      draft.cause ?? null,
      draft.hops ?? null,
      JSON.stringify(draft.payload),
    )
    return { ...draft, seq: Number(result.lastInsertRowid) }
  })
}

/** 全部事实，按 seq 升序（重建的 fold 输入）。 */
export function allFacts(db: DatabaseSync): Fact[] {
  const rows = db.prepare(`${SELECT_COLUMNS} ORDER BY seq`).all() as unknown as FactRow[]
  return rows.map(toFact)
}

/** seq 之后的事实（增量推 renderer / 增量投影），按 seq 升序。 */
export function factsSince(db: DatabaseSync, seq: Seq): Fact[] {
  const rows = db
    .prepare(`${SELECT_COLUMNS} WHERE seq > ? ORDER BY seq`)
    .all(seq) as unknown as FactRow[]
  return rows.map(toFact)
}

/**
 * 一段连续事实（命令幂等回放）：从 `firstSeq` 起取 `count` 条。
 * `count === 0`（零事实命令）直接返回空数组，不查库。
 */
export function factsBetween(db: DatabaseSync, firstSeq: Seq, count: number): Fact[] {
  if (count <= 0) return []
  const rows = db
    .prepare(`${SELECT_COLUMNS} WHERE seq >= ? AND seq < ? ORDER BY seq`)
    .all(firstSeq, firstSeq + count) as unknown as FactRow[]
  return rows.map(toFact)
}

export function factsCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM facts').get() as unknown as { n: number }
  return row.n
}
