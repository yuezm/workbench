/**
 * 宿主层 SQLite schema：全库 DDL 的唯一来源（M1 起从 main/ai-workflow 迁入）。
 *
 * 以字符串内嵌（而非 .sql 资源文件），保证 electron-vite 打包后主进程运行时也能拿到。
 * 十三张投影表（实体五表 + runs / run_events / conversations / messages / cards +
 * rule_sets / rule_fires + threads）全部可由事实重建：
 * 实体五表的列名与约束保持 v2 原样（M6 给 `tasks` 追加来源列、M6.5 追加线程两列，都不重建表）；
 * 运行/聊天四表在 M2 变为投影（runs 补调度列、`status` 加 `waiting`、`task_id` 可空；
 * 聊天投影从 `chat_*` 改名为 `conversations` / `messages`）；
 * M4 追加 `cards`（卡片行按 `(id, version)` 演进，投递状态单列）；
 * M6 追加 `rule_sets`（单行 id='current'：版本 + 整批规则）与 `rule_fires`（cron 触发记录，纯追加）；
 * M6.5 追加 `threads`（线程行整行由 `thread.*` 事实携带，`(source, external_ref)` 建索引）。
 * 过渡期 legacy `chat_conversations` / `chat_messages` 已由 T14b 迁成 `snapshot.imported`
 * 事实并删除（`host/store/import` 读旧表 → 写导入根 → 删表），这里不再创建它们。
 * `facts` 只追加，`projection_meta` 记录投影指纹与已折叠的 seq。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 2

const runtimesTable = (name = 'runtimes'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  executor_key TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT 'dsh',
  profile TEXT NOT NULL DEFAULT 'multica',
  args_template TEXT NOT NULL DEFAULT '',
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
  -- M7 跨工作流交接：目标工作流 / 目标阶段（可空；弱引用，不设外键，删除目标后由内核判缺失）
  handoff_workflow_id TEXT,
  handoff_stage_id TEXT,
  -- M8 子任务：默认落点阶段 / 子任务全部结束时的父任务处理 / 是否允许派生子任务
  subtask_stage_id TEXT,
  on_children_settled TEXT CHECK (on_children_settled IN ('wake','notify','complete')),
  spawn_policy TEXT CHECK (spawn_policy IN ('off','agent')),
  -- M9 阶段要干什么：进入本阶段的任务提示词里带的固定指令段（空串 = 没写）
  instructions TEXT NOT NULL DEFAULT '',
  -- M11 闸门：允许未通过次数 / 通过去向 / 未通过去向（三列全空 = 不是闸门；弱引用不设外键）
  gate_max_fails INTEGER,
  gate_on_pass_stage_id TEXT,
  gate_on_fail_stage_id TEXT,
  -- M18 内置阶段键（待办 / 已阻塞 / 已完成 / 已取消；NULL = 自己添加的阶段）
  builtin TEXT CHECK (builtin IN ('todo','blocked','done','cancelled')),
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, position)
);`

/**
 * `tasks` 投影：M6 追加来源四列（旧库由 `host/db.ts` 用 `ALTER TABLE ADD COLUMN` 补齐），
 * M6.5 追加线程两列（同一机制）。
 *
 * - `origin` = 人手建（`manual`）/ 规则命中（`rule`）/ 交接产物（`handoff`）；存量与手工任务默认 `manual`。
 * - `rule_id` / `external_ref` 记录命中的规则与入口键（同规则去重）；手工任务为 null。
 * - `labels_json` 存 `string[]` 的 JSON（规则声明的标签，展示用，不参与派活）。
 * - `thread_id` = 所属线程（M6.5，手工任务挂隐式线程）；`parent_task_id` = 派生它的父任务。
 *   两者都是弱引用（不设外键），旧行与老事实按 null 归一。
 * - `handoff_from_task_id` / `handoff_from_stage_id` = M7 交接来源任务与阶段（弱引用）。
 * - `project_id` = 所属项目（M10，弱引用；旧行 / 老事实按 null 归一为「未归属」）。
 */
const tasksTable = (name = 'tasks'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  current_stage_id TEXT REFERENCES workflow_stages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','rule','handoff','spawn')),
  rule_id TEXT,
  external_ref TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT,
  parent_task_id TEXT,
  spawned_by_run_id TEXT,
  batch_no INTEGER,
  spawn_key TEXT,
  handoff_from_task_id TEXT,
  handoff_from_stage_id TEXT,
  project_id TEXT,
  -- M11 闸门预算：当前阶段连续未通过次数（0 = 没失败过；旧行默认 0）
  gate_fails INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

/**
 * `projects` 投影（M10，第 16 张表）：与 `Project` 逐列对应，整行由 `project.*` 事实携带。
 *
 * - `name` / `path` 唯一性由内核在决策时校验（视图里比，不靠 SQL 约束）；
 * - `path` 是绝对路径，也是该项目任务的运行工作目录；目录是否存在由宿主与执行器负责；
 * - 不设外键：任务用弱引用指向项目，删项目由内核按「项目下没有任务」把关。
 */
const projectsTable = (name = 'projects'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
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

/**
 * 宿主私有运行进程登记表（M2 T13 / D11，**不进投影白名单 / 指纹**）。
 *
 * 记录「此刻本机为哪些 run 起了子进程」：调度器 spawn 前写占位行（pid 为空）、拿到 pid
 * 后回填、执行结束删除。崩溃重启时 `host/reconcile` 靠它找出需要终止的残留进程树；
 * 它不是业务事实，重建投影（`store.rebuild`）不该清它，因此不登记在
 * `PROJECTION_TABLES` / `tableDdl` / 投影指纹里。
 */
const processRegistryTable = (name = 'process_registry'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  run_id TEXT PRIMARY KEY,
  pid INTEGER,
  started_at TEXT NOT NULL
);`

const conversationsTable = (name = 'conversations'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  -- M11 项目：聊天与任务共用的顶层上下文（弱引用，不设外键；NULL = 默认目录，老行 / 老事实按 null 归一）
  project_id TEXT,
  session_id TEXT,
  -- M9 归档：非 NULL = 已归档（聊天清单默认不展示；只影响列表，不删消息/run）
  archived_at TEXT,
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
 * `cards` 投影（M4，第 10 张表）：与 `Card` 行逐列对应，整行由 `card.*` 事实携带。
 *
 * - `run_id` 是卡片归属；run 删除时按外键联删（宿主 `run.removed` 事实同时清卡片）。
 * - `task_id` / `conversation_id` 是展示用的弱引用：阶段 run 挂任务、聊天 run 挂对话，
 *   历史卡片不因任务/对话删除而抹掉归属（不设外键）。
 * - `delivery` 单列 =「已送达至少一个通道」；`delivery_ref` 记最后一个成功通道。
 * - `kind`（M12）= 通知口径的判据：`ask` 要人作答（阻塞续接），`notice` 只知会（不发系统通知）；
 *   老库补列时默认 `ask`，重建投影按事实归一（`kernel/project.normalizeCard`）。
 * - `options_json` 存 `string[]` 的 JSON；`version` 是投递去重键的一部分。
 */
const cardsTable = (name = 'cards'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  conversation_id TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'ask' CHECK (kind IN ('ask','notice')),
  options_json TEXT NOT NULL DEFAULT '[]',
  key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('open','answered','resolved')),
  delivery TEXT NOT NULL CHECK (delivery IN ('pending','delivered','failed')),
  delivery_ref TEXT,
  option_index INTEGER,
  answered_by TEXT CHECK (answered_by IN ('ui','channel')),
  answered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

/**
 * `rule_sets` 投影（M6，第 11 张表）：单行 `id='current'`，整批替换语义。
 *
 * - `version` 随 `rules.replaced` +1；`replaced_at` 是该版本生效时刻（cron 规则首次触发的基线）。
 * - `rules_json` 存 `AutomationRule[]` 的 JSON（校验在上游，投影只搬运）。
 * - 单行约束用 `CHECK (id = 'current')` 收口：版本与规则删空后仍保留一行，避免「空集丢版本」。
 */
const ruleSetsTable = (name = 'rule_sets'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  version INTEGER NOT NULL,
  replaced_at TEXT NOT NULL,
  rules_json TEXT NOT NULL DEFAULT '[]'
);`

/**
 * `rule_fires` 投影（M6，第 12 张表）：cron 到点触发记录，**纯追加**。
 *
 * - 主键 `id` 由内核生成；重复触发事实撞主键即报错（与 `run_events` 同口径，不覆盖历史）。
 * - `scheduled_for` 是计划时刻（去重与「只补最近一次」的基线），`fired_at` 是实际入账时刻。
 * - `task_id` 是弱引用：目标工作流/阶段已不存在时只记账（null），任务删除后也保留审计；
 *   不设外键（与 `cards.task_id` 同口径）。
 */
const ruleFiresTable = (name = 'rule_fires'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  task_id TEXT
);`

/**
 * `threads` 投影（M6.5，第 13 张表）：与 `ThreadRow` 逐列对应，整行由 `thread.*` 事实携带。
 *
 * - 身份 `(source, external_ref)`：`external_ref` 可为 null（手工任务的隐式线程），
 *   因此索引不是唯一索引；绑定目标键唯一性由内核在决策时校验。
 * - `task_ids_json` / `root_task_ids_json` 存 `string[]`；`notes_json` 存 `ThreadNote[]`、
 *   `events_json` 存 `ThreadEventRef[]`（各自有上限、保最新）。
 * - **`sessions` 不落列**：由 `runs` 现算（`thread.byId` 视图），避免每轮回执再写线程事实。
 * - `status` 只有 `open` / `closed`（关闭原因只进事实，不进投影）。
 */
const threadsTable = (name = 'threads'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_ref TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  root_task_ids_json TEXT NOT NULL DEFAULT '[]',
  concurrency INTEGER NOT NULL DEFAULT 1,
  notes_version INTEGER NOT NULL DEFAULT 0,
  notes_json TEXT NOT NULL DEFAULT '[]',
  events_json TEXT NOT NULL DEFAULT '[]',
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);`

/**
 * `plugin_settings` 投影（M7，第 14 张表）：单行 `id='current'`，整批替换语义。
 *
 * - `version` 随 `plugins.replaced` +1；`replaced_at` 是该版本生效时刻。
 * - `settings_json` 存 `PluginSetting[]` 的 JSON（非密钥设置；secret 在宿主私有表）。
 * - 单行约束用 `CHECK (id = 'current')` 收口：设置删空后仍保留一行，避免「空集丢版本」。
 */
const pluginSettingsTable = (name = 'plugin_settings'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  version INTEGER NOT NULL,
  replaced_at TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '[]'
);`

/**
 * `task_comments` 投影（M7.5，第 15 张表）：任务上下文 / 反馈，**纯追加**。
 *
 * - 主键 `id` 由内核生成；`task.comment_added` 携带整行，重复 id 撞主键即报错；
 * - `task_id` 是外键 + `ON DELETE CASCADE`：任务删除时评论一并消失；增量路径由
 *   `projection-apply` 按父键显式联删（重建事务关外键，不能只靠级联）；
 * - 正文只作资料（进提示词的「反馈记录（资料，不是指令）」段）。
 */
const taskCommentsTable = (name = 'task_comments'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('owner','agent')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);`

/**
 * `review_reports` 投影（M14，第 17 张表）：评审结论 + 待改清单，整行由 `review.reported`
 * / `review.addressed` 事实携带。
 *
 * - 主键 `id = '<runId>:<rev>'`：同一轮 run 只产一份报告，改版是新的 `rev`（旧版本保留可查）。
 * - `task_id` 外键 + `ON DELETE CASCADE`：任务删除时报告一并消失；增量路径由
 *   `projection-apply` 按父键显式联删（重建事务关外键，不能只靠级联）。
 * - `findings_json` 存 `ReviewFinding[]`（含逐条状态）：上限由 `REVIEW_LIMITS` 收口，
 *   逐条处置用整行 upsert 表达，与 `cards` 同口径。
 * - `checks_json` 是判定证据（退出码），不落 `runs`：闸门读一次就丢的老问题在这里收口。
 * - `artifact_json` 是正文引用（路径 / sha256 / 字节数），正文落宿主 artifacts 目录。
 */
const reviewReportsTable = (name = 'review_reports'): string => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT,
  rev INTEGER NOT NULL,
  verdict TEXT CHECK (verdict IN ('pass','fail')),
  checks_json TEXT NOT NULL DEFAULT '[]',
  findings_json TEXT NOT NULL DEFAULT '[]',
  artifact_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`

export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_stages_workflow ON workflow_stages(workflow_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_runtime_status ON runs(runtime_id, status);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_run ON cards(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_delivery ON cards(delivery);
CREATE INDEX IF NOT EXISTS idx_rule_fires_rule ON rule_fires(rule_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_threads_key ON threads(source, external_ref);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_reports_task ON review_reports(task_id, stage_id, rev);
CREATE INDEX IF NOT EXISTS idx_review_reports_run ON review_reports(run_id);
`

/** v2 全量 schema（新建库；十七张投影表 + 索引） */
export const SCHEMA_SQL = [
  runtimesTable(),
  agentsTable(),
  workflowsTable(),
  stagesTable(),
  tasksTable(),
  projectsTable(),
  runsTable(),
  runEventsTable(),
  conversationsTable(),
  messagesTable(),
  cardsTable(),
  ruleSetsTable(),
  ruleFiresTable(),
  threadsTable(),
  pluginSettingsTable(),
  taskCommentsTable(),
  reviewReportsTable(),
  INDEX_SQL,
].join('\n')

/**
 * 命令幂等表（M5）：**非投影表**，不属于 `PROJECTION_TABLES`，重建不清空。
 *
 * `first_seq` / `fact_count` 指向该命令产生的事实区间（零事实命令为 0 / 0）；
 * 命中即按区间回放原结果、不重复产事实。reject 不记录（允许重试）。
 */
export const COMMANDS_SQL = `
CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  first_seq INTEGER NOT NULL,
  fact_count INTEGER NOT NULL,
  at TEXT NOT NULL
);`

/**
 * 宿主私有进程登记表 DDL：与 `FACTS_SQL` 一样单独执行（不进业务表清单，
 * 也就不在 `SCHEMA_SQL` 的「十四张投影表」断言范围内）。
 */
export const PROCESS_REGISTRY_SQL = processRegistryTable()

/**
 * 插件 secret 表（M7）：**宿主私有表**，不属于 `PROJECTION_TABLES`，重建不清空。
 *
 * - 只存密文（`value_cipher` 由装配根注入的 `safeStorage` 实现加密）；
 * - 不进事实日志、不进视图（视图只回键名）、不进快照与导出（`db:export` 只导投影表）；
 * - 主键 `(plugin_id, key)`；写入/删除由宿主命令路由完成（不经内核 decide）。
 */
export const PLUGIN_SECRETS_SQL = `
CREATE TABLE IF NOT EXISTS plugin_secrets (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_cipher TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);`

/** 供迁移重建复用：生成指名字表的 DDL */
export const tableDdl = {
  runtimes: runtimesTable,
  agents: agentsTable,
  workflows: workflowsTable,
  stages: stagesTable,
  tasks: tasksTable,
  projects: projectsTable,
  runs: runsTable,
  runEvents: runEventsTable,
  conversations: conversationsTable,
  messages: messagesTable,
  cards: cardsTable,
  ruleSets: ruleSetsTable,
  ruleFires: ruleFiresTable,
  threads: threadsTable,
  pluginSettings: pluginSettingsTable,
  taskComments: taskCommentsTable,
  reviewReports: reviewReportsTable,
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
 * M3 给 `runtimes` 新增的列（旧库 `CREATE TABLE IF NOT EXISTS` 不会补列，且
 * `protocol_family` 被 CHECK 引用不能 `DROP COLUMN`）：缺任一列即触发一次性物理升级。
 * 清单与 `runtimesTable()` 的 DDL 保持同步（新增列必须同时改这里）。
 */
export const RUNTIMES_M3_ADDED_COLUMNS = ['executor_key', 'args_template'] as const

/**
 * 旧 `runtimes` 行 → 新 `runtimes` 行（指名字表）的拷贝 SQL。
 *
 * M3 口径：旧库只有协议族 `protocol_family`（当前取值仅 `dsh`），它按「旧协议族 = 执行器键」
 * 的映射回填；`args_template` 补空串。旧库的表名固定是 `runtimes`。
 */
export function legacyRuntimesCopySql(targetTable: string): string {
  return `INSERT INTO ${targetTable} (
    id, name, executor_key, command, profile, args_template, permission_mode, model,
    reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at
  )
  SELECT
    id, name, protocol_family, command, profile, '', permission_mode, model,
    reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at
  FROM runtimes`
}

/**
 * M6 给 `tasks` 新增的列（旧库 `CREATE TABLE IF NOT EXISTS` 不会补列）。
 *
 * 这里只补列、**不重建表**：`runs.task_id` 有 `REFERENCES tasks(id) ON DELETE CASCADE`，
 * 建临时表 + 改名会让 SQLite 重写其它表里的外键引用（`host/db.ts` 的 M2 注释记录了该坑）。
 * `ALTER TABLE ADD COLUMN` 不会改动既有行，旧行按默认值得 `origin='manual'` / 空引用 / 空标签。
 * 清单与 `tasksTable()` 的 DDL 保持同步（新增列必须同时改这里）。
 */
export const TASKS_M6_ADDED_COLUMNS = ['origin', 'rule_id', 'external_ref', 'labels_json'] as const

/** `tasks` 补列语句（逐列 `ALTER TABLE`，SQLite 一次只能加一列；默认值与 DDL 一致）。 */
export const TASKS_M6_ADD_COLUMN_SQL: Readonly<
  Record<(typeof TASKS_M6_ADDED_COLUMNS)[number], string>
> = {
  origin:
    "ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','rule'))",
  rule_id: 'ALTER TABLE tasks ADD COLUMN rule_id TEXT',
  external_ref: 'ALTER TABLE tasks ADD COLUMN external_ref TEXT',
  labels_json: "ALTER TABLE tasks ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'",
}

/**
 * M6.5 给 `tasks` 新增的列（线程与父任务）：与 M6 同一机制（`ALTER TABLE ADD COLUMN`，不重建表）。
 *
 * 两列都可空、无默认值：旧行与 v2 存量导入后按 null 归一（「不属于任何线程」/「不是派生任务」）。
 * 清单与 `tasksTable()` 的 DDL 保持同步（新增列必须同时改这里）。
 */
export const TASKS_M65_ADDED_COLUMNS = ['thread_id', 'parent_task_id'] as const

/** `tasks` M6.5 补列语句（默认值与 DDL 一致：可空、无 DEFAULT）。 */
export const TASKS_M65_ADD_COLUMN_SQL: Readonly<
  Record<(typeof TASKS_M65_ADDED_COLUMNS)[number], string>
> = {
  thread_id: 'ALTER TABLE tasks ADD COLUMN thread_id TEXT',
  parent_task_id: 'ALTER TABLE tasks ADD COLUMN parent_task_id TEXT',
}

/**
 * M7 给 `workflow_stages` 新增的列（跨工作流交接目标）。
 *
 * 两列都可空、无默认值；`ALTER TABLE ADD COLUMN` 只增不改，不影响既有行。
 * 清单与 `stagesTable()` 的 DDL 保持同步（新增列必须同时改这里）。
 */
export const STAGES_M7_ADDED_COLUMNS = ['handoff_workflow_id', 'handoff_stage_id'] as const

/** `workflow_stages` M7 补列语句（可空、无 DEFAULT）。 */
export const STAGES_M7_ADD_COLUMN_SQL: Readonly<
  Record<(typeof STAGES_M7_ADDED_COLUMNS)[number], string>
> = {
  handoff_workflow_id: 'ALTER TABLE workflow_stages ADD COLUMN handoff_workflow_id TEXT',
  handoff_stage_id: 'ALTER TABLE workflow_stages ADD COLUMN handoff_stage_id TEXT',
}

/**
 * M7 给 `tasks` 新增的列（交接来源）。
 *
 * 注意：M7 同时把 `origin` 的 CHECK 扩成 `('manual','rule','handoff')`，而 SQLite 不能
 * `ALTER TABLE` 改 CHECK —— 因此旧库首启时 `tasks` 与 M2 `runs` / M3 `runtimes` 同法做
 * 一次性物理重建（见 `host/db.ts`）。新库直接由 `tasksTable()` 建出完整结构。
 */
export const TASKS_M7_ADDED_COLUMNS = ['handoff_from_task_id', 'handoff_from_stage_id'] as const

/** `tasks` M7 补列语句：只用于「列已齐全但 CHECK 已是新口径」的异常状态兜底。 */
export const TASKS_M7_ADD_COLUMN_SQL: Readonly<
  Record<(typeof TASKS_M7_ADDED_COLUMNS)[number], string>
> = {
  handoff_from_task_id: 'ALTER TABLE tasks ADD COLUMN handoff_from_task_id TEXT',
  handoff_from_stage_id: 'ALTER TABLE tasks ADD COLUMN handoff_from_stage_id TEXT',
}

/**
 * M8 给 `workflow_stages` 新增的列（子任务落点 / rollup / 派发策略）。
 * 三列都可空、无默认值；`ALTER TABLE ADD COLUMN` 只增不改。清单与 `stagesTable()` 同步。
 */
export const STAGES_M8_ADDED_COLUMNS = [
  'subtask_stage_id',
  'on_children_settled',
  'spawn_policy',
] as const

/** `workflow_stages` M8 补列语句（可空、无 DEFAULT）。 */
export const STAGES_M8_ADD_COLUMN_SQL: Readonly<
  Record<(typeof STAGES_M8_ADDED_COLUMNS)[number], string>
> = {
  subtask_stage_id: 'ALTER TABLE workflow_stages ADD COLUMN subtask_stage_id TEXT',
  on_children_settled:
    "ALTER TABLE workflow_stages ADD COLUMN on_children_settled TEXT CHECK (on_children_settled IN ('wake','notify','complete'))",
  spawn_policy:
    "ALTER TABLE workflow_stages ADD COLUMN spawn_policy TEXT CHECK (spawn_policy IN ('off','agent'))",
}

/**
 * M9 给 `workflow_stages` 新增的列（阶段要干什么）。
 *
 * 有 DEFAULT ''（老阶段按「没写」归一，与内核 `normalizeStage` 一致）；`ALTER TABLE ADD COLUMN`
 * 只增不改。清单与 `stagesTable()` 的 DDL 保持同步（新增列必须同时改这里）。
 */
export const STAGES_M9_ADDED_COLUMNS = ['instructions'] as const

/** `workflow_stages` M9 补列语句（默认值与 DDL 一致）。 */
export const STAGES_M9_ADD_COLUMN_SQL: Readonly<
  Record<(typeof STAGES_M9_ADDED_COLUMNS)[number], string>
> = {
  instructions: "ALTER TABLE workflow_stages ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
}

/**
 * M9 给 `conversations` 新增的列（归档时间）：可空、无 DEFAULT —— 老对话按「未归档」归一。
 * 清单与 `conversationsTable()` 的 DDL 保持同步。
 */
export const CONVERSATIONS_M9_ADDED_COLUMNS = ['archived_at'] as const

/** `conversations` M9 补列语句（可空、无 DEFAULT）。 */
export const CONVERSATIONS_M9_ADD_COLUMN_SQL: Readonly<
  Record<(typeof CONVERSATIONS_M9_ADDED_COLUMNS)[number], string>
> = {
  archived_at: 'ALTER TABLE conversations ADD COLUMN archived_at TEXT',
}

/**
 * M11 给 `conversations` 新增的列（所属项目）：可空、无 DEFAULT —— 老对话按「默认目录」归一。
 * 清单与 `conversationsTable()` 的 DDL 保持同步。
 */
export const CONVERSATIONS_M11_ADDED_COLUMNS = ['project_id'] as const

/** `conversations` M11 补列语句（可空、无 DEFAULT）。 */
export const CONVERSATIONS_M11_ADD_COLUMN_SQL: Readonly<
  Record<(typeof CONVERSATIONS_M11_ADDED_COLUMNS)[number], string>
> = {
  project_id: 'ALTER TABLE conversations ADD COLUMN project_id TEXT',
}

/**
 * M12 给 `cards` 新增的列（卡片类型）：`ask` 要人作答并阻塞续接，`notice` 只知会。
 * 老库补列时默认 `ask`（与老口径「有选项才是阻塞卡」不同，故重建投影时按事实归一：
 * `kernel/project.normalizeCard` 用 `options` 是否为空补齐历史行）。
 */
export const CARDS_M12_ADDED_COLUMNS = ['kind'] as const

/** `cards` M12 补列语句（带常量 DEFAULT，NOT NULL 才合法）。 */
export const CARDS_M12_ADD_COLUMN_SQL: Readonly<
  Record<(typeof CARDS_M12_ADDED_COLUMNS)[number], string>
> = {
  kind: "ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask' CHECK (kind IN ('ask','notice'))",
}

/**
 * M8 给 `tasks` 新增的列（spawn 来源 / 批次 / 幂等键）。 * 注意：M8 同时把 `origin` 的 CHECK 扩成 `('manual','rule','handoff','spawn')`，SQLite 不能
 * `ALTER TABLE` 改 CHECK —— 旧库首启时与 M7 同法物理重建 `tasks`（见 `host/db.ts`）。
 */
export const TASKS_M8_ADDED_COLUMNS = ['spawned_by_run_id', 'batch_no', 'spawn_key'] as const

/** `tasks` M8 补列语句：只用于「列缺但 CHECK 已是新口径」的异常状态兜底。 */
export const TASKS_M8_ADD_COLUMN_SQL: Readonly<
  Record<(typeof TASKS_M8_ADDED_COLUMNS)[number], string>
> = {
  spawned_by_run_id: 'ALTER TABLE tasks ADD COLUMN spawned_by_run_id TEXT',
  batch_no: 'ALTER TABLE tasks ADD COLUMN batch_no INTEGER',
  spawn_key: 'ALTER TABLE tasks ADD COLUMN spawn_key TEXT',
}

/**
 * M10 给 `tasks` 新增的列（所属项目）：可空、无 DEFAULT —— 旧行按「未归属」归一。
 * 清单与 `tasksTable()` 的 DDL 保持同步。
 */
export const TASKS_M10_ADDED_COLUMNS = ['project_id'] as const

/** `tasks` M10 补列语句（可空、无 DEFAULT）。 */
export const TASKS_M10_ADD_COLUMN_SQL: Readonly<
  Record<(typeof TASKS_M10_ADDED_COLUMNS)[number], string>
> = {
  project_id: 'ALTER TABLE tasks ADD COLUMN project_id TEXT',
}

/**
 * M11 给 `workflow_stages` 新增的列（闸门）：三列都可空，三列全空表示「不是闸门」。
 * 去向两列是弱引用（删阶段后由内核判缺失，与 M7 交接同口径）。
 * 清单与 `stagesTable()` 的 DDL 保持同步。
 */
export const STAGES_M11_ADDED_COLUMNS = [
  'gate_max_fails',
  'gate_on_pass_stage_id',
  'gate_on_fail_stage_id',
] as const

/** `workflow_stages` M11 补列语句（可空、无 DEFAULT）。 */
export const STAGES_M11_ADD_COLUMN_SQL: Readonly<
  Record<(typeof STAGES_M11_ADDED_COLUMNS)[number], string>
> = {
  gate_max_fails: 'ALTER TABLE workflow_stages ADD COLUMN gate_max_fails INTEGER',
  gate_on_pass_stage_id: 'ALTER TABLE workflow_stages ADD COLUMN gate_on_pass_stage_id TEXT',
  gate_on_fail_stage_id: 'ALTER TABLE workflow_stages ADD COLUMN gate_on_fail_stage_id TEXT',
}

/**
 * M11 给 `tasks` 新增的列（闸门预算）：有 DEFAULT 0 —— 旧行按「没失败过」归一，
 * 与内核 `normalizeTask` 一致。清单与 `tasksTable()` 的 DDL 保持同步。
 */
export const TASKS_M11_ADDED_COLUMNS = ['gate_fails'] as const

/** `tasks` M11 补列语句（默认值与 DDL 一致）。 */
export const TASKS_M11_ADD_COLUMN_SQL: Readonly<
  Record<(typeof TASKS_M11_ADDED_COLUMNS)[number], string>
> = {
  gate_fails: 'ALTER TABLE tasks ADD COLUMN gate_fails INTEGER NOT NULL DEFAULT 0',
}

/**
 * M18 给 `workflow_stages` 新增的列（内置阶段键）：可空、无 DEFAULT ——
 * 旧行按「自己添加的阶段」归一（null），内置行由启动补齐写成四个固定键之一。
 * 清单与 `stagesTable()` 的 DDL 保持同步。
 */
export const STAGES_M18_ADDED_COLUMNS = ['builtin'] as const

/** `workflow_stages` M18 补列语句（可空、无 DEFAULT；CHECK 与 DDL 一致）。 */
export const STAGES_M18_ADD_COLUMN_SQL: Readonly<
  Record<(typeof STAGES_M18_ADDED_COLUMNS)[number], string>
> = {
  builtin:
    "ALTER TABLE workflow_stages ADD COLUMN builtin TEXT CHECK (builtin IN ('todo','blocked','done','cancelled'))",
}

/**
 * 旧 `tasks` 行 → 新 `tasks` 行（指名字表）的拷贝 SQL（M7 `tasks` 物理重建用）。
 *
 * 旧库可能缺 M6 / M6.5 / M7 的任一列：按 `columns` 逐列决定「取旧值」还是「补字面量」，
 * 因此同一函数能覆盖 v1/v2 老库到 M6.5 库的全部状态。列清单与新 `tasksTable()` 一致。
 */
export function legacyTasksCopySql(targetTable: string, columns: ReadonlySet<string>): string {
  const pick = (column: string, fallback: string): string =>
    columns.has(column) ? column : fallback
  return `INSERT INTO ${targetTable} (
    id, title, description, workflow_id, current_stage_id, status, origin, rule_id,
    external_ref, labels_json, thread_id, parent_task_id, spawned_by_run_id, batch_no,
    spawn_key, handoff_from_task_id, handoff_from_stage_id, project_id, gate_fails,
    created_at, updated_at
  )
  SELECT
    id, title, description, workflow_id, current_stage_id, status,
    ${pick('origin', "'manual'")}, ${pick('rule_id', 'NULL')},
    ${pick('external_ref', 'NULL')}, ${pick('labels_json', "'[]'")},
    ${pick('thread_id', 'NULL')}, ${pick('parent_task_id', 'NULL')},
    ${pick('spawned_by_run_id', 'NULL')}, ${pick('batch_no', 'NULL')},
    ${pick('spawn_key', 'NULL')},
    ${pick('handoff_from_task_id', 'NULL')}, ${pick('handoff_from_stage_id', 'NULL')},
    ${pick('project_id', 'NULL')}, ${pick('gate_fails', '0')},
    created_at, updated_at
  FROM tasks`
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

/** 投影集白名单：重建清空并重放的就是这十七张表（与 `kernel/types` 的 `PROJECTION_TABLES` 一致）。 */
export const PROJECTION_TABLES = [
  'tasks',
  'workflows',
  'workflow_stages',
  'agents',
  'runtimes',
  'projects',
  'runs',
  'run_events',
  'conversations',
  'messages',
  'cards',
  'rule_sets',
  'rule_fires',
  'threads',
  'plugin_settings',
  'task_comments',
  'review_reports',
] as const

export type ProjectionTable = (typeof PROJECTION_TABLES)[number]

const projectionTableDdl: Record<ProjectionTable, string> = {
  tasks: tableDdl.tasks(),
  workflows: tableDdl.workflows(),
  workflow_stages: tableDdl.stages(),
  agents: tableDdl.agents(),
  runtimes: tableDdl.runtimes(),
  projects: tableDdl.projects(),
  runs: tableDdl.runs(),
  run_events: tableDdl.runEvents(),
  conversations: tableDdl.conversations(),
  messages: tableDdl.messages(),
  cards: tableDdl.cards(),
  rule_sets: tableDdl.ruleSets(),
  rule_fires: tableDdl.ruleFires(),
  threads: tableDdl.threads(),
  plugin_settings: tableDdl.pluginSettings(),
  task_comments: tableDdl.taskComments(),
  review_reports: tableDdl.reviewReports(),
}

/** 十七张投影表的 DDL 文本（按 PROJECTION_TABLES 顺序），投影指纹的 DDL 输入。 */
export const PROJECTION_DDL = PROJECTION_TABLES.map((table) => projectionTableDdl[table]).join('\n')

/** 指纹计算本身；参数化 DDL 只为验证「DDL 改一个字符 → 指纹不同」这类输入敏感度。 */
export function formatOfProjection(ddl: string, kernelVersion: string): string {
  return createHash('sha256').update(`${ddl}\n${kernelVersion}`).digest('hex')
}

/** 投影格式指纹 = sha256(十三表投影 DDL + 内核版本)；任一变化即触发重建。 */
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
