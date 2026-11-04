/**
 * 宿主层 SQLite schema：全库 DDL 的唯一来源（M1 起从 main/ai-workflow 迁入）。
 *
 * 以字符串内嵌（而非 .sql 资源文件），保证 electron-vite 打包后主进程运行时也能拿到。
 * 九张投影表（实体五表 + runs / run_events / conversations / messages）全部可由事实重建：
 * 实体五表的列名与约束保持 v2 原样；运行/聊天四表在 M2 变为投影（runs 补调度列、
 * `status` 加 `waiting`、`task_id` 可空；聊天投影从 `chat_*` 改名为 `conversations` / `messages`）。
 * 过渡期额外保留 legacy `chat_conversations` / `chat_messages`（T14 前旧聊天写路径仍是唯一真相，
 * 它们不进投影白名单/指纹，T14 一次性删除）。
 * `facts` 只追加，`projection_meta` 记录投影指纹与已折叠的 seq。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

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

/**
 * `runs` 投影：与 `RunRow` 逐字段对应（整行由事实携带，`project` 只回填 `queueSeq`）。
 *
 * - `task_id` 可空：聊天 run 不挂任务（D8）。
 * - `purpose` 由 `run.queued` 写入；旧存量默认 `'stage'`。
 * - `attempt` = 当前第几次领取（1 基）；`attempts` = 累计失败次数。
 * - `event_ids_json` 存 `eventIds: string[]` 的 JSON；`queueSeq` 是入队事实的 seq。
 */
const runsTable = (name = 'runs'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  runtime_id TEXT REFERENCES runtimes(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL DEFAULT 'stage' CHECK (purpose IN ('stage','chat')),
  -- 历史引用，不设外键：删对话不能把历史 run 的 conversationId 抹成 null（重建等价）
  conversation_id TEXT,
  rule_id TEXT,
  rules_version INTEGER NOT NULL DEFAULT 0,
  executor_key TEXT NOT NULL DEFAULT '',
  thread_id TEXT,
  cwd TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT 'edit' CHECK (access IN ('read','edit','full')),
  skill TEXT,
  prompt_ref TEXT,
  event_ids_json TEXT NOT NULL DEFAULT '[]',
  hops INTEGER NOT NULL DEFAULT 0,
  turn INTEGER NOT NULL DEFAULT 1,
  resume_session_id TEXT,
  thread_context_ref TEXT,
  queue_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
  prompt TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  error TEXT,
  error_code TEXT,
  exit_code INTEGER,
  session_id TEXT,
  usage_json TEXT,
  duration_ms INTEGER,
  lease_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  not_before TEXT,
  deadline_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
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

const conversationsTable = (name = 'conversations'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

const messagesTable = (name = 'messages'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TEXT NOT NULL
);`

/**
 * 过渡期 legacy 聊天表（**不进投影白名单 / 指纹**）。
 *
 * T3 已把聊天投影改名为 `conversations` / `messages`；但 T14 之前旧 ChatService
 * 仍以这两张表为唯一真相源，因此新旧并存、只由旧写路径写入旧表。
 * T14「聊天并入 `purpose='chat'`」时连同旧写路径一次性删除本段 DDL 与数据。
 */
const legacyChatConversationsTable = (name = 'chat_conversations'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

const legacyChatMessagesTable = (name = 'chat_messages'): string => `
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
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
`

/** v2 全量 schema（新建库；含两张 T14 前过渡期 legacy 聊天表） */
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
  legacyChatConversationsTable(),
  legacyChatMessagesTable(),
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

/**
 * M2 给 `runs` 新增的列（旧库 `CREATE TABLE IF NOT EXISTS` 不会补列）。
 *
 * `host/db.ts` 打开库时用 `PRAGMA table_info(runs)` 对这张清单做差集检测；缺任一列即触发
 * 一次性物理升级。清单与 `runsTable()` 的 DDL 保持同步（新增列必须同时改这里）。
 */
export const RUN_M2_ADDED_COLUMNS = [
  'purpose',
  'conversation_id',
  'rule_id',
  'rules_version',
  'executor_key',
  'thread_id',
  'cwd',
  'access',
  'skill',
  'prompt_ref',
  'event_ids_json',
  'hops',
  'turn',
  'resume_session_id',
  'thread_context_ref',
  'queue_seq',
  'lease_id',
  'attempt',
  'attempts',
  'lease_until',
  'not_before',
  'deadline_at',
  'cancel_requested',
] as const

/**
 * 旧 `runs` 行 → 新 `runs` 行（指名字表）的拷贝 SQL。
 *
 * 业务列原样保留；M2 新列按迁移口径补默认值（`purpose='stage'`、`attempt=1`、
 * `queueSeq=0`、`eventIds=[]`、`access='edit'` 等）。旧库的表名固定是 `runs`。
 */
export function legacyRunsCopySql(targetTable: string): string {
  return `INSERT INTO ${targetTable} (
    id, task_id, stage_id, agent_id, runtime_id, purpose, conversation_id, rule_id, rules_version,
    executor_key, thread_id, cwd, access, skill, prompt_ref, event_ids_json, hops, turn,
    resume_session_id, thread_context_ref, queue_seq, status, prompt, output, error, error_code,
    exit_code, session_id, usage_json, duration_ms, lease_id, attempt, attempts, lease_until,
    not_before, deadline_at, cancel_requested, started_at, ended_at, created_at
  )
  SELECT
    id, task_id, stage_id, agent_id, runtime_id, 'stage', NULL, NULL, 0,
    '', NULL, '', 'edit', NULL, NULL, '[]', 0, 1,
    NULL, NULL, 0, status, prompt, output, error, error_code,
    exit_code, session_id, usage_json, duration_ms, NULL, 1, 0, NULL,
    NULL, NULL, 0, started_at, ended_at, created_at
  FROM runs`
}

/**
 * 账本基础设施的 DDL：事实日志（只追加）与投影元信息。
 *
 * `facts.payload` / `facts.actor_json` 以 JSON 文本存放；`seq` 由 SQLite 自增分配，
 * 事实顺序即 seq 顺序。`projection_meta` 单行（id = 1），记录投影指纹与已折叠到的 seq。
 */
export const FACTS_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  at         TEXT NOT NULL,
  cause      INTEGER,
  hops       INTEGER,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type);
CREATE INDEX IF NOT EXISTS idx_facts_cause ON facts(cause);
CREATE TABLE IF NOT EXISTS projection_meta (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  format TEXT NOT NULL,
  seq    INTEGER NOT NULL
);
`

/** 投影集白名单：重建清空并重放的就是这九张表（与 `kernel/types` 的 `PROJECTION_TABLES` 一致）。 */
export const PROJECTION_TABLES = [
  'tasks',
  'workflows',
  'workflow_stages',
  'agents',
  'runtimes',
  'runs',
  'run_events',
  'conversations',
  'messages',
] as const

export type ProjectionTable = (typeof PROJECTION_TABLES)[number]

const projectionTableDdl: Record<ProjectionTable, string> = {
  tasks: tableDdl.tasks(),
  workflows: tableDdl.workflows(),
  workflow_stages: tableDdl.stages(),
  agents: tableDdl.agents(),
  runtimes: tableDdl.runtimes(),
  runs: tableDdl.runs(),
  run_events: tableDdl.runEvents(),
  conversations: tableDdl.conversations(),
  messages: tableDdl.messages(),
}

/** 九张投影表的 DDL 文本（按 PROJECTION_TABLES 顺序），投影指纹的 DDL 输入。 */
export const PROJECTION_DDL = PROJECTION_TABLES.map((table) => projectionTableDdl[table]).join('\n')

/** 指纹计算本身；参数化 DDL 只为验证「DDL 改一个字符 → 指纹不同」这类输入敏感度。 */
export function formatOfProjection(ddl: string, kernelVersion: string): string {
  return createHash('sha256').update(`${ddl}\n${kernelVersion}`).digest('hex')
}

/** 投影格式指纹 = sha256(九表投影 DDL + 内核版本)；任一变化即触发重建。 */
export function projectionFormat(kernelVersion: string): string {
  return formatOfProjection(PROJECTION_DDL, kernelVersion)
}

/**
 * 在单个事务内执行 `fn`：正常返回提交，抛错回滚并原样抛出。
 * 调用方保证不在已有事务内调用（node:sqlite 不支持嵌套事务）。
 */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
