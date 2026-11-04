// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './db'
import { migrate, schemaVersion } from './migrate'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'

/** v1 的建表语句（迁移输入的形态，勿改） */
const V1_SCHEMA = `
CREATE TABLE runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'deepseek-harness',
  command TEXT NOT NULL,
  args_template TEXT NOT NULL DEFAULT '[]',
  prompt_mode TEXT NOT NULL DEFAULT 'arg' CHECK (prompt_mode IN ('stdin','arg')),
  workdir TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE workflow_stages (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  entry_mode TEXT NOT NULL CHECK (entry_mode IN ('none','agent','user')),
  agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  on_complete_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  on_reject_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, position)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  current_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  prompt TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  error TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TEXT NOT NULL
);
`

let root: string
let file: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwf-migrate-'))
  file = path.join(root, 'ai-workflow.db')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function seedV1(db: DatabaseSync): void {
  db.exec(V1_SCHEMA)
  db.exec(`
    INSERT INTO runtimes (id,name,kind,command,args_template,prompt_mode,workdir,created_at)
    VALUES ('rt1','DeepSeek Harness','deepseek-harness','dsh','["-p","{prompt}"]','arg','C:/w','2026-01-01T00:00:00.000Z');
    INSERT INTO agents (id,name,description,runtime_id,system_prompt,created_at)
    VALUES ('ag1','coder','','rt1','sys','2026-01-01T00:00:01.000Z');
    INSERT INTO workflows (id,name,description,created_at)
    VALUES ('wf1','w','','2026-01-01T00:00:02.000Z');
    INSERT INTO workflow_stages (id,workflow_id,name,position,entry_mode,agent_id,on_complete_stage_id,on_reject_stage_id,created_at)
    VALUES ('st1','wf1','s',0,'none',NULL,NULL,NULL,'2026-01-01T00:00:03.000Z');
    INSERT INTO tasks (id,title,description,workflow_id,current_stage_id,status,created_at,updated_at)
    VALUES ('t1','T','','wf1','st1','active','2026-01-01T00:00:04.000Z','2026-01-01T00:00:04.000Z');
    INSERT INTO runs (id,task_id,stage_id,agent_id,status,prompt,output,error,started_at,ended_at,created_at)
    VALUES ('run-ok','t1','st1','ag1','succeeded','p','ok',NULL,'a','b','2026-01-01T00:00:05.000Z');
    INSERT INTO runs (id,task_id,stage_id,agent_id,status,prompt,output,error,started_at,ended_at,created_at)
    VALUES ('run-bad','t1','st1','ag1','failed','p','oops','退出码 1','a','b','2026-01-01T00:00:06.000Z');
    INSERT INTO chat_conversations (id,title,agent_id,created_at,updated_at)
    VALUES ('cv1','对话','ag1','2026-01-01T00:00:07.000Z','2026-01-01T00:00:07.000Z');
    INSERT INTO chat_messages (id,conversation_id,role,content,error,created_at)
    VALUES ('m1','cv1','user','你好',NULL,'2026-01-01T00:00:08.000Z');
  `)
}

describe('migrate v1 → v2', () => {
  it('新建库：v2 全量 schema，版本号为 2', () => {
    const db = openDb(file)
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as unknown as Array<{ name: string }>
      ).map((r) => r.name)
      expect(tables).toContain('run_events')
      expect(columnsOf(db, 'runtimes')).not.toContain('kind')
      expect(columnsOf(db, 'runs')).toContain('runtime_id')
    } finally {
      db.close()
    }
  })

  it('v1 库：重建表并保留数据，旧运行归类为非零退出', () => {
    const legacy = new DatabaseSync(file)
    seedV1(legacy)
    legacy.close()

    const db = openDb(file)
    try {
      expect(schemaVersion(db)).toBe(2)
      const rt = db.prepare('SELECT * FROM runtimes').get() as unknown as Record<string, unknown>
      expect(rt).toMatchObject({
        id: 'rt1',
        name: 'DeepSeek Harness',
        protocol_family: 'dsh',
        command: 'dsh',
        profile: 'multica',
        permission_mode: 'workspace-write',
        workdir: 'C:/w',
        max_concurrent: 1,
        enabled: 1,
        last_probe_json: null,
      })
      expect(columnsOf(db, 'runtimes')).not.toContain('args_template')
      expect(columnsOf(db, 'runtimes')).not.toContain('prompt_mode')

      const runs = db.prepare('SELECT * FROM runs ORDER BY id').all() as unknown as Array<
        Record<string, unknown>
      >
      expect(runs.map((r) => r.id)).toEqual(['run-bad', 'run-ok'])
      expect(runs[0]).toMatchObject({
        error_code: 'exit_nonzero',
        runtime_id: null,
        session_id: null,
        usage_json: null,
        duration_ms: null,
      })
      expect(runs[1].error_code).toBeNull()

      const conv = db.prepare('SELECT * FROM chat_conversations').get() as unknown as Record<
        string,
        unknown
      >
      expect(conv.session_id).toBeNull()

      // 外键仍然有效
      expect(() =>
        db
          .prepare('INSERT INTO agents (id,name,runtime_id,created_at) VALUES (?,?,?,?)')
          .run('ag2', 'x', 'ghost', new Date().toISOString()),
      ).toThrow()
      // 迁移后数据可继续读写：run_events 可挂到历史 run 上
      db.prepare(
        'INSERT INTO run_events (run_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,?)',
      ).run('run-ok', 1, 'text', '{"text":"hi"}', new Date().toISOString())
    } finally {
      db.close()
    }

    // 再次打开：幂等，不重复迁移
    const again = openDb(file)
    try {
      expect(schemaVersion(again)).toBe(2)
      expect((again.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as { n: number }).n).toBe(1)
    } finally {
      again.close()
    }
  })

  it('结构已是 v2 但版本号落后：只补索引与版本号', () => {
    const db = new DatabaseSync(file)
    db.exec(SCHEMA_SQL)
    db.exec('PRAGMA user_version = 0')
    migrate(db)
    expect(schemaVersion(db)).toBe(2)
    db.close()
  })

  it('迁移中途失败：回滚且版本号不变、旧数据保留', () => {
    const legacy = new DatabaseSync(file)
    seedV1(legacy)
    // run_events 结构冲突会让迁移末尾的索引创建失败，触发回滚
    legacy.exec('CREATE TABLE run_events (wrong TEXT)')
    legacy.close()

    expect(() => openDb(file)).toThrow(/no such column: run_id/)

    const db = new DatabaseSync(file)
    try {
      expect(schemaVersion(db)).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM runtimes').get() as { n: number }).n).toBe(1)
      expect((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(2)
    } finally {
      db.close()
    }
  })
  it('版本号高于当前支持：拒绝打开', () => {
    const db = new DatabaseSync(file)
    db.exec('PRAGMA user_version = 99')
    expect(() => migrate(db)).toThrow(/高于当前支持的 2/)
    db.close()
  })
})
