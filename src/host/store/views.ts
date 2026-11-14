/**
 * 视图装载与查询。
 *
 * - `loadView`：按 `kernel.viewSpec(input)` 给出的投影表切片装载只读视图，外加活跃 run 的
 *   任务集合（内核判断「执行中」只认它）；内核不查库。`run_events` 不进 `View`（只在
 *   写入/重建时经 `project` 落库）。
 * - `queryView`：`query(view, params)` 的读路径，行 → 协议行类型（`protocol/entities`）。
 *
 * 两张读路径都逐列写死 SELECT，不 `SELECT *`：列名变更必须在这里同步。
 */
import type { DatabaseSync } from 'node:sqlite'
import { nextRuleFires, previewEvent } from '../../kernel/scopes/rules'
import type { UsageAgentRow, UsageDailyRow, UsageTotals } from '../../protocol/views'
import type { EventRow, RuleSkip } from '../../kernel/core/types'
import type {
  Access,
  Agent,
  Card,
  CardAnswerVia,
  CardDelivery,
  CardKind,
  CardStatus,
  ChatRole,
  Conversation,
  EntryMode,
  Message,
  PermissionMode,
  Project,
  Run,
  RunDeliverables,
  RunErrorCode,
  RunEvent,
  RunPurpose,
  RunRow,
  RunStatus,
  RunUsage,
  Runtime,
  RuntimeProbe,
  RuntimeStatus,
  Task,
  TaskOrigin,
  TaskStatus,
  Workflow,
  WorkflowStage,
  WorkflowWithStages,
} from '../../protocol/entities'
import type { RuleSetRow, RuleSetView } from '../../protocol/rules'
import type { PluginSettingsRow, PluginSettingsView } from '../../protocol/plugins'
import type { ThreadRow } from '../../protocol/thread'
import type { TaskComment } from '../../protocol/task-comment'
import type { ReviewArtifact, ReviewReport } from '../../protocol/review'
import type {
  ActiveRun,
  RuntimeWorkload,
  StaleChatRun,
  ThreadDetail,
  ViewId,
  WaitingRun,
  WorkflowStageMetrics,
} from '../../protocol/views'
import { VIEW_IDS } from '../../protocol/views'
import type { Id, Iso, ProjectionTable, View } from '../../kernel/core/types'
import { lastSeq } from './facts'
import { parseAgentEnv } from './agent-env'
import { StoreError } from './errors'

interface WorkflowRow {
  id: string
  name: string
  description: string
  created_at: string
}

interface StageRow {
  id: string
  workflow_id: string
  name: string
  position: number
  entry_mode: string
  /** M18 内置阶段键（NULL = 自己添加的阶段） */
  builtin: string | null
  agent_id: string | null
  /** M32 出口表（JSON 对象文本；老行由启动补齐写全） */
  exits_json: string
  /** 旧 M11 闸门两列（已不读，保留在表里等清理） */
  on_complete_stage_id: string | null
  on_reject_stage_id: string | null
  /** M29 派单（JSON 数组文本；老行由投影迁移补 '[]'） */
  handoffs_json: string
  subtask_stage_id: string | null
  on_children_settled: string | null
  spawn_policy: string | null
  instructions: string
  /** M20 验收条目（JSON 数组文本；`[]` = 未声明） */
  acceptance_json: string
  /** M26 阶段单轮运行超时（毫秒；NULL = 用全局缺省） */
  run_timeout_ms: number | null
  /** M32 判定者（JSON 文本；`null` = 不判定） */
  judge_json: string
  /** M40 阶段脚本（JSON 文本；`null` = 不是脚本阶段） */
  script_json: string
}

interface AgentRow {
  id: string
  name: string
  description: string
  runtime_id: string
  system_prompt: string
  model: string | null
  reasoning_effort: string | null
  max_concurrent: number
  permission_mode: string
  workdir: string | null
  env_json: string
  created_at: string
}

interface RuntimeRow {
  id: string
  name: string
  executor_key: string
  command: string
  profile: string
  args_template: string
  enabled: number
  last_probe_json: string | null
  created_at: string
}

interface TaskRow {
  id: string
  title: string
  description: string
  workflow_id: string
  project_id: string | null
  current_stage_id: string | null
  status: string
  origin: string
  rule_id: string | null
  external_ref: string | null
  labels_json: string
  thread_id: string | null
  parent_task_id: string | null
  spawned_by_run_id: string | null
  batch_no: number | null
  spawn_key: string | null
  handoff_from_task_id: string | null
  handoff_from_stage_id: string | null
  /** M30 派单来源 run（人工离开为 NULL） */
  handoff_from_run_id: string | null
  /** M11 闸门预算：当前阶段连续未通过次数 */
  gate_fails: number
  created_at: string
  updated_at: string
}

/** `projects` 投影的整行（列与 `host/schema` 的 DDL 一一对应）。 */
interface ProjectRow {
  id: string
  name: string
  path: string
  description: string
  created_at: string
  updated_at: string
}

/** `threads` 投影的整行（列与 `host/schema` 的 DDL 一一对应）。 */
interface ThreadDbRow {
  id: string
  source: string
  external_ref: string | null
  title: string
  status: string
  task_ids_json: string
  root_task_ids_json: string
  concurrency: number
  notes_version: number
  notes_json: string
  events_json: string
  last_activity_at: string
  created_at: string
}

/** `rule_sets` 单行投影（列与 `host/schema` 的 DDL 一一对应）。 */
interface RuleSetDbRow {
  id: string
  version: number
  replaced_at: string
  rules_json: string
}

/** `plugin_settings` 单行投影（列与 `host/schema` 的 DDL 一一对应）。 */
interface PluginSettingsDbRow {
  id: string
  version: number
  replaced_at: string
  settings_json: string
}

/** `runs` 投影的整行（列与 `host/schema` 的 DDL 一一对应）。 */
interface RunDbRow {
  id: string
  purpose: string
  task_id: string | null
  stage_id: string | null
  agent_id: string | null
  runtime_id: string | null
  conversation_id: string | null
  rule_id: string | null
  rules_version: number
  executor_key: string
  thread_id: string | null
  cwd: string
  access: string
  skill: string | null
  prompt_ref: string | null
  event_ids_json: string
  hops: number
  turn: number
  resume_session_id: string | null
  thread_context_ref: string | null
  queue_seq: number
  status: string
  prompt: string
  output: string
  error: string | null
  error_code: string | null
  exit_code: number | null
  session_id: string | null
  usage_json: string | null
  duration_ms: number | null
  lease_id: string | null
  attempt: number
  attempts: number
  lease_until: string | null
  not_before: string | null
  deadline_at: string | null
  cancel_requested: number
  deliverables_json: string | null
  /** M40 脚本 run 的执行配置快照（JSON；`null` = 不是脚本轮） */
  script_json: string
  started_at: string | null
  ended_at: string | null
  created_at: string
}

interface ConversationRow {
  id: string
  title: string
  agent_id: string
  /** M11 所属项目（NULL = 默认目录） */
  project_id: string | null
  session_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  error: string | null
  created_at: string
}

/** `cards` 投影的整行（列与 `host/schema` 的 DDL 一一对应）。 */
interface CardDbRow {
  id: string
  run_id: string
  task_id: string | null
  conversation_id: string | null
  title: string
  text: string
  kind: string
  options_json: string
  key: string | null
  version: number
  status: string
  delivery: string
  delivery_ref: string | null
  delivery_attempts: number
  next_delivery_at: string | null
  delivery_given_up: number
  option_index: number | null
  answered_by: string | null
  answered_at: string | null
  created_at: string
  updated_at: string
}

interface ActiveRunRow {
  id: string
  /** 聊天 run 不挂任务；阶段 run 才有 */
  task_id: string | null
  stage_id: string | null
  status: string
}

const mapWorkflow = (row: WorkflowRow): Workflow => ({
  id: row.id,
  name: row.name,
  description: row.description,
  createdAt: row.created_at,
})

const mapStage = (row: StageRow): WorkflowStage => ({
  id: row.id,
  workflowId: row.workflow_id,
  name: row.name,
  position: row.position,
  entryMode: row.entry_mode as EntryMode,
  builtin: row.builtin as WorkflowStage['builtin'],
  agentId: row.agent_id,
  // M40：坏 JSON / 空串 / 'null' 按「不是脚本阶段」归一
  script:
    row.script_json === undefined || row.script_json.trim() === '' || row.script_json === 'null'
      ? null
      : (JSON.parse(row.script_json) as WorkflowStage['script']),
  exits:
    row.exits_json === undefined || row.exits_json.trim() === ''
      ? {}
      : (JSON.parse(row.exits_json) as WorkflowStage['exits']),
  // M32：判定者只剩护栏；旧行没有该列时按「不判定」归一
  judge:
    row.judge_json === undefined || row.judge_json.trim() === '' || row.judge_json === 'null'
      ? null
      : (JSON.parse(row.judge_json) as WorkflowStage['judge']),
  // M29：坏 JSON / 空串按「不派单」归一，不让一条脏行把整张视图读挂
  handoffs:
    row.handoffs_json === undefined || row.handoffs_json.trim() === ''
      ? []
      : (JSON.parse(row.handoffs_json) as WorkflowStage['handoffs']),
  subtaskStageId: row.subtask_stage_id,
  onChildrenSettled: row.on_children_settled as WorkflowStage['onChildrenSettled'],
  spawnPolicy: row.spawn_policy as WorkflowStage['spawnPolicy'],
  instructions: row.instructions,
  // M20：坏 JSON / 空串按「未声明」归一，不让一条脏行把整张视图读挂
  acceptance:
    row.acceptance_json.trim() === '' ? [] : (JSON.parse(row.acceptance_json) as string[]),
  // M26：阶段超时（NULL = 用全局缺省）
  runTimeoutMs: row.run_timeout_ms ?? null,
})

const mapAgent = (row: AgentRow): Agent => ({
  id: row.id,
  name: row.name,
  description: row.description,
  runtimeId: row.runtime_id,
  systemPrompt: row.system_prompt,
  model: row.model,
  reasoningEffort: row.reasoning_effort,
  maxConcurrent: row.max_concurrent,
  permissionMode: row.permission_mode as PermissionMode,
  workdir: row.workdir,
  env: parseAgentEnv(row.env_json),
  createdAt: row.created_at,
})

const mapRuntime = (row: RuntimeRow): Runtime => ({
  id: row.id,
  name: row.name,
  executorKey: row.executor_key,
  command: row.command,
  profile: row.profile,
  argsTemplate: row.args_template,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastProbe:
    row.last_probe_json === null ? null : (JSON.parse(row.last_probe_json) as RuntimeProbe),
})

const mapTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  description: row.description,
  workflowId: row.workflow_id,
  projectId: row.project_id,
  currentStageId: row.current_stage_id,
  status: row.status as TaskStatus,
  origin: row.origin as TaskOrigin,
  ruleId: row.rule_id,
  externalRef: row.external_ref,
  labels: JSON.parse(row.labels_json) as string[],
  threadId: row.thread_id,
  parentTaskId: row.parent_task_id,
  spawnedByRunId: row.spawned_by_run_id,
  batchNo: row.batch_no,
  spawnKey: row.spawn_key,
  handoffFromTaskId: row.handoff_from_task_id,
  handoffFromStageId: row.handoff_from_stage_id,
  handoffFromRunId: row.handoff_from_run_id ?? null,
  gateFails: row.gate_fails,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** `projects` 行 → `Project`：逐列直取（无 JSON 列）。 */
const mapProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  path: row.path,
  description: row.description,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** `threads` 行 → `ThreadRow`：四个 JSON 列还原，其余逐列直取（`sessions` 不落行）。 */
const mapThread = (row: ThreadDbRow): ThreadRow => ({
  id: row.id,
  source: row.source,
  externalRef: row.external_ref,
  title: row.title,
  status: row.status as ThreadRow['status'],
  taskIds: JSON.parse(row.task_ids_json) as string[],
  rootTaskIds: JSON.parse(row.root_task_ids_json) as string[],
  concurrency: row.concurrency,
  notesVersion: row.notes_version,
  notes: JSON.parse(row.notes_json) as ThreadRow['notes'],
  events: JSON.parse(row.events_json) as ThreadRow['events'],
  lastActivityAt: row.last_activity_at,
  createdAt: row.created_at,
})

/** `task_comments` 投影的整行（列与 `host/schema` 的 DDL 一一对应）。 */
interface TaskCommentDbRow {
  id: string
  task_id: string
  author: string
  text: string
  created_at: string
}

/** `review_reports` 投影的整行（列与 `host/schema` 的 DDL 一一对应）。 */
interface ReviewReportDbRow {
  id: string
  task_id: string
  stage_id: string
  run_id: string
  thread_id: string | null
  rev: number
  verdict: string | null
  checks_json: string
  findings_json: string
  artifact_json: string | null
  created_at: string
  updated_at: string
}

/** `task_comments` 行 → `TaskComment`：逐列直取（无 JSON 列）。 */
const mapTaskComment = (row: TaskCommentDbRow): TaskComment => ({
  id: row.id,
  taskId: row.task_id,
  author: row.author as TaskComment['author'],
  text: row.text,
  createdAt: row.created_at,
})

/** `runs` 行 → `RunRow`：JSON 列还原、布尔列从 0/1 还原，其余逐列直取。 */
const mapRun = (row: RunDbRow): RunRow => ({
  id: row.id,
  purpose: row.purpose as RunPurpose,
  taskId: row.task_id,
  stageId: row.stage_id,
  agentId: row.agent_id,
  runtimeId: row.runtime_id,
  conversationId: row.conversation_id,
  ruleId: row.rule_id,
  rulesVersion: row.rules_version,
  executorKey: row.executor_key,
  threadId: row.thread_id,
  cwd: row.cwd,
  access: row.access as Access,
  skill: row.skill,
  promptRef: row.prompt_ref,
  eventIds: JSON.parse(row.event_ids_json) as string[],
  hops: row.hops,
  turn: row.turn,
  resumeSessionId: row.resume_session_id,
  threadContextRef: row.thread_context_ref,
  queueSeq: row.queue_seq,
  status: row.status as RunStatus,
  prompt: row.prompt,
  output: row.output,
  error: row.error,
  errorCode: row.error_code as RunErrorCode | null,
  exitCode: row.exit_code,
  sessionId: row.session_id,
  usage: row.usage_json === null ? null : (JSON.parse(row.usage_json) as RunUsage),
  durationMs: row.duration_ms,
  leaseId: row.lease_id,
  attempt: row.attempt,
  attempts: row.attempts,
  leaseUntil: row.lease_until,
  notBefore: row.not_before,
  deadlineAt: row.deadline_at,
  cancelRequested: row.cancel_requested === 1,
  deliverables:
    row.deliverables_json === null ? null : (JSON.parse(row.deliverables_json) as RunDeliverables),
  // M40：坏 JSON / 空串按「不是脚本轮」归一，不让一条脏行把整张视图读挂
  script:
    row.script_json === undefined || row.script_json.trim() === '' || row.script_json === 'null'
      ? null
      : (JSON.parse(row.script_json) as RunRow['script']),
  startedAt: row.started_at,
  endedAt: row.ended_at,
  createdAt: row.created_at,
})

const mapConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  title: row.title,
  agentId: row.agent_id,
  // M11：列的 NULL 即「没有项目」（默认目录），老行同样落这里
  projectId: row.project_id,
  sessionId: row.session_id,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapMessage = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  role: row.role as ChatRole,
  content: row.content,
  error: row.error,
  createdAt: row.created_at,
})

/** `cards` 行 → `Card`：`options_json` 还原为 `string[]`，枚举列按契约收窄。 */
const mapCard = (row: CardDbRow): Card => ({
  id: row.id,
  runId: row.run_id,
  taskId: row.task_id,
  conversationId: row.conversation_id,
  title: row.title,
  text: row.text,
  kind: row.kind as CardKind,
  options: JSON.parse(row.options_json) as string[],
  key: row.key,
  version: row.version,
  status: row.status as CardStatus,
  delivery: row.delivery as CardDelivery,
  deliveryRef: row.delivery_ref,
  deliveryAttempts: Number(row.delivery_attempts ?? 0),
  nextDeliveryAt: (row.next_delivery_at as string | null) ?? null,
  deliveryGivenUp: Number(row.delivery_given_up ?? 0) === 1,
  optionIndex: row.option_index,
  answeredBy: row.answered_by as CardAnswerVia | null,
  answeredAt: row.answered_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const readWorkflows = (db: DatabaseSync): Workflow[] =>
  (
    db
      .prepare('SELECT id, name, description, created_at FROM workflows ORDER BY created_at, rowid')
      .all() as unknown as WorkflowRow[]
  ).map(mapWorkflow)

/** 阶段按 (workflow_id, position) 排；调用方按 workflow 分组后顺序即稳定。 */
const readStages = (db: DatabaseSync): WorkflowStage[] =>
  (
    db
      .prepare(
        `SELECT id, workflow_id, name, position, entry_mode, builtin, agent_id, script_json,
                exits_json, handoffs_json,
                subtask_stage_id, on_children_settled, spawn_policy, instructions, acceptance_json,
                run_timeout_ms, judge_json
         FROM workflow_stages ORDER BY workflow_id, position`,
      )
      .all() as unknown as StageRow[]
  ).map(mapStage)

const readAgents = (db: DatabaseSync): Agent[] =>
  (
    db
      .prepare(
        `SELECT id, name, description, runtime_id, system_prompt, model, reasoning_effort,
                max_concurrent, permission_mode, workdir, env_json, created_at
         FROM agents ORDER BY created_at, rowid`,
      )
      .all() as unknown as AgentRow[]
  ).map(mapAgent)

const readRuntimes = (db: DatabaseSync): Runtime[] =>
  (
    db
      .prepare(
        `SELECT id, name, executor_key, command, profile, args_template, enabled,
                last_probe_json, created_at
         FROM runtimes ORDER BY created_at, rowid`,
      )
      .all() as unknown as RuntimeRow[]
  ).map(mapRuntime)

/** `projects` 投影的列清单（逐列写死，装载与 `projects.all` 共用）。 */
const PROJECT_COLUMNS = 'id, name, path, description, created_at, updated_at'

const readProjects = (db: DatabaseSync): Project[] =>
  (
    db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at, rowid`)
      .all() as unknown as ProjectRow[]
  ).map(mapProject)

/** `tasks` 投影的列清单（逐列写死，不用 `SELECT *`；三处读路径共用）。 */
const TASK_COLUMNS = `id, title, description, workflow_id, project_id, current_stage_id, status, origin,
        rule_id, external_ref, labels_json, thread_id, parent_task_id, spawned_by_run_id,
        batch_no, spawn_key, handoff_from_task_id, handoff_from_stage_id, handoff_from_run_id,
        gate_fails, created_at, updated_at`

const readTasks = (db: DatabaseSync): Task[] =>
  (
    db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at, rowid`)
      .all() as unknown as TaskRow[]
  ).map(mapTask)

/** `threads` 投影的列清单（逐列写死，不用 `SELECT *`；装载与 `thread.byId` 共用）。 */
const THREAD_COLUMNS = `id, source, external_ref, title, status, task_ids_json,
        root_task_ids_json, concurrency, notes_version, notes_json, events_json,
        last_activity_at, created_at`

const readThreads = (db: DatabaseSync): ThreadRow[] =>
  (
    db
      .prepare(`SELECT ${THREAD_COLUMNS} FROM threads ORDER BY created_at, rowid`)
      .all() as unknown as ThreadDbRow[]
  ).map(mapThread)

/** `task_comments` 的列清单（逐列写死，装载与 `comments.byTask` 共用）。 */
const TASK_COMMENT_COLUMNS = 'id, task_id, author, text, created_at'

const readTaskComments = (db: DatabaseSync): TaskComment[] =>
  (
    db
      .prepare(`SELECT ${TASK_COMMENT_COLUMNS} FROM task_comments ORDER BY created_at, rowid`)
      .all() as unknown as TaskCommentDbRow[]
  ).map(mapTaskComment)

/** 某任务的上下文 / 反馈：按追加顺序（`createdAt` 升序，同毫秒按 rowid）。 */
const readTaskCommentsByTask = (db: DatabaseSync, taskId: string): TaskComment[] =>
  (
    db
      .prepare(
        `SELECT ${TASK_COMMENT_COLUMNS} FROM task_comments
         WHERE task_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as unknown as TaskCommentDbRow[]
  ).map(mapTaskComment)

/** `runs` 投影的列清单（逐列写死，不用 `SELECT *`）。 */
const RUN_COLUMNS = `id, purpose, task_id, stage_id, agent_id, runtime_id, conversation_id, rule_id,
        rules_version, executor_key, thread_id, cwd, access, skill, prompt_ref,
        event_ids_json, hops, turn, resume_session_id, thread_context_ref, queue_seq,
        status, prompt, output, error, error_code, exit_code, session_id, usage_json,
        duration_ms, lease_id, attempt, attempts, lease_until, not_before, deadline_at,
        cancel_requested, deliverables_json, script_json, started_at, ended_at, created_at`

const readRuns = (db: DatabaseSync): RunRow[] =>
  (
    db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at, rowid`)
      .all() as unknown as RunDbRow[]
  ).map(mapRun)

/**
 * 投影行 → IPC 运行行：调度列不外露（与 M1 的 `Run` 字段一致）。
 * `taskId` 由调用方传入（`runs.byTask` 的 SQL 已按 `task_id = ? AND purpose='stage'` 过滤）。
 */
const toRun = (row: RunDbRow, taskId: string): Run => {
  const run = mapRun(row)
  return {
    id: run.id,
    taskId,
    stageId: run.stageId,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    status: run.status,
    prompt: run.prompt,
    output: run.output,
    error: run.error,
    errorCode: run.errorCode,
    exitCode: run.exitCode,
    sessionId: run.sessionId,
    usage: run.usage,
    durationMs: run.durationMs,
    // M28：本轮实际权限（闸门阶段被内核抬到 full），任务详情据此显示「这一轮跑成了什么」
    access: run.access,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    createdAt: run.createdAt,
  }
}

/**
 * 任务的历史运行（`purpose='stage'`，按创建顺序）。
 * 聊天 run 不挂任务；即便旧数据里挂了 `task_id` 也不混进阶段看板（与 `RunRow` 的文档口径一致）。
 */
const readRunsByTask = (db: DatabaseSync, taskId: string): Run[] =>
  (
    db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM runs
         WHERE task_id = ? AND purpose = 'stage'
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as unknown as RunDbRow[]
  ).map((row) => toRun(row, taskId))

const readRunById = (db: DatabaseSync, runId: string): RunRow | null => {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(runId) as unknown as
    RunDbRow | undefined
  return row ? mapRun(row) : null
}

interface RunEventDbRow {
  run_id: string
  seq: number
  type: string
  payload_json: string
}

/** 运行事件流：`payload_json` 还原为协议帧（`seq` / `type` 已在列里）。 */
const readRunEvents = (db: DatabaseSync, runId: string): RunEvent[] =>
  (
    db
      .prepare(
        'SELECT run_id, seq, type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq',
      )
      .all(runId) as unknown as RunEventDbRow[]
  ).map((row) => {
    const payload = JSON.parse(row.payload_json) as Omit<RunEvent, 'seq' | 'type'>
    return { seq: row.seq, type: row.type as RunEvent['type'], ...payload }
  })

/** 该 run 已有的最大帧 seq（重启后重跑同一 run 时保证全局单调）；没有事件时为 0。 */
const readLastEventSeq = (db: DatabaseSync, runId: string): number => {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?')
    .get(runId) as unknown as { seq: number }
  return row.seq
}

/** 各运行时的在跑 / 排队数：只统计 active run 且限定了运行时。 */
const readRuntimeWorkloads = (db: DatabaseSync): RuntimeWorkload[] => {
  const rows = db
    .prepare(
      `SELECT runtime_id, status, COUNT(*) AS n FROM runs
       WHERE runtime_id IS NOT NULL AND status IN ('queued','running')
       GROUP BY runtime_id, status`,
    )
    .all() as unknown as Array<{ runtime_id: string; status: string; n: number }>
  const byId = new Map<string, RuntimeWorkload>()
  for (const row of rows) {
    const entry = byId.get(row.runtime_id) ?? { runtimeId: row.runtime_id, running: 0, queued: 0 }
    if (row.status === 'running') entry.running = row.n
    else entry.queued = row.n
    byId.set(row.runtime_id, entry)
  }
  return [...byId.values()]
}

/** 崩溃重启时要落兜底终态的聊天 run：`purpose='chat'` 且仍在 `running`。 */
const readStaleChatRuns = (db: DatabaseSync): StaleChatRun[] =>
  (
    db
      .prepare(
        `SELECT id, lease_id, turn FROM runs
         WHERE purpose = 'chat' AND status = 'running'
         ORDER BY created_at, rowid`,
      )
      .all() as unknown as Array<{ id: string; lease_id: string | null; turn: number }>
  ).map((row) => ({ id: row.id, leaseId: row.lease_id, turn: row.turn }))

/**
 * 启动对账要检查的 waiting run（M4 D13）：逐列 SELECT，`hasOpenCard` 用 `EXISTS` 子查询
 * 按 `cards.run_id + status='open'` 得出——有 open 卡说明有人可答，对账不能兜底取消。
 */
const readWaitingRuns = (db: DatabaseSync): WaitingRun[] =>
  (
    db
      .prepare(
        `SELECT r.id AS run_id, r.lease_id, r.turn,
                EXISTS(
                  SELECT 1 FROM cards c
                  WHERE c.run_id = r.id AND c.status = 'open'
                ) AS has_open_card
         FROM runs r
         WHERE r.status = 'waiting'
         ORDER BY r.created_at, r.rowid`,
      )
      .all() as unknown as Array<{
      run_id: string
      lease_id: string | null
      turn: number
      has_open_card: number
    }>
  ).map((row) => ({
    runId: row.run_id,
    leaseId: row.lease_id,
    turn: row.turn,
    hasOpenCard: row.has_open_card === 1,
  }))

/** `conversations` 投影的列清单（逐列写死，装载与三条会话查询共用）。 */
const CONVERSATION_COLUMNS = `id, title, agent_id, project_id, session_id, archived_at,
        created_at, updated_at`

/** 会话清单按最近更新排序（与旧仓储 ORDER BY updated_at DESC 一致）。 */
const CONVERSATION_ORDER = 'ORDER BY updated_at DESC, created_at DESC, rowid'

const readConversations = (db: DatabaseSync): Conversation[] =>
  (
    db
      .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations ${CONVERSATION_ORDER}`)
      .all() as unknown as ConversationRow[]
  ).map(mapConversation)

/** 某项目下的会话（M11）：口径与 `tasks.byProject` 一致，排序同会话清单。 */
const readConversationsByProject = (db: DatabaseSync, projectId: string): Conversation[] =>
  (
    db
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE project_id = ? ${CONVERSATION_ORDER}`,
      )
      .all(projectId) as unknown as ConversationRow[]
  ).map(mapConversation)

/** 没有项目的会话（M11）：老事实 / 存量行都归入「默认目录」。 */
const readConversationsUnassigned = (db: DatabaseSync): Conversation[] =>
  (
    db
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE project_id IS NULL ${CONVERSATION_ORDER}`,
      )
      .all() as unknown as ConversationRow[]
  ).map(mapConversation)

const readMessages = (db: DatabaseSync): Message[] =>
  (
    db
      .prepare(
        `SELECT id, conversation_id, role, content, error, created_at
         FROM messages ORDER BY created_at, rowid`,
      )
      .all() as unknown as MessageRow[]
  ).map(mapMessage)

/** `cards` 投影的列清单（逐列写死，不用 `SELECT *`）。 */
const CARD_COLUMNS = `id, run_id, task_id, conversation_id, title, text, kind, options_json, key,
        version, status, delivery, delivery_ref, option_index, answered_by, answered_at,
        created_at, updated_at`

const readCards = (db: DatabaseSync): Card[] =>
  (
    db
      .prepare(`SELECT ${CARD_COLUMNS} FROM cards ORDER BY created_at, rowid`)
      .all() as unknown as CardDbRow[]
  ).map(mapCard)

/** 全部 open 卡（顶部待审批条）：只按状态过滤，按创建时间升序。 */
const readOpenCards = (db: DatabaseSync): Card[] =>
  (
    db
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM cards
         WHERE status = 'open'
         ORDER BY created_at, rowid`,
      )
      .all() as unknown as CardDbRow[]
  ).map(mapCard)

/** 某个 run 的卡片（含已答 / 已关闭，回答续接与审计用），按创建时间升序。 */
const readCardsByRun = (db: DatabaseSync, runId: string): Card[] =>
  (
    db
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM cards
         WHERE run_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(runId) as unknown as CardDbRow[]
  ).map(mapCard)

const readMessagesByConversation = (db: DatabaseSync, conversationId: string): Message[] =>
  (
    db
      .prepare(
        `SELECT id, conversation_id, role, content, error, created_at
         FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`,
      )
      .all(conversationId) as unknown as MessageRow[]
  ).map(mapMessage)

const toMap = <T extends { id: string }>(rows: readonly T[]): Map<string, T> =>
  new Map(rows.map((row) => [row.id, row]))

/**
 * 存在活跃 run（`queued` / `running` / `waiting`）的阶段任务 id。
 * `waiting` 已释放并发位但仍算「执行中」；聊天 run 不挂任务，按 `purpose='stage'` 排除。
 */
const readActiveTaskIds = (db: DatabaseSync): Set<string> => {
  const rows = db
    .prepare(
      `SELECT DISTINCT task_id FROM runs
       WHERE purpose = 'stage' AND task_id IS NOT NULL
         AND status IN ('queued','running','waiting')`,
    )
    .all() as unknown as Array<{ task_id: string }>
  return new Set(rows.map((row) => row.task_id))
}

/**
 * 当前规则集（`rule_sets` 单行 `id='current'`）：没有 `rules.replaced` 事实时为 null。
 * 装载视图与 `rules.all` 查询共用，避免两处各读一次、口径分叉。
 */
const readRuleSet = (db: DatabaseSync): RuleSetRow | null => {
  const row = db
    .prepare("SELECT id, version, replaced_at, rules_json FROM rule_sets WHERE id = 'current'")
    .get() as unknown as RuleSetDbRow | undefined
  if (row === undefined) return null
  return {
    id: 'current',
    version: row.version,
    replacedAt: row.replaced_at,
    rules: JSON.parse(row.rules_json) as RuleSetRow['rules'],
  }
}

/**
 * 每条规则最近一次 cron 触发的**计划时刻**（`scheduled_for`，不是 `fired_at`）：
 * 内核拿它做 cron 基线（同一到点时刻只触发一次、停机错过只补最近一次）。
 * ISO 字符串字典序即时间序，`MAX` 可直接用；没有触发记录的规则不出现在 Map 里。
 */
const readRuleFiredAt = (db: DatabaseSync): Map<Id, Iso> => {
  const rows = db
    .prepare('SELECT rule_id, MAX(scheduled_for) AS scheduled_for FROM rule_fires GROUP BY rule_id')
    .all() as unknown as Array<{ rule_id: string; scheduled_for: string }>
  return new Map(rows.map((row) => [row.rule_id, row.scheduled_for]))
}

/** `rules.all` 视图：无规则集时 `{ version: 0, rules: [] }`（与内核「版本从 0 起」同口径）。 */
const readRuleSetView = (db: DatabaseSync): RuleSetView => {
  const ruleSet = readRuleSet(db)
  return ruleSet === null
    ? { version: 0, rules: [] }
    : { version: ruleSet.version, rules: ruleSet.rules }
}

/**
 * 当前插件设置快照（`plugin_settings` 单行 `id='current'`）：没有 `plugins.replaced` 事实时为 null。
 * 装载视图与 `plugins.settings` 查询共用，避免两处各读一次、口径分叉。
 */
const readPluginSettings = (db: DatabaseSync): PluginSettingsRow | null => {
  const row = db
    .prepare(
      "SELECT id, version, replaced_at, settings_json FROM plugin_settings WHERE id = 'current'",
    )
    .get() as unknown as PluginSettingsDbRow | undefined
  if (row === undefined) return null
  return {
    id: 'current',
    version: row.version,
    replacedAt: row.replaced_at,
    settings: JSON.parse(row.settings_json) as PluginSettingsRow['settings'],
  }
}

/** `plugins.settings` 视图：无快照时 `{ version: 0, replacedAt: null, settings: [] }`。 */
const readPluginSettingsView = (db: DatabaseSync): PluginSettingsView => {
  const settings = readPluginSettings(db)
  return settings === null
    ? { version: 0, replacedAt: null, settings: [] }
    : { version: settings.version, replacedAt: settings.replacedAt, settings: settings.settings }
}

/**
 * 评审结论行（M14）：`findings` / `checks` / `artifact` 都是 JSON 列，读路径逐列写死 SELECT。
 * 老库没有这张表时由 `schema.ts` 在启动时建齐，这里不做缺表兜底。
 */
const readReviewReports = (db: DatabaseSync): ReviewReport[] =>
  (
    db
      .prepare(
        `SELECT id, task_id, stage_id, run_id, thread_id, rev, verdict, checks_json,
                findings_json, artifact_json, created_at, updated_at
           FROM review_reports`,
      )
      .all() as unknown as ReviewReportDbRow[]
  ).map((row) => ({
    id: row.id,
    taskId: row.task_id,
    stageId: row.stage_id,
    runId: row.run_id,
    threadId: row.thread_id,
    rev: row.rev,
    verdict: row.verdict as ReviewReport['verdict'],
    checks: JSON.parse(row.checks_json) as ReviewReport['checks'],
    findings: JSON.parse(row.findings_json) as ReviewReport['findings'],
    artifact: row.artifact_json === null ? null : (JSON.parse(row.artifact_json) as ReviewArtifact),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

/** 按输入声明的切片装载视图：未声明的表不查，`activeTaskIds` 总是装载。 */
export function loadView(
  db: DatabaseSync,
  tables: readonly ProjectionTable[],
  artifactsRoot: string | null = null,
): View {
  const slice = new Set<ProjectionTable>(tables)
  // 规则集与插件设置是单行切片：未声明时按「无快照」装载（version 0 / 空清单）。
  const ruleSet = slice.has('rule_sets') ? readRuleSet(db) : null
  const pluginSettings = slice.has('plugin_settings') ? readPluginSettings(db) : null
  return {
    seq: lastSeq(db),
    workflows: slice.has('workflows') ? toMap(readWorkflows(db)) : new Map(),
    stages: slice.has('workflow_stages') ? toMap(readStages(db)) : new Map(),
    agents: slice.has('agents') ? toMap(readAgents(db)) : new Map(),
    runtimes: slice.has('runtimes') ? toMap(readRuntimes(db)) : new Map(),
    projects: slice.has('projects') ? toMap(readProjects(db)) : new Map(),
    tasks: slice.has('tasks') ? toMap(readTasks(db)) : new Map(),
    runs: slice.has('runs') ? toMap(readRuns(db)) : new Map(),
    conversations: slice.has('conversations') ? toMap(readConversations(db)) : new Map(),
    messages: slice.has('messages') ? toMap(readMessages(db)) : new Map(),
    cards: slice.has('cards') ? toMap(readCards(db)) : new Map(),
    threads: slice.has('threads') ? toMap(readThreads(db)) : new Map(),
    // M42：事件投影与「停用规则跳过」的留痕（补跑唯一的数据来源）
    events: slice.has('events') ? toMap(readEvents(db)) : new Map(),
    ruleSkips: slice.has('event_skips') ? readRuleSkips(db) : [],
    // M15：产物落盘根随视图给内核（只用于拼「任务索引」里的路径，内核不读文件）。
    artifactsRoot,
    taskComments: slice.has('task_comments') ? toMap(readTaskComments(db)) : new Map(),
    reviewReports: slice.has('review_reports') ? toMap(readReviewReports(db)) : new Map(),
    activeTaskIds: readActiveTaskIds(db),
    rules: ruleSet?.rules ?? [],
    rulesVersion: ruleSet?.version ?? 0,
    ruleSetReplacedAt: ruleSet?.replacedAt ?? null,
    ruleFiredAt: slice.has('rule_fires') ? readRuleFiredAt(db) : new Map(),
    pluginSettings: pluginSettings?.settings ?? [],
    pluginSettingsVersion: pluginSettings?.version ?? 0,
  }
}

/** M42：事件投影行（补跑还原入参用）。 */
const readEvents = (db: DatabaseSync): EventRow[] =>
  (
    db
      .prepare(
        `SELECT id, source, type, subject, summary, detail_ref, link, hops, origin_run_id, dedupe_key, received_at
         FROM events ORDER BY received_at, rowid`,
      )
      .all() as unknown as Array<Record<string, unknown>>
  ).map((row) => ({
    id: String(row['id']),
    source: String(row['source']),
    type: String(row['type']),
    subject: String(row['subject']),
    summary: String(row['summary']),
    detailRef: (row['detail_ref'] as string | null) ?? null,
    link: (row['link'] as string | null) ?? null,
    hops: Number(row['hops']),
    originRunId: (row['origin_run_id'] as string | null) ?? null,
    dedupeKey: (row['dedupe_key'] as string | null) ?? null,
    receivedAt: String(row['received_at']),
  }))

/** M42：还没补跑的跳过行（按跳过时刻升序，补跑按这个顺序重放）。 */
const readRuleSkips = (db: DatabaseSync): RuleSkip[] =>
  (
    db
      .prepare(
        'SELECT rule_id, event_id, version, skipped_at FROM event_skips WHERE replayed_at IS NULL ORDER BY skipped_at, rowid',
      )
      .all() as unknown as Array<Record<string, unknown>>
  ).map((row) => ({
    ruleId: String(row['rule_id']),
    eventId: String(row['event_id']),
    version: Number(row['version']),
    skippedAt: String(row['skipped_at']),
  }))
const readWorkflowsWithStages = (db: DatabaseSync): WorkflowWithStages[] => {
  const stagesByWorkflow = new Map<string, WorkflowStage[]>()
  for (const stage of readStages(db)) {
    const bucket = stagesByWorkflow.get(stage.workflowId)
    if (bucket) bucket.push(stage)
    else stagesByWorkflow.set(stage.workflowId, [stage])
  }
  return readWorkflows(db).map((workflow) => ({
    ...workflow,
    stages: stagesByWorkflow.get(workflow.id) ?? [],
  }))
}

const readTasksByWorkflow = (db: DatabaseSync, workflowId: string): Task[] =>
  (
    db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE workflow_id = ? ORDER BY created_at, rowid`)
      .all(workflowId) as unknown as TaskRow[]
  ).map(mapTask)

/** 某项目下的任务（M10）：按创建顺序；看板再按工作流过滤，并按最近活动倒序铺开。 */
const readTasksByProject = (db: DatabaseSync, projectId: string): Task[] =>
  (
    db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE project_id = ? ORDER BY created_at, rowid`)
      .all(projectId) as unknown as TaskRow[]
  ).map(mapTask)

/** 没有项目的任务（M10）：v2 存量与老规则建的任务，界面归入「未归属」。 */
const readTasksUnassigned = (db: DatabaseSync): Task[] =>
  (
    db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE project_id IS NULL ORDER BY created_at, rowid`,
      )
      .all() as unknown as TaskRow[]
  ).map(mapTask)

/** 某任务的直接子任务（M8）：按创建顺序；无子任务返回空数组。 */
const readTasksByParent = (db: DatabaseSync, parentTaskId: string): Task[] =>
  (
    db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE parent_task_id = ? ORDER BY created_at, rowid`,
      )
      .all(parentTaskId) as unknown as TaskRow[]
  ).map(mapTask)

const readTask = (db: DatabaseSync, taskId: string): Task | null => {
  const row = db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
    .get(taskId) as unknown as TaskRow | undefined
  return row ? mapTask(row) : null
}

const readThread = (db: DatabaseSync, threadId: string): ThreadRow | null => {
  const row = db
    .prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`)
    .get(threadId) as unknown as ThreadDbRow | undefined
  return row ? mapThread(row) : null
}

/**
 * 线程内任务：按 `thread.taskIds` 取（已删任务自然跳过），按 `created_at` 排序
 * ——与 `thread.byId` 的契约一致，任务树结构由 `rootTaskIds` / `parentTaskId` 决定。
 */
const readThreadTasks = (db: DatabaseSync, taskIds: readonly string[]): Task[] => {
  if (taskIds.length === 0) return []
  const placeholders = taskIds.map(() => '?').join(', ')
  return (
    db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE id IN (${placeholders})
         ORDER BY created_at, rowid`,
      )
      .all(...taskIds) as unknown as TaskRow[]
  ).map(mapTask)
}

/**
 * 线程会话：每个 `agentId` 最近一次终态 run 的 `sessionId`（不落线程行，按 runs 现算）。
 *
 * 口径与 `kernel/threads` 的 `threadSessions` 一致：只算 `succeeded` / `failed` / `cancelled`
 * 且带 `session_id` 的 run，按 `COALESCE(ended_at, created_at)` → `created_at` → `id` 排序，
 * 后写覆盖先写（最近一次胜出）。
 */
const readThreadSessions = (db: DatabaseSync, threadId: string): Record<string, string> => {
  const rows = db
    .prepare(
      `SELECT agent_id, session_id FROM runs
       WHERE thread_id = ? AND agent_id IS NOT NULL AND session_id IS NOT NULL
         AND status IN ('succeeded','failed','cancelled')
       ORDER BY COALESCE(ended_at, created_at), created_at, id`,
    )
    .all(threadId) as unknown as Array<{ agent_id: string; session_id: string }>
  const sessions: Record<string, string> = {}
  for (const row of rows) sessions[row.agent_id] = row.session_id
  return sessions
}

/** `thread.byId`：线程不存在返回 null；任务与会话都由当前投影现算（不落线程行）。 */
const readThreadDetail = (db: DatabaseSync, threadId: string): ThreadDetail | null => {
  const thread = readThread(db, threadId)
  if (thread === null) return null
  return {
    thread,
    tasks: readThreadTasks(db, thread.taskIds),
    sessions: readThreadSessions(db, threadId),
  }
}

const mapActiveRun = (row: ActiveRunRow): ActiveRun => ({
  id: row.id,
  taskId: row.task_id,
  stageId: row.stage_id,
  status: row.status as ActiveRun['status'],
})

const readActiveRuns = (db: DatabaseSync, taskId: string): ActiveRun[] =>
  (
    db
      .prepare(
        `SELECT id, task_id, stage_id, status FROM runs
         WHERE task_id = ? AND purpose = 'stage'
           AND status IN ('queued','running','waiting')
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as unknown as ActiveRunRow[]
  ).map(mapActiveRun)

/** 对话下执行中的聊天 run（同一对话同时只跑一轮，用来看「正在执行」与取消目标）。 */
const readActiveChatRuns = (db: DatabaseSync, conversationId: string): ActiveRun[] =>
  (
    db
      .prepare(
        `SELECT id, task_id, stage_id, status FROM runs
         WHERE conversation_id = ? AND purpose = 'chat'
           AND status IN ('queued','running','waiting')
         ORDER BY created_at, rowid`,
      )
      .all(conversationId) as unknown as ActiveRunRow[]
  ).map(mapActiveRun)

const readStringParam = (params: unknown, key: string): string => {
  if (typeof params !== 'object' || params === null) {
    throw new StoreError('invalid_input', `视图缺少参数 ${key}`)
  }
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value === '') {
    throw new StoreError('invalid_input', `视图缺少参数 ${key}`)
  }
  return value
}

/**
 * M23：工作流各阶段的运行指标（只读派生，不新增表）。
 *
 * 口径都是「能确定算出来的那一种」，不做归因推断：
 * - `runs` = 该阶段的 stage run 条数；
 * - `verdicts` = 该阶段评审报告的闸门结论（pass / fail 分开计数，M34）；
 * - `degraded` = 打 `gate:degraded` 且当前停在该阶段的任务数；
 * - `asks` = 该阶段 run 上发出的 ask 卡数（cards.run_id → runs.stage_id）；
 * - `humanComments` = 按任务**当前**阶段归属的人写评论数（近似：评论没有阶段列）。
 */
const readStageMetrics = (db: DatabaseSync, workflowId: string): WorkflowStageMetrics => {
  const stages = db
    .prepare(
      'SELECT id, name, position FROM workflow_stages WHERE workflow_id = ? ORDER BY position',
    )
    .all(workflowId) as unknown as Array<{ id: string; name: string; position: number }>
  const byStage = <T extends { stageId: string | null }>(rows: T[]): Map<string, T> =>
    new Map(rows.filter((row) => row.stageId !== null).map((row) => [row.stageId as string, row]))

  const runs = byStage(
    db
      .prepare(
        `SELECT r.stage_id AS stageId, COUNT(*) AS runs
           FROM runs r
          WHERE r.purpose = 'stage' AND r.stage_id IS NOT NULL AND r.task_id IS NOT NULL
          GROUP BY r.stage_id`,
      )
      .all() as unknown as Array<{ stageId: string; runs: number }>,
  )
  // M34：闸门结论按 (阶段, 结论) 分组——一个阶段既有 pass 也有 fail，不能按阶段建 Map
  const verdictRows = db
    .prepare(
      `SELECT stage_id AS stageId, verdict, COUNT(*) AS n FROM review_reports
         WHERE stage_id IS NOT NULL AND verdict IS NOT NULL
         GROUP BY stage_id, verdict`,
    )
    .all() as unknown as Array<{ stageId: string; verdict: string; n: number }>
  const verdictCount = (stageId: string, verdict: 'pass' | 'fail'): number =>
    verdictRows.find((row) => row.stageId === stageId && row.verdict === verdict)?.n ?? 0
  const degraded = byStage(
    db
      .prepare(
        `SELECT current_stage_id AS stageId, COUNT(*) AS n FROM tasks
          WHERE workflow_id = ? AND current_stage_id IS NOT NULL AND labels_json LIKE '%gate:degraded%'
          GROUP BY current_stage_id`,
      )
      .all(workflowId) as unknown as Array<{ stageId: string; n: number }>,
  )
  const asks = byStage(
    db
      .prepare(
        `SELECT r.stage_id AS stageId, COUNT(*) AS n FROM cards c JOIN runs r ON r.id = c.run_id
          WHERE c.kind = 'ask' AND r.stage_id IS NOT NULL
          GROUP BY r.stage_id`,
      )
      .all() as unknown as Array<{ stageId: string; n: number }>,
  )
  const human = byStage(
    db
      .prepare(
        `SELECT t.current_stage_id AS stageId, COUNT(*) AS n
           FROM task_comments tc JOIN tasks t ON t.id = tc.task_id
          WHERE tc.author = 'owner' AND t.workflow_id = ? AND t.current_stage_id IS NOT NULL
          GROUP BY t.current_stage_id`,
      )
      .all(workflowId) as unknown as Array<{ stageId: string; n: number }>,
  )
  return {
    workflowId,
    stages: stages.map((stage) => ({
      stageId: stage.id,
      stageName: stage.name,
      runs: runs.get(stage.id)?.runs ?? 0,
      verdicts: {
        pass: verdictCount(stage.id, 'pass'),
        fail: verdictCount(stage.id, 'fail'),
      },
      degraded: degraded.get(stage.id)?.n ?? 0,
      asks: asks.get(stage.id)?.n ?? 0,
      humanComments: human.get(stage.id)?.n ?? 0,
    })),
  }
}

/** `query(view, params)` 的实现：视图 id 与参数形状由 `protocol/views` 固定。 */
/** 用量窗口：`days` 夹在 1–90，`now` 由调用方给（缺省 = 全部历史，仍不读系统时钟）。 */
interface UsageWindow {
  cutoff: string | null
}

const readUsageWindow = (params: unknown): UsageWindow => {
  const raw = (params ?? {}) as { days?: unknown; now?: unknown }
  const days =
    typeof raw.days === 'number' && Number.isFinite(raw.days)
      ? Math.min(90, Math.max(1, Math.floor(raw.days)))
      : 7
  const now = typeof raw.now === 'string' ? raw.now : null
  return {
    cutoff: now === null ? null : new Date(Date.parse(now) - days * 86_400_000).toISOString(),
  }
}

/**
 * 用量聚合（M36-E）：只算已结束的 run；`usage_json` 里的四项与成本按 JSON 取值。
 *
 * 缺失计数用 `IS NULL` 判定，不把「执行器没报」折成 0——否则成本合计会悄悄偏小。
 */
const USAGE_COLUMNS = `COUNT(*) AS rounds,
  COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) AS inputTokens,
  COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) AS outputTokens,
  COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) AS cacheReadTokens,
  COALESCE(SUM(json_extract(usage_json, '$.cacheWriteTokens')), 0) AS cacheWriteTokens,
  COALESCE(SUM(json_extract(usage_json, '$.costUsd')), 0) AS costUsd,
  SUM(CASE WHEN json_extract(usage_json, '$.inputTokens') IS NULL THEN 1 ELSE 0 END) AS missingTokens,
  SUM(CASE WHEN json_extract(usage_json, '$.costUsd') IS NULL THEN 1 ELSE 0 END) AS missingCost`

const usageWhere = (window: UsageWindow): { clause: string; params: string[] } =>
  window.cutoff === null
    ? {
        clause: "status IN ('succeeded', 'failed', 'cancelled') AND ended_at IS NOT NULL",
        params: [],
      }
    : {
        clause:
          "status IN ('succeeded', 'failed', 'cancelled') AND ended_at IS NOT NULL AND ended_at >= ?",
        params: [window.cutoff],
      }

const toUsageTotals = (row: Record<string, unknown>): UsageTotals => ({
  rounds: Number(row['rounds']),
  inputTokens: Number(row['inputTokens']),
  outputTokens: Number(row['outputTokens']),
  cacheReadTokens: Number(row['cacheReadTokens']),
  cacheWriteTokens: Number(row['cacheWriteTokens']),
  costUsd: Number(row['costUsd']),
  missingTokens: Number(row['missingTokens']),
  missingCost: Number(row['missingCost']),
})

const readUsageDaily = (db: DatabaseSync, window: UsageWindow): UsageDailyRow[] => {
  const where = usageWhere(window)
  const rows = db
    .prepare(
      `SELECT substr(ended_at, 1, 10) AS date, ${USAGE_COLUMNS}
       FROM runs WHERE ${where.clause}
       GROUP BY date ORDER BY date`,
    )
    .all(...where.params) as unknown as Array<Record<string, unknown>>
  return rows.map((row) => ({ date: String(row['date']), ...toUsageTotals(row) }))
}

const readUsageByAgent = (db: DatabaseSync, window: UsageWindow): UsageAgentRow[] => {
  const where = usageWhere(window)
  const rows = db
    .prepare(
      `SELECT agent_id AS agentId, ${USAGE_COLUMNS}
       FROM runs WHERE ${where.clause}
       GROUP BY agent_id ORDER BY agent_id`,
    )
    .all(...where.params) as unknown as Array<Record<string, unknown>>
  return rows.map((row) => ({
    agentId: row['agentId'] === null ? null : String(row['agentId']),
    ...toUsageTotals(row),
  }))
}
export function queryView(db: DatabaseSync, view: ViewId, params?: unknown): unknown {
  if (!(VIEW_IDS as readonly string[]).includes(view)) {
    throw new StoreError('invalid_input', `未知视图: ${String(view)}`)
  }
  switch (view) {
    case 'workflows.all':
      return readWorkflowsWithStages(db)
    case 'workflow.stage-metrics':
      // M23：阶段运行指标（只读派生，先放后收的判定依据）
      return readStageMetrics(db, readStringParam(params, 'workflowId'))
    case 'usage.daily':
      return readUsageDaily(db, readUsageWindow(params))
    case 'usage.byAgent':
      return readUsageByAgent(db, readUsageWindow(params))
    case 'rules.preview': {
      // M36：预演只读规则集与落点（不建线程、不建任务），内核纯函数算结果
      const args = (params ?? {}) as {
        source?: unknown
        type?: unknown
        subject?: unknown
        summary?: unknown
      }
      const view = loadView(db, ['rule_sets', 'workflows', 'workflow_stages'])
      return previewEvent(view, {
        source: String(args.source ?? ''),
        type: String(args.type ?? ''),
        subject: String(args.subject ?? ''),
        summary: typeof args.summary === 'string' ? args.summary : null,
      })
    }
    case 'rules.next': {
      const args = (params ?? {}) as { now?: unknown; timezone?: unknown }
      const now = typeof args.now === 'string' ? args.now : new Date().toISOString()
      const timezone =
        typeof args.timezone === 'string'
          ? args.timezone
          : Intl.DateTimeFormat().resolvedOptions().timeZone
      const view = loadView(db, ['rule_sets'])
      return nextRuleFires(view, now, timezone)
    }
    case 'agents.all':
      return readAgents(db)
    case 'runtimes.all':
      return readRuntimes(db)
    case 'projects.all':
      return readProjects(db)
    case 'tasks.byProject':
      return readTasksByProject(db, readStringParam(params, 'projectId'))
    case 'tasks.unassigned':
      return readTasksUnassigned(db)
    case 'tasks.byWorkflow':
      return readTasksByWorkflow(db, readStringParam(params, 'workflowId'))
    case 'tasks.byParent':
      return readTasksByParent(db, readStringParam(params, 'taskId'))
    case 'task.byId':
      return readTask(db, readStringParam(params, 'taskId'))
    case 'thread.byId':
      // M6.5：线程详情 = 线程行 + 线程任务（按创建顺序）+ 各智能体最近会话 id
      return readThreadDetail(db, readStringParam(params, 'threadId'))
    case 'comments.byTask':
      // M7.5：任务上下文 / 反馈（按追加顺序）
      return readTaskCommentsByTask(db, readStringParam(params, 'taskId'))
    case 'reviews.byTask':
      // M14：任务的评审报告，按 rev 升序（同一任务重评不覆盖旧结论）
      return readReviewReports(db)
        .filter((report) => report.taskId === readStringParam(params, 'taskId'))
        .sort((left, right) => left.rev - right.rev || left.id.localeCompare(right.id))
    case 'runs.active-by-task':
      return readActiveRuns(db, readStringParam(params, 'taskId'))
    case 'conversations.all':
      return readConversations(db)
    case 'conversations.byProject':
      // M11：聊天清单按当前项目过滤（与 tasks.byProject 同口径）
      return readConversationsByProject(db, readStringParam(params, 'projectId'))
    case 'conversations.unassigned':
      // M11：没有项目的会话归入「默认目录」，老行同样落这里（无参数）
      return readConversationsUnassigned(db)
    case 'messages.byConversation':
      return readMessagesByConversation(db, readStringParam(params, 'conversationId'))
    case 'runs.active-by-conversation':
      return readActiveChatRuns(db, readStringParam(params, 'conversationId'))
    case 'runs.byTask':
      return readRunsByTask(db, readStringParam(params, 'taskId'))
    case 'run.byId':
      return readRunById(db, readStringParam(params, 'runId'))
    case 'run.events':
      return readRunEvents(db, readStringParam(params, 'runId'))
    case 'run.last-event-seq':
      return readLastEventSeq(db, readStringParam(params, 'runId'))
    case 'runtimes.workloads':
      return readRuntimeWorkloads(db)
    case 'runs.stale-chat':
      return readStaleChatRuns(db)
    case 'cards.open':
      return readOpenCards(db)
    case 'cards.byRun':
      return readCardsByRun(db, readStringParam(params, 'runId'))
    case 'runs.waiting':
      return readWaitingRuns(db)
    case 'tasks.executing':
      // M5：看板「执行中」只认内核集合（与 loadView 的 activeTaskIds 同口径）
      return [...readActiveTaskIds(db)]
    case 'runtimes.statuses':
      return readRuntimeStatuses(db)
    case 'kernel.seq':
      // M5：kernelStore 的快照水位（事实日志最大 seq）
      return lastSeq(db)
    case 'rules.all':
      // M6：规则页只读视图（版本 + 当前规则清单）；无规则集时返回空版本
      return readRuleSetView(db)
    case 'plugins.settings':
      // M7：插件设置快照读视图（版本 + 非密钥设置清单）；无快照时返回空版本
      return readPluginSettingsView(db)
    case 'runtimes.executors':
    case 'runtimes.detected':
    case 'runtimes.models':
    case 'plugins.all':
    case 'run.approvals':
    case 'runtimes.default-workdir':
      // 宿主视图（插件注册表 / CLI 探测 / 执行器模型目录 / 磁盘插件目录 / 会话日志提权记录 /
      // 默认工作目录）由装配根注入，不读投影
      throw new StoreError('invalid_input', `宿主视图不读投影: ${view}`)
  }
}

/** M5：`runtimes.statuses` = 全部运行时 + 实时负载。并发上限在智能体上，这里只给在跑/排队数。 */
const readRuntimeStatuses = (db: DatabaseSync): RuntimeStatus[] => {
  const workloads = new Map(readRuntimeWorkloads(db).map((item) => [item.runtimeId, item]))
  return readRuntimes(db).map((runtime) => ({
    runtimeId: runtime.id,
    workload: {
      running: workloads.get(runtime.id)?.running ?? 0,
      queued: workloads.get(runtime.id)?.queued ?? 0,
    },
  }))
}
