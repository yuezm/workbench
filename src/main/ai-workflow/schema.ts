/**
 * ai-workflow 的 SQLite schema。
 * 以字符串内嵌（而非 .sql 资源文件），保证 electron-vite 打包后主进程运行时也能拿到。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'deepseek-harness',
  command TEXT NOT NULL,
  args_template TEXT NOT NULL DEFAULT '[]',
  prompt_mode TEXT NOT NULL DEFAULT 'arg' CHECK (prompt_mode IN ('stdin','arg')),
  workdir TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_stages (
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

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  current_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
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

CREATE INDEX IF NOT EXISTS idx_stages_workflow ON workflow_stages(workflow_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
`
