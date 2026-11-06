// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  needsRunsUpgrade,
  needsRuntimesUpgrade,
  needsStagesUpgrade,
  needsTasksRebuild,
  needsTasksUpgrade,
  openDatabase,
} from '../../src/host/db'
import {
  PROJECTION_TABLES,
  RUN_M2_ADDED_COLUMNS,
  RUNTIMES_M3_ADDED_COLUMNS,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  TASKS_M6_ADDED_COLUMNS,
  TASKS_M65_ADDED_COLUMNS,
  TASKS_M7_ADDED_COLUMNS,
  tableDdl,
} from '../../src/host/schema'

/**
 * M1/v2 旧库的 `runtimes` DDL 原样：协议族列 + CHECK（M3 换成 `executor_key` + `args_template`）。
 * 用来造真实旧库，验证 open 阶段的一次性物理升级。
 */
const LEGACY_RUNTIMES_DDL = `
CREATE TABLE runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  protocol_family TEXT NOT NULL DEFAULT 'dsh' CHECK (protocol_family IN ('dsh')),
  command TEXT NOT NULL DEFAULT 'dsh',
  profile TEXT NOT NULL DEFAULT 'multica',
  permission_mode TEXT NOT NULL DEFAULT 'workspace-write'
    CHECK (permission_mode IN ('read-only','workspace-write','danger-full-access')),
  model TEXT,
  reasoning_effort TEXT,
  workdir TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_probe_json TEXT,
  created_at TEXT NOT NULL
);`

/**
 * M1/v2 旧库的 `runs` DDL 原样：没有 M2 调度列、`task_id` NOT NULL、status 五值。
 * 用来造一个真实旧库，验证 open 阶段的一次性物理升级。
 */
const LEGACY_RUNS_DDL = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  runtime_id TEXT REFERENCES runtimes(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  prompt TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  error TEXT,
  error_code TEXT,
  exit_code INTEGER,
  session_id TEXT,
  usage_json TEXT,
  duration_ms INTEGER,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);`

/** 失败回滚用例用：去掉 status CHECK，好塞一个新结构不接受的取值。 */
const LEGACY_RUNS_DDL_NO_CHECK = LEGACY_RUNS_DDL.replace(
  "  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),",
  '  status TEXT NOT NULL,',
)

/** M1/v2 旧库的 `tasks` DDL 原样：M6 之前的 8 列（无 origin / rule_id / external_ref / labels_json）。 */
const LEGACY_TASKS_DDL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  current_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

const SEED_AT = '2026-01-01T00:00:00.000Z'
const LEGACY_RUN_COUNT = 15
const LEGACY_EVENT_COUNT = 30

/**
 * 造一个 M1 结构的文件库：实体五表 + 旧 `runs` + `run_events`，灌 15 条 run / 30 条事件。
 * `runs` DDL 可替换（失败回滚用例用无 CHECK 版本）。
 */
function seedLegacyDatabase(file: string, runsDdl = LEGACY_RUNS_DDL): void {
  const seeded = new DatabaseSync(file)
  try {
    seeded.exec(LEGACY_RUNTIMES_DDL)
    seeded.exec(tableDdl.agents())
    seeded.exec(tableDdl.workflows())
    seeded.exec(tableDdl.stages())
    seeded.exec(tableDdl.tasks())
    seeded.exec(runsDdl)
    seeded.exec(tableDdl.runEvents())

    seeded
      .prepare('INSERT INTO runtimes (id, name, created_at) VALUES (?, ?, ?)')
      .run('rt-1', '旧运行时', SEED_AT)
    seeded
      .prepare('INSERT INTO agents (id, name, runtime_id, created_at) VALUES (?, ?, ?, ?)')
      .run('ag-1', '旧智能体', 'rt-1', SEED_AT)
    seeded
      .prepare('INSERT INTO workflows (id, name, created_at) VALUES (?, ?, ?)')
      .run('wf-1', '旧流程', SEED_AT)
    seeded
      .prepare(
        `INSERT INTO workflow_stages (id, workflow_id, name, position, entry_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('st-1', 'wf-1', '待办', 0, 'none', SEED_AT)
    seeded
      .prepare(
        `INSERT INTO tasks (id, title, workflow_id, current_stage_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('tk-1', '旧任务', 'wf-1', 'st-1', 'active', SEED_AT, SEED_AT)

    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
    const insertRun = seeded.prepare(
      `INSERT INTO runs
         (id, task_id, stage_id, agent_id, runtime_id, status, prompt, output, error, error_code,
          exit_code, session_id, usage_json, duration_ms, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertEvent = seeded.prepare(
      `INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (let index = 0; index < LEGACY_RUN_COUNT; index += 1) {
      const runId = `run-old-${String(index).padStart(2, '0')}`
      const status = statuses[index % statuses.length]
      insertRun.run(
        runId,
        'tk-1',
        'st-1',
        'ag-1',
        'rt-1',
        status,
        `旧提示词 ${index}`,
        status === 'succeeded' ? `旧输出 ${index}` : '',
        status === 'failed' ? '旧错误' : null,
        status === 'failed' ? 'exit_nonzero' : null,
        status === 'failed' ? 1 : null,
        `sess-${index}`,
        index === 0 ? JSON.stringify({ inputTokens: 1, outputTokens: 2 }) : null,
        index + 100,
        index === 0 ? null : SEED_AT,
        index === 0 ? null : SEED_AT,
        SEED_AT,
      )
      for (let seq = 1; seq <= 2; seq += 1) {
        insertEvent.run(
          runId,
          seq,
          seq === 1 ? 'status' : 'text',
          JSON.stringify({ text: `${runId}-${seq}` }),
          SEED_AT,
        )
      }
    }
  } finally {
    seeded.close()
  }
}

let db: DatabaseSync | null = null
afterEach(() => {
  db?.close()
  db = null
})

function tableNames(d: DatabaseSync): string[] {
  const rows = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>
  return rows.map((row) => row.name).sort()
}

function userVersion(d: DatabaseSync): number {
  return (d.prepare('PRAGMA user_version').get() as unknown as { user_version: number })
    .user_version
}

describe('openDatabase', () => {
  it(':memory: 建全 schema（十五张投影 + facts / projection_meta + 宿主私有 process_registry、commands、plugin_secrets）并写 user_version', () => {
    db = openDatabase(':memory:')
    expect(tableNames(db)).toEqual([
      'agents',
      'cards',
      'commands',
      'conversations',
      'facts',
      'messages',
      'plugin_secrets',
      'plugin_settings',
      'process_registry',
      'projection_meta',
      'rule_fires',
      'rule_sets',
      'run_events',
      'runs',
      'runtimes',
      'task_comments',
      'tasks',
      'threads',
      'workflow_stages',
      'workflows',
    ])
    // commands 是命令幂等表（M5）：与 process_registry 一样是宿主私有非投影表，不进投影白名单
    expect(PROJECTION_TABLES).not.toContain('commands')
    expect(userVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('runs 表不存在（空列集合）：needsRunsUpgrade 返回 false，不触发升级', () => {
    const empty = new DatabaseSync(':memory:')
    try {
      expect(needsRunsUpgrade(empty)).toBe(false)
    } finally {
      empty.close()
    }
  })

  it('runtimes 表不存在（空列集合）：needsRuntimesUpgrade 返回 false，不触发升级', () => {
    const empty = new DatabaseSync(':memory:')
    try {
      expect(needsRuntimesUpgrade(empty)).toBe(false)
    } finally {
      empty.close()
    }
  })

  it('tasks 表不存在（空列集合）：needsTasksUpgrade 返回 false，不触发补列', () => {
    const empty = new DatabaseSync(':memory:')
    try {
      expect(needsTasksUpgrade(empty)).toBe(false)
    } finally {
      empty.close()
    }
  })

  it('M7：表不存在（空列集合）时 needsTasksRebuild / needsStagesUpgrade 均返回 false', () => {
    const empty = new DatabaseSync(':memory:')
    try {
      expect(needsTasksRebuild(empty)).toBe(false)
      expect(needsStagesUpgrade(empty)).toBe(false)
    } finally {
      empty.close()
    }
  })

  it('M7：旧库 workflow_stages 缺交接两列 → open 时 ALTER 补齐（不重建表）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-stages-'))
    const file = path.join(root, 'ai-workflow.db')
    const seeded = new DatabaseSync(file)
    try {
      seeded.exec(SCHEMA_SQL)
      seeded.exec('ALTER TABLE workflow_stages DROP COLUMN handoff_workflow_id')
      seeded.exec('ALTER TABLE workflow_stages DROP COLUMN handoff_stage_id')
      // 旧表结构里插入一行，验证补列不影响数据
      seeded
        .prepare(`INSERT INTO workflows (id, name, description, created_at) VALUES (?, ?, '', ?)`)
        .run('wf-1', '旧流程', '2026-01-01T00:00:00.000Z')
      seeded
        .prepare(
          `INSERT INTO workflow_stages (id, workflow_id, name, position, entry_mode, created_at)
           VALUES (?, ?, ?, 0, 'none', ?)`,
        )
        .run('st-1', 'wf-1', '旧阶段', '2026-01-01T00:00:00.000Z')
      expect(needsStagesUpgrade(seeded)).toBe(true)
    } finally {
      seeded.close()
    }

    const local = openDatabase(file)
    try {
      expect(needsStagesUpgrade(local)).toBe(false)
      const columns = (
        local.prepare('PRAGMA table_info(workflow_stages)').all() as unknown as Array<{
          name: string
        }>
      ).map((row) => row.name)
      expect(columns).toEqual(expect.arrayContaining(['handoff_workflow_id', 'handoff_stage_id']))
      const row = local
        .prepare('SELECT name, handoff_workflow_id, handoff_stage_id FROM workflow_stages')
        .get() as {
        name: string
        handoff_workflow_id: string | null
        handoff_stage_id: string | null
      }
      expect(row).toEqual({ name: '旧阶段', handoff_workflow_id: null, handoff_stage_id: null })
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不动 foreign_keys：保持连接默认（node:sqlite 默认开启外键约束）', () => {
    db = openDatabase(':memory:')
    const rows = db.prepare('PRAGMA foreign_keys').all() as unknown as Array<{
      foreign_keys: number
    }>
    expect(rows[0]?.foreign_keys).toBe(1)
  })

  it('外键约束生效：引用不存在的运行时被拒绝', () => {
    db = openDatabase(':memory:')
    expect(() =>
      db!
        .prepare('INSERT INTO agents (id, name, runtime_id, created_at) VALUES (?, ?, ?, ?)')
        .run('ag1', 'agent', 'missing-runtime', '2026-01-01T00:00:00.000Z'),
    ).toThrow()
  })

  it('已有 v2 旧库：不重建、不清数据，user_version 保持当前版本', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-legacy-'))
    const file = path.join(root, 'ai-workflow.db')
    const seeded = new DatabaseSync(file)
    try {
      seeded.exec(SCHEMA_SQL)
      seeded.exec('PRAGMA user_version = 2')
      seeded
        .prepare('INSERT INTO runtimes (id, name, executor_key, created_at) VALUES (?, ?, ?, ?)')
        .run('rt1', '旧运行时', 'dsh', '2026-01-01T00:00:00.000Z')
    } finally {
      seeded.close()
    }

    const local = openDatabase(file)
    try {
      expect(tableNames(local)).toEqual([
        'agents',
        'cards',
        'commands',
        'conversations',
        'facts',
        'messages',
        'plugin_secrets',
        'plugin_settings',
        'process_registry',
        'projection_meta',
        'rule_fires',
        'rule_sets',
        'run_events',
        'runs',
        'runtimes',
        'task_comments',
        'tasks',
        'threads',
        'workflow_stages',
        'workflows',
      ])
      expect(
        (local.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as unknown as { n: number }).n,
      ).toBe(1)
      // 非投影表补齐不动数据：commands 建出来且为空，事实与投影元信息不被触发重建
      expect(countOf(local, 'commands')).toBe(0)
      expect(countOf(local, 'facts')).toBe(0)
      expect(countOf(local, 'projection_meta')).toBe(0)
      expect(userVersion(local)).toBe(SCHEMA_VERSION)
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('结构已是 v2 但版本号落后：补索引与版本号，数据保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-version-'))
    const file = path.join(root, 'ai-workflow.db')
    const seeded = new DatabaseSync(file)
    try {
      seeded.exec(SCHEMA_SQL)
      seeded.exec('PRAGMA user_version = 0')
      seeded
        .prepare('INSERT INTO runtimes (id, name, executor_key, created_at) VALUES (?, ?, ?, ?)')
        .run('rt1', '旧运行时', 'dsh', '2026-01-01T00:00:00.000Z')
    } finally {
      seeded.close()
    }

    const local = openDatabase(file)
    try {
      expect(userVersion(local)).toBe(SCHEMA_VERSION)
      expect(
        (local.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as unknown as { n: number }).n,
      ).toBe(1)
      expect(
        (
          local
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_workflow'",
            )
            .get() as unknown as { name: string } | undefined
        )?.name,
      ).toBe('idx_tasks_workflow')
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('重复打开幂等：账本表与已有事实保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-reopen-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      const first = openDatabase(file)
      try {
        first
          .prepare('INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)')
          .run('task.created', '{}', '2026-01-01T00:00:00.000Z', '{}')
      } finally {
        first.close()
      }
      const second = openDatabase(file)
      try {
        expect(
          (second.prepare('SELECT COUNT(*) AS n FROM facts').get() as unknown as { n: number }).n,
        ).toBe(1)
      } finally {
        second.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('文件库启用 WAL 并设置 busy_timeout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-wal-'))
    const file = path.join(root, 'workbench.db')
    const local = openDatabase(file)
    try {
      expect(
        (local.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string })
          .journal_mode,
      ).toBe('wal')
      expect(
        (local.prepare('PRAGMA busy_timeout').get() as unknown as { timeout: number }).timeout,
      ).toBe(5000)
      expect(
        (local.prepare('PRAGMA integrity_check').get() as unknown as { integrity_check: string })
          .integrity_check,
      ).toBe('ok')
      // WAL 真正落盘：建表写入后主库旁应有 -wal 侧车
      expect(existsSync(`${file}-wal`)).toBe(true)
    } finally {
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('完整性检查失败：关闭连接并抛出可读错误', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-corrupt-'))
    const file = path.join(root, 'workbench.db')
    const seeded = new DatabaseSync(file)
    const pageSize = (seeded.prepare('PRAGMA page_size').get() as unknown as { page_size: number })
      .page_size
    try {
      seeded.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
      const insert = seeded.prepare('INSERT INTO payload (body) VALUES (?)')
      seeded.exec('BEGIN')
      for (let i = 0; i < 200; i++) insert.run('x'.repeat(300))
      seeded.exec('COMMIT')
    } finally {
      seeded.close()
    }
    // 只破坏最后一个数据页（文件头与 schema 页保持合法）：仍能打开，但 integrity_check 必然非 ok
    const buf = readFileSync(file)
    for (let i = buf.length - pageSize + 12; i < buf.length; i++) buf[i] = 0xab
    writeFileSync(file, buf)

    try {
      expect(() => openDatabase(file)).toThrow(/数据库完整性检查失败/)
      // 抛错前连接已关闭：Windows 上句柄未释放时删除会 EBUSY
      expect(() => rmSync(file, { force: true })).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** 旧库 `runs` 的业务列（升级后必须逐列保留）。 */
const LEGACY_RUN_BUSINESS_COLUMNS = `id, task_id, stage_id, agent_id, runtime_id, status, prompt,
  output, error, error_code, exit_code, session_id, usage_json, duration_ms, started_at, ended_at, created_at`

const columnNames = (connection: DatabaseSync, table: string): Set<string> =>
  new Set(
    (
      connection.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
    ).map((row) => row.name),
  )

const countOf = (connection: DatabaseSync, table: string): number =>
  (connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }).n

/** 列结构指纹（名 / 类型 / NOT NULL / 默认值 / 主键）：升级后必须与新库 DDL 逐列一致。 */
const columnShape = (connection: DatabaseSync, table: string): string[] =>
  (
    connection.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<
      Record<string, unknown>
    >
  ).map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk].map(String).join('|'))

/** 造一个 M6 之前的文件库：旧 `tasks`（8 列）+ 它引用的 workflows / workflow_stages。 */
function seedLegacyTasksDatabase(file: string): void {
  const seeded = new DatabaseSync(file)
  try {
    // 阶段的外键链：workflow_stages.agent_id → agents → runtimes
    seeded.exec(tableDdl.runtimes())
    seeded.exec(tableDdl.agents())
    seeded.exec(tableDdl.workflows())
    seeded.exec(tableDdl.stages())
    seeded.exec(LEGACY_TASKS_DDL)
    seeded
      .prepare('INSERT INTO workflows (id, name, created_at) VALUES (?, ?, ?)')
      .run('wf-1', '旧流程', SEED_AT)
    seeded
      .prepare(
        `INSERT INTO workflow_stages (id, workflow_id, name, position, entry_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('st-1', 'wf-1', '待办', 0, 'none', SEED_AT)
    seeded
      .prepare(
        `INSERT INTO tasks (id, title, description, workflow_id, current_stage_id, status,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('tk-1', '旧任务', '旧描述', 'wf-1', 'st-1', 'active', SEED_AT, SEED_AT)
  } finally {
    seeded.close()
  }
}

describe('openDatabase：旧库 runs 结构升级（M2 一次性物理迁移）', () => {
  it('缺 M2 列：重建 runs，15 行数据与 run_events 原样保留，新结构可写新行', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-runs-upgrade-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      seedLegacyDatabase(file)

      // 升级前快照：业务列与事件逐行记录
      const before = new DatabaseSync(file)
      let businessBefore: unknown[]
      let eventsBefore: unknown[]
      try {
        businessBefore = before
          .prepare(`SELECT ${LEGACY_RUN_BUSINESS_COLUMNS} FROM runs ORDER BY id`)
          .all()
        eventsBefore = before
          .prepare(
            'SELECT run_id, seq, type, payload_json, created_at FROM run_events ORDER BY run_id, seq',
          )
          .all()
        expect(columnNames(before, 'runs').has('purpose')).toBe(false)
      } finally {
        before.close()
      }

      db = openDatabase(file)
      const migratedColumns = columnNames(db, 'runs')
      for (const column of RUN_M2_ADDED_COLUMNS) {
        expect(migratedColumns, column).toContain(column)
      }
      expect(migratedColumns.has('task_id')).toBe(true)

      // 旧业务列逐行保留
      expect(
        db.prepare(`SELECT ${LEGACY_RUN_BUSINESS_COLUMNS} FROM runs ORDER BY id`).all(),
      ).toEqual(businessBefore)
      // M2 新列按迁移口径补默认值
      const defaults = db
        .prepare(
          `SELECT purpose, conversation_id, rule_id, rules_version, executor_key, thread_id, cwd,
                  access, skill, prompt_ref, event_ids_json, hops, turn, resume_session_id,
                  thread_context_ref, queue_seq, lease_id, attempt, attempts, lease_until,
                  not_before, deadline_at, cancel_requested
           FROM runs ORDER BY id`,
        )
        .all() as unknown as Array<Record<string, unknown>>
      expect(defaults).toHaveLength(LEGACY_RUN_COUNT)
      for (const row of defaults) {
        expect(row).toEqual({
          purpose: 'stage',
          conversation_id: null,
          rule_id: null,
          rules_version: 0,
          executor_key: '',
          thread_id: null,
          cwd: '',
          access: 'edit',
          skill: null,
          prompt_ref: null,
          event_ids_json: '[]',
          hops: 0,
          turn: 1,
          resume_session_id: null,
          thread_context_ref: null,
          queue_seq: 0,
          lease_id: null,
          attempt: 1,
          attempts: 0,
          lease_until: null,
          not_before: null,
          deadline_at: null,
          cancel_requested: 0,
        })
      }

      // run_events 不动
      expect(countOf(db, 'run_events')).toBe(LEGACY_EVENT_COUNT)
      expect(
        db
          .prepare(
            'SELECT run_id, seq, type, payload_json, created_at FROM run_events ORDER BY run_id, seq',
          )
          .all(),
      ).toEqual(eventsBefore)
      expect(tableNames(db)).not.toContain('runs_m2_upgrade')

      // 新结构可写：task_id 可空、status 接受 waiting、purpose 有默认值
      db.prepare('INSERT INTO runs (id, status, created_at) VALUES (?, ?, ?)').run(
        'run-new',
        'waiting',
        SEED_AT,
      )
      expect(db.prepare('SELECT * FROM runs WHERE id = ?').get('run-new')).toMatchObject({
        id: 'run-new',
        task_id: null,
        purpose: 'stage',
        status: 'waiting',
      })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      db.close()
      db = null

      // 幂等：已升级库再次打开 no-op，行数/内容不变
      const again = openDatabase(file)
      try {
        expect(countOf(again, 'runs')).toBe(LEGACY_RUN_COUNT + 1)
        expect(countOf(again, 'run_events')).toBe(LEGACY_EVENT_COUNT)
        expect(columnNames(again, 'runs').has('purpose')).toBe(true)
        expect(tableNames(again)).not.toContain('runs_m2_upgrade')
      } finally {
        again.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('升级失败整体回滚：旧 runs 结构、数据与事件原样保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-runs-rollback-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      seedLegacyDatabase(file, LEGACY_RUNS_DDL_NO_CHECK)
      const raw = new DatabaseSync(file)
      try {
        raw.prepare("UPDATE runs SET status = 'legacy_bad' WHERE id = 'run-old-00'").run()
      } finally {
        raw.close()
      }

      expect(() => openDatabase(file)).toThrow(/CHECK constraint failed/i)

      const inspect = new DatabaseSync(file)
      try {
        // 旧结构仍在（没有 purpose 列），数据未被破坏、临时表随事务回滚
        expect(columnNames(inspect, 'runs').has('purpose')).toBe(false)
        expect(countOf(inspect, 'runs')).toBe(LEGACY_RUN_COUNT)
        expect(countOf(inspect, 'run_events')).toBe(LEGACY_EVENT_COUNT)
        expect(
          (
            inspect.prepare("SELECT status FROM runs WHERE id = 'run-old-00'").get() as unknown as {
              status: string
            }
          ).status,
        ).toBe('legacy_bad')
        expect(tableNames(inspect)).not.toContain('runs_m2_upgrade')
      } finally {
        inspect.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('openDatabase：旧库 runtimes 结构升级（M3 一次性物理迁移）', () => {
  it('缺 M3 列：重建 runtimes，协议族回填执行器键、args_template 空串、智能体外键保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-runtimes-upgrade-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      const seeded = new DatabaseSync(file)
      try {
        seeded.exec(LEGACY_RUNTIMES_DDL)
        seeded.exec(tableDdl.agents())
        seeded
          .prepare('INSERT INTO runtimes (id, name, created_at) VALUES (?, ?, ?)')
          .run('rt-1', '旧运行时', SEED_AT)
        seeded
          .prepare('INSERT INTO agents (id, name, runtime_id, created_at) VALUES (?, ?, ?, ?)')
          .run('ag-1', '旧智能体', 'rt-1', SEED_AT)
      } finally {
        seeded.close()
      }

      const inspect = new DatabaseSync(file)
      try {
        expect(needsRuntimesUpgrade(inspect)).toBe(true)
        for (const column of RUNTIMES_M3_ADDED_COLUMNS) {
          expect(columnNames(inspect, 'runtimes').has(column), column).toBe(false)
        }
      } finally {
        inspect.close()
      }

      db = openDatabase(file)
      try {
        expect(needsRuntimesUpgrade(db)).toBe(false)
        expect(
          db.prepare('SELECT executor_key, args_template FROM runtimes WHERE id = ?').get('rt-1'),
        ).toEqual({ executor_key: 'dsh', args_template: '' })
        expect(db.prepare('SELECT runtime_id FROM agents WHERE id = ?').get('ag-1')).toEqual({
          runtime_id: 'rt-1',
        })
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        expect(tableNames(db)).not.toContain('runtimes_m3_upgrade')
      } finally {
        db.close()
        db = null
      }

      const again = openDatabase(file)
      try {
        expect(countOf(again, 'runtimes')).toBe(1)
        expect(tableNames(again)).not.toContain('runtimes_m3_upgrade')
      } finally {
        again.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('openDatabase：旧库 tasks 结构升级（M6 / M6.5 / M7 一次性物理重建）', () => {
  it('缺 M6/M6.5/M7 列：重建后旧行 origin=manual、线程与交接列为 null，列结构与新库逐列一致，且新行可写', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-tasks-upgrade-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      seedLegacyTasksDatabase(file)

      const before = new DatabaseSync(file)
      try {
        expect(needsTasksUpgrade(before)).toBe(true)
        // M7：缺交接两列 → 走物理重建（`origin` 的 CHECK 也要扩成含 handoff）
        expect(needsTasksRebuild(before)).toBe(true)
        for (const column of [
          ...TASKS_M6_ADDED_COLUMNS,
          ...TASKS_M65_ADDED_COLUMNS,
          ...TASKS_M7_ADDED_COLUMNS,
        ]) {
          expect(columnNames(before, 'tasks').has(column), column).toBe(false)
        }
      } finally {
        before.close()
      }

      db = openDatabase(file)
      try {
        expect(needsTasksUpgrade(db)).toBe(false)
        expect(needsTasksRebuild(db)).toBe(false)
        const columns = columnNames(db, 'tasks')
        for (const column of [
          ...TASKS_M6_ADDED_COLUMNS,
          ...TASKS_M65_ADDED_COLUMNS,
          ...TASKS_M7_ADDED_COLUMNS,
        ]) {
          expect(columns, column).toContain(column)
        }

        // 旧业务列逐列保留
        expect(
          db
            .prepare(
              `SELECT id, title, description, workflow_id, current_stage_id, status,
                      created_at, updated_at
               FROM tasks ORDER BY id`,
            )
            .all(),
        ).toEqual([
          {
            id: 'tk-1',
            title: '旧任务',
            description: '旧描述',
            workflow_id: 'wf-1',
            current_stage_id: 'st-1',
            status: 'active',
            created_at: SEED_AT,
            updated_at: SEED_AT,
          },
        ])
        // 旧行按默认值补来源列与线程两列
        expect(
          db
            .prepare(
              `SELECT origin, rule_id, external_ref, labels_json, thread_id, parent_task_id,
                      handoff_from_task_id, handoff_from_stage_id
               FROM tasks WHERE id = ?`,
            )
            .get('tk-1'),
        ).toEqual({
          origin: 'manual',
          rule_id: null,
          external_ref: null,
          labels_json: '[]',
          thread_id: null,
          parent_task_id: null,
          handoff_from_task_id: null,
          handoff_from_stage_id: null,
        })

        // 物理重建后列结构与新建库 DDL 逐列一致（含列顺序；代码全部按列名读写，顺序只是重建产物）
        const fresh = new DatabaseSync(':memory:')
        try {
          fresh.exec(SCHEMA_SQL)
          expect(columnShape(db, 'tasks')).toEqual(columnShape(fresh, 'tasks'))
        } finally {
          fresh.close()
        }

        // 新结构可写：来源四列与线程两列落库，非法来源被 CHECK 拒绝
        db.prepare(
          `INSERT INTO tasks (id, title, workflow_id, origin, rule_id, external_ref, labels_json,
                              thread_id, parent_task_id, created_at, updated_at)
           VALUES (?, ?, ?, 'rule', 'rule-1', 'issue-1', '["bug"]', 'th-1', 'tk-parent', ?, ?)`,
        ).run('tk-rule', '规则任务', 'wf-1', SEED_AT, SEED_AT)
        expect(
          db
            .prepare(
              `SELECT origin, rule_id, external_ref, labels_json, thread_id, parent_task_id
               FROM tasks WHERE id = ?`,
            )
            .get('tk-rule'),
        ).toEqual({
          origin: 'rule',
          rule_id: 'rule-1',
          external_ref: 'issue-1',
          labels_json: '["bug"]',
          thread_id: 'th-1',
          parent_task_id: 'tk-parent',
        })
        expect(() =>
          db!.prepare("UPDATE tasks SET origin = 'agent' WHERE id = 'tk-1'").run(),
        ).toThrow()
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        db.close()
        db = null
      }

      // 幂等：已补齐的库再次打开 no-op，行数与列不变
      const again = openDatabase(file)
      try {
        expect(needsTasksUpgrade(again)).toBe(false)
        expect(countOf(again, 'tasks')).toBe(2)
        expect(columnNames(again, 'tasks').has('labels_json')).toBe(true)
        expect(columnNames(again, 'tasks').has('thread_id')).toBe(true)
      } finally {
        again.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('只缺 M6.5 / M7 列：按新结构重建，M6 来源列与既有数据原样保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-tasks-m65-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      seedLegacyTasksDatabase(file)
      // 模拟 M6 已升级过的库：来源四列已存在、线程两列缺失。
      const raw = new DatabaseSync(file)
      try {
        raw.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'")
        raw.exec('ALTER TABLE tasks ADD COLUMN rule_id TEXT')
        raw.exec('ALTER TABLE tasks ADD COLUMN external_ref TEXT')
        raw.exec("ALTER TABLE tasks ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'")
        raw.prepare("UPDATE tasks SET labels_json = '[\"legacy\"]' WHERE id = 'tk-1'").run()
      } finally {
        raw.close()
      }

      const inspect = new DatabaseSync(file)
      try {
        expect(needsTasksUpgrade(inspect)).toBe(true)
        expect(columnNames(inspect, 'tasks').has('thread_id')).toBe(false)
        expect(columnNames(inspect, 'tasks').has('origin')).toBe(true)
      } finally {
        inspect.close()
      }

      db = openDatabase(file)
      try {
        expect(needsTasksUpgrade(db)).toBe(false)
        expect(
          db
            .prepare(
              `SELECT origin, labels_json, thread_id, parent_task_id FROM tasks WHERE id = 'tk-1'`,
            )
            .get(),
        ).toEqual({
          origin: 'manual',
          labels_json: '["legacy"]',
          thread_id: null,
          parent_task_id: null,
        })
        // 重建后列结构与新建库 DDL 逐列一致（M6.5 线程两列与 M7 交接两列都在）
        const fresh = new DatabaseSync(':memory:')
        try {
          fresh.exec(SCHEMA_SQL)
          expect(columnShape(db, 'tasks')).toEqual(columnShape(fresh, 'tasks'))
        } finally {
          fresh.close()
        }
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        db.close()
        db = null
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('部分列已存在（M7 交接列缺失）：仍按新结构重建，缺失列补齐', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-tasks-partial-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      seedLegacyTasksDatabase(file)
      const raw = new DatabaseSync(file)
      try {
        raw.exec("ALTER TABLE tasks ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'")
      } finally {
        raw.close()
      }

      const inspect = new DatabaseSync(file)
      try {
        expect(needsTasksUpgrade(inspect)).toBe(true)
      } finally {
        inspect.close()
      }

      db = openDatabase(file)
      try {
        expect(needsTasksUpgrade(db)).toBe(false)
        const columns = columnNames(db, 'tasks')
        for (const column of [...TASKS_M6_ADDED_COLUMNS, ...TASKS_M65_ADDED_COLUMNS]) {
          expect(columns, column).toContain(column)
        }
        expect(
          db
            .prepare(
              'SELECT origin, labels_json, thread_id, parent_task_id FROM tasks WHERE id = ?',
            )
            .get('tk-1'),
        ).toEqual({ origin: 'manual', labels_json: '[]', thread_id: null, parent_task_id: null })
      } finally {
        db.close()
        db = null
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('补列失败（异常库：M7 交接列已在、M6 缺）：整体回滚，旧结构与数据原样保留', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hostdb-tasks-rollback-'))
    const file = path.join(root, 'ai-workflow.db')
    try {
      seedLegacyTasksDatabase(file)
      // 异常状态：M6.5 / M7 列已在（`needsTasksRebuild` 为 false，走 ALTER 补列路径），
      // 但 M6 的 `labels_json` 缺；同时造一个大小写同名残留列 `LABELS_JSON`。
      // SQLite 列名大小写不敏感，补 `labels_json` 时会撞 duplicate column，
      // 用来验证「后一条 ALTER 失败 → 前面已成功的补列一起回滚」。
      const raw = new DatabaseSync(file)
      try {
        raw.exec('ALTER TABLE tasks ADD COLUMN thread_id TEXT')
        raw.exec('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT')
        raw.exec('ALTER TABLE tasks ADD COLUMN handoff_from_task_id TEXT')
        raw.exec('ALTER TABLE tasks ADD COLUMN handoff_from_stage_id TEXT')
        raw.exec("ALTER TABLE tasks ADD COLUMN LABELS_JSON TEXT NOT NULL DEFAULT '[]'")
      } finally {
        raw.close()
      }

      const inspectBefore = new DatabaseSync(file)
      try {
        expect(needsTasksRebuild(inspectBefore)).toBe(false)
        expect(needsTasksUpgrade(inspectBefore)).toBe(true)
      } finally {
        inspectBefore.close()
      }

      expect(() => openDatabase(file)).toThrow(/duplicate column name/i)

      const inspect = new DatabaseSync(file)
      try {
        const columns = columnNames(inspect, 'tasks')
        expect(columns.has('origin')).toBe(false)
        expect(columns.has('rule_id')).toBe(false)
        expect(columns.has('external_ref')).toBe(false)
        expect(columns.has('LABELS_JSON')).toBe(true)
        expect(columns.has('handoff_from_task_id')).toBe(true)
        expect(columns.has('handoff_from_stage_id')).toBe(true)
        expect(countOf(inspect, 'tasks')).toBe(1)
        expect(inspect.prepare('SELECT title FROM tasks WHERE id = ?').get('tk-1')).toEqual({
          title: '旧任务',
        })
      } finally {
        inspect.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
