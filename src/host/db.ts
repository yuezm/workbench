import { DatabaseSync } from 'node:sqlite'
import {
  COMMANDS_SQL,
  FACTS_SQL,
  INDEX_SQL,
  PROCESS_REGISTRY_SQL,
  RUN_M2_ADDED_COLUMNS,
  RUNTIMES_M3_ADDED_COLUMNS,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  TASKS_M6_ADDED_COLUMNS,
  TASKS_M6_ADD_COLUMN_SQL,
  TASKS_M65_ADDED_COLUMNS,
  TASKS_M65_ADD_COLUMN_SQL,
  legacyRunsCopySql,
  legacyRuntimesCopySql,
  tableDdl,
  withTx,
} from './schema'

/** 忙等超时（毫秒）：并发写时等锁，而不是立刻抛 SQLITE_BUSY。 */
const BUSY_TIMEOUT_MS = 5000

/** 旧 `runs` 升级时的临时表名（事务内建 → 拷 → 删旧 → 改名；失败整体回滚）。 */
const RUN_UPGRADE_TEMP = 'runs_m2_upgrade'

/** 旧 `runtimes` 升级时的临时表名（M3 同法）。 */
const RUNTIMES_UPGRADE_TEMP = 'runtimes_m3_upgrade'

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

/** 表的列名集合；表不存在时返回空集合。 */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string
  }>
  return new Set(rows.map((row) => row.name))
}

interface ForeignKeysRow {
  foreign_keys: number
}

const readForeignKeys = (db: DatabaseSync): boolean => {
  const row = db.prepare('PRAGMA foreign_keys').get() as unknown as ForeignKeysRow
  return row.foreign_keys === 1
}

/**
 * 旧库 `runs` 缺 M2 新列 → 需要一次性物理升级。
 *
 * `CREATE TABLE IF NOT EXISTS runs` 只对新建库生效：M1/v2 旧库的旧 `runs` 表列不变，
 * 首次启动 `backfillRuns` 写新列会失败，所以必须在 open 阶段重建。
 *
 * 导出以便单测直接覆盖「表不存在（空列集合）→ 不升级」分支：`openDatabase` 的公共
 * 路径总会先建表，这个分支经公共 API 不可达。
 */
export function needsRunsUpgrade(db: DatabaseSync): boolean {
  const columns = tableColumns(db, 'runs')
  if (columns.size === 0) return false
  return RUN_M2_ADDED_COLUMNS.some((column) => !columns.has(column))
}

/**
 * 旧 `runs` 一次性物理升级（M2）：建新结构临时表 → 拷贝旧行并补默认值 → 删旧表 → 改名。
 *
 * 用「建临时表 + 改名」而不是 `ALTER TABLE runs RENAME`：后者会让 SQLite 重写
 * `run_events` 的外键引用指向临时表名，删旧表后引用就悬空了。这里全程
 * `PRAGMA foreign_keys = OFF`（必须在事务外设置，事务内是 no-op），失败时 `withTx`
 * 回滚、旧表与数据原样保留。已升级库再打开时列齐全，直接 no-op。
 *
 * @returns 本次是否真的做了升级
 */
function upgradeLegacyRuns(db: DatabaseSync): boolean {
  if (!needsRunsUpgrade(db)) return false

  const foreignKeys = readForeignKeys(db)
  if (foreignKeys) db.exec('PRAGMA foreign_keys = OFF')
  try {
    withTx(db, () => {
      db.exec(`DROP TABLE IF EXISTS ${RUN_UPGRADE_TEMP}`)
      db.exec(tableDdl.runs(RUN_UPGRADE_TEMP))
      db.exec(legacyRunsCopySql(RUN_UPGRADE_TEMP))
      db.exec('DROP TABLE runs')
      db.exec(`ALTER TABLE ${RUN_UPGRADE_TEMP} RENAME TO runs`)
    })
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys = ON')
  }
  return true
}

/**
 * 旧库 `runtimes` 缺 M3 新列 → 需要一次性物理升级（导出原因同 `needsRunsUpgrade`）。
 */
export function needsRuntimesUpgrade(db: DatabaseSync): boolean {
  const columns = tableColumns(db, 'runtimes')
  if (columns.size === 0) return false
  return RUNTIMES_M3_ADDED_COLUMNS.some((column) => !columns.has(column))
}

/**
 * 旧 `runtimes` 一次性物理升级（M3）：结构从 `protocol_family`（带 CHECK）换成
 * `executor_key` + `args_template`。旧列被 CHECK 引用，SQLite 不能 `DROP COLUMN`，
 * 因此与 `runs` 同法：建临时表 → 拷贝旧行（协议族映射成执行器键）→ 删旧表 → 改名。
 *
 * @returns 本次是否真的做了升级
 */
function upgradeLegacyRuntimes(db: DatabaseSync): boolean {
  if (!needsRuntimesUpgrade(db)) return false

  const foreignKeys = readForeignKeys(db)
  if (foreignKeys) db.exec('PRAGMA foreign_keys = OFF')
  try {
    withTx(db, () => {
      db.exec(`DROP TABLE IF EXISTS ${RUNTIMES_UPGRADE_TEMP}`)
      db.exec(tableDdl.runtimes(RUNTIMES_UPGRADE_TEMP))
      db.exec(legacyRuntimesCopySql(RUNTIMES_UPGRADE_TEMP))
      db.exec('DROP TABLE runtimes')
      db.exec(`ALTER TABLE ${RUNTIMES_UPGRADE_TEMP} RENAME TO runtimes`)
    })
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys = ON')
  }
  return true
}

/**
 * `tasks` 的补列清单与语句：M6（来源四列）+ M6.5（线程两列）同一机制。
 *
 * 打开旧库时按 `PRAGMA table_info(tasks)` 做差集检测；缺任一列即用 `ALTER TABLE ADD COLUMN`
 * 补齐，**不重建表**（原因见 `TASKS_M6_ADDED_COLUMNS` 的说明）。
 */
const TASKS_ADDED_COLUMNS = [...TASKS_M6_ADDED_COLUMNS, ...TASKS_M65_ADDED_COLUMNS] as const

type TaskAddedColumn = (typeof TASKS_ADDED_COLUMNS)[number]

const TASKS_ADD_COLUMN_SQL: Readonly<Record<TaskAddedColumn, string>> = {
  ...TASKS_M6_ADD_COLUMN_SQL,
  ...TASKS_M65_ADD_COLUMN_SQL,
}

/**
 * 旧库 `tasks` 缺 M6 / M6.5 新列 → 需要一次性补列（导出原因同 `needsRunsUpgrade`）。
 */
export function needsTasksUpgrade(db: DatabaseSync): boolean {
  const columns = tableColumns(db, 'tasks')
  if (columns.size === 0) return false
  return TASKS_ADDED_COLUMNS.some((column) => !columns.has(column))
}

/**
 * 旧 `tasks` 一次性补列（M6 / M6.5）：只对缺失列 `ALTER TABLE ADD COLUMN`，**不重建表**。
 *
 * `runs.task_id` 引用 `tasks(id)`，建临时表 + 改名会让 SQLite 把其它表里的外键引用
 * 改写成临时表名，删旧表后引用悬空（见 `upgradeLegacyRuns` 的注释）。补列只增不改：
 * 旧行按默认值得到 `origin='manual'`、空 `rule_id` / `external_ref`、空 `labels_json`，
 * 以及 `thread_id` / `parent_task_id` 为 null。事务内任一条失败整体回滚，旧结构原样保留。
 *
 * @returns 本次是否真的做了补列
 */
function upgradeLegacyTasks(db: DatabaseSync): boolean {
  const columns = tableColumns(db, 'tasks')
  const missing = TASKS_ADDED_COLUMNS.filter((column) => !columns.has(column))
  if (missing.length === 0) return false
  withTx(db, () => {
    for (const column of missing) db.exec(TASKS_ADD_COLUMN_SQL[column])
  })
  return true
}

/**
 * 打开（或创建）数据库文件并建好全库 schema：busy_timeout、打开时 integrity_check、
 * 文件库启用 WAL、十三张投影表 + 账本表（全部 IF NOT EXISTS）、
 * 宿主私有 `process_registry`（T13）、旧库 `runs`（M2）/`runtimes`（M3）结构升级与
 * `tasks`（M6 / M6.5）补列、`PRAGMA user_version = SCHEMA_VERSION`。
 *
 * 手写 v1 → v2 迁移已删除：v2 存量数据由 `host/store/import.ts` 写成 `snapshot.imported`
 * 事实后重建投影，因此这里只保证「库结构与当前版本对齐」；结构升级必须在导入事实之前完成，
 * 导入/回填才能写新列。
 *
 * 旧库一次性升级（`upgradeLegacyRuns` / `upgradeLegacyRuntimes`）与 v2 存量迁移
 * （`host/store/import.ts` 的导入根 / 旧聊天表）是 M2/M3 兼容层，只在旧库首次打开时触发；
 * 删除前提是「真实库已完成一次首启、facts 非空」（见 M3 退出记录，M3 不删）。
 *
 * 不设置 foreign_keys：保持连接默认（node:sqlite 默认开启），组合方需要时自行切换；
 * `runs` 升级内部临时关外键并在 `finally` 恢复。
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
    // 先建齐缺失的表（旧库已存在的表原样保留），再做 runs 物理升级。
    withTx(db, () => {
      db.exec(SCHEMA_SQL)
    })
    upgradeLegacyRuns(db)
    upgradeLegacyRuntimes(db)
    // M6 / M6.5：tasks 只补列、不重建（外键引用 tasks 的表不能被改名波及）；必须在导入/写入之前完成。
    upgradeLegacyTasks(db)
    withTx(db, () => {
      // 升级可能删掉旧 runs 上的索引，这里统一补齐（新建库同样幂等）。
      db.exec(INDEX_SQL)
      db.exec(FACTS_SQL)
      // 宿主私有进程登记表（T13）：不进投影白名单，旧库打开时补齐即可。
      db.exec(PROCESS_REGISTRY_SQL)
      // 命令幂等表（M5）：非投影表，旧库打开时补齐
      db.exec(COMMANDS_SQL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
    return db
  } catch (e) {
    // 完整性检查/建表/升级失败：关掉连接再抛，避免锁住数据库文件。
    // 构造函数在 try 之外，进入这里的连接一定还开着，直接关闭即可。
    db.close()
    throw e
  }
}
