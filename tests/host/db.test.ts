// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { needsRunsUpgrade, needsRuntimesUpgrade, openDatabase } from '../../src/host/db'
import {
  RUN_M2_ADDED_COLUMNS,
  RUNTIMES_M3_ADDED_COLUMNS,
  SCHEMA_SQL,
  SCHEMA_VERSION,
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
  it(':memory: 建全 schema（九张投影 + facts / projection_meta + 宿主私有 process_registry）并写 user_version', () => {
    db = openDatabase(':memory:')
    expect(tableNames(db)).toEqual([
      'agents',
      'conversations',
      'facts',
      'messages',
      'process_registry',
      'projection_meta',
      'run_events',
      'runs',
      'runtimes',
      'tasks',
      'workflow_stages',
      'workflows',
    ])
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
        'conversations',
        'facts',
        'messages',
        'process_registry',
        'projection_meta',
        'run_events',
        'runs',
        'runtimes',
        'tasks',
        'workflow_stages',
        'workflows',
      ])
      expect(
        (local.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as unknown as { n: number }).n,
      ).toBe(1)
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
