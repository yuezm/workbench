/**
 * 宿主私有运行进程登记表（M2 T13 / D11）：`process_registry(run_id PK, pid, started_at)`。
 *
 * 只记录本机「此刻为哪些 run 起了子进程」——不是业务事实，不进投影白名单 / 指纹
 * （`host/schema.ts` 的 `process_registry` 注释说明为什么重建投影不清它）。
 *
 * 生命周期由调度器驱动：
 * 1. 执行开始（spawn 前）`begin()`：写占位行，`pid` 还为 NULL；
 * 2. 执行器拿到子进程 pid 后 `attachPid()` 回填；
 * 3. 执行结束（成功 / 失败 / 取消 / 兜底终态）`remove()` 删行。
 *
 * 崩溃时行会残留，由 `host/reconcile` 在下次启动时读取：先按 pid 终止进程树，
 * 再清表（见 `reconcile.ts`）。
 */
import type { DatabaseSync } from 'node:sqlite'

/** 一行登记：`pid` 为 NULL 表示进程还没起来（或执行器不需要子进程）。 */
export interface ProcessRegistryRow {
  runId: string
  pid: number | null
  startedAt: string
}

export interface ProcessRegistry {
  /** 执行开始（spawn 前）写占位行；同一 run 重跑时覆盖旧行 */
  begin(runId: string, startedAt: string): void
  /** 子进程 pid 到达后回填（占位行由 `begin` 保证存在；行不存在时静默忽略） */
  attachPid(runId: string, pid: number): void
  /** 执行结束 / 兜底终态写入后删除 */
  remove(runId: string): void
  /** 对账用：全部残留行（按 started_at、run_id 升序） */
  list(): ProcessRegistryRow[]
  /** 对账完成后清表（逐行处置之后调用） */
  clear(): void
}

interface RawRow {
  run_id: string
  pid: number | null
  started_at: string
}

export function createProcessRegistry(db: DatabaseSync): ProcessRegistry {
  return {
    begin(runId, startedAt) {
      db.prepare(
        `INSERT INTO process_registry (run_id, pid, started_at) VALUES (?, NULL, ?)
         ON CONFLICT(run_id) DO UPDATE SET pid = NULL, started_at = excluded.started_at`,
      ).run(runId, startedAt)
    },
    attachPid(runId, pid) {
      db.prepare('UPDATE process_registry SET pid = ? WHERE run_id = ?').run(pid, runId)
    },
    remove(runId) {
      db.prepare('DELETE FROM process_registry WHERE run_id = ?').run(runId)
    },
    list() {
      const rows = db
        .prepare('SELECT run_id, pid, started_at FROM process_registry ORDER BY started_at, run_id')
        .all() as unknown as RawRow[]
      return rows.map((row) => ({ runId: row.run_id, pid: row.pid, startedAt: row.started_at }))
    },
    clear() {
      db.prepare('DELETE FROM process_registry').run()
    },
  }
}
