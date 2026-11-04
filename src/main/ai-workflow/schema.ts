/**
 * ai-workflow 的 SQLite schema（v2，运行时 v2 重做）。
 * 以字符串内嵌（而非 .sql 资源文件），保证 electron-vite 打包后主进程运行时也能拿到。
 *
 * 表名/列名是最终形态；迁移逻辑（v1 → v2）在 migrate.ts，按同样的表结构重建。
 */
export const SCHEMA_VERSION = 2

const runtimesTable = (name = 'runtimes'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
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

const agentsTable = (name = 'agents'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);`

const workflowsTable = (name = 'workflows'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);`

const stagesTable = (name = 'workflow_stages'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
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
);`

const tasksTable = (name = 'tasks'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  current_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

const runsTable = (name = 'runs'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
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

const runEventsTable = (name = 'run_events'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('status','text','thinking','tool_call','tool_result')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);`

const conversationsTable = (name = 'chat_conversations'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

const messagesTable = (name = 'chat_messages'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TEXT NOT NULL
);`

export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_stages_workflow ON workflow_stages(workflow_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_runtime_status ON runs(runtime_id, status);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
`

/** v2 全量 schema（新建库） */
export const SCHEMA_SQL = [
  runtimesTable(),
  agentsTable(),
  workflowsTable(),
  stagesTable(),
  tasksTable(),
  runsTable(),
  runEventsTable(),
  conversationsTable(),
  messagesTable(),
  INDEX_SQL,
].join('\n')

/** 供迁移重建复用：生成指名字表的 DDL */
export const tableDdl = {
  runtimes: runtimesTable,
  agents: agentsTable,
  workflows: workflowsTable,
  stages: stagesTable,
  tasks: tasksTable,
  runs: runsTable,
  runEvents: runEventsTable,
  conversations: conversationsTable,
  messages: messagesTable,
} as const
