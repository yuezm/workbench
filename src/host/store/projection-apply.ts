/**
 * 投影变更落库：`Change.row` ↔ 十三张投影表的 snake_case 列，逐列显式映射
 * （不 `SELECT *`、不猜列名）。
 *
 * - 实体五表 / runs / conversations / messages / cards / rule_sets / threads 的整行：主键 `id`，`row === null` 删除。
 * - `run_events`：主键 `(run_id, seq)`，`Change.key = '<runId>:<seq>'`；**纯追加**，
 *   重复键直接撞唯一约束报错（禁止 `INSERT OR REPLACE` 覆盖历史）。
 * - `rule_fires`（M6）：主键 `id`；**纯追加**，重复触发事实撞主键报错（与 `run_events` 同口径）。
 * - `threads`（M6.5）：整行 upsert；每条 `thread.*` 事实都携带完整 `ThreadRow`，
 *   `taskIds` / `rootTaskIds` / `notes` / `events` 存 JSON 列。`event.merged` 不在这里特判
 *   ——它由 `kernel/project` 产 `runs` 的整行变更（`run.eventIds` 已追加）。
 * - `task_comments`（M7.5）：纯追加；任务删除时按 `task_id` 联删（与 `run_events` 同口径）。
 *
 * 级联删除由父键显式完成（事实只携带父 id）：删除 `runs` 行先按 `run_id` 删 `run_events` 与
 * `cards`；删除 `conversations` 行先按 `conversation_id` 删 `messages`。`cards.run_id` 虽然
 * 也声明了 `ON DELETE CASCADE`，但重建事务会临时关闭外键（见 `projection.ts`），只靠外键
 * 会让「增量删 run」与「重建 fold」得到不同的卡片表；显式删卡片保证两条路径等价。
 * 重建时同样走这条路径，所以「删任务 → `run.removed` → 重建」与旧 SQL 级联的可见结果一致（D13）。
 *
 * 运行类事实携带完整 `RunRow`（`kernel/project` 只回填 `queueSeq`）：这里整行 upsert；
 * `snapshot.imported` 的存量行可能缺 M2 新列，由 `normalizeRun` 补默认值。任务同理：
 * M6 前的历史行缺来源四列，由 `normalizeTask` 兜底（`kernel/project` 已归一，这里是投影边界的第二道防线）。
 *
 * `workflow_stages.created_at` 不在 `WorkflowStage` 行类型里（契约不含该字段），
 * 首次插入时用事实的 `at` 顶上，更新时保留原值——重建与增量因此得到相同的行。
 *
 * 阶段换序与 `UNIQUE(workflow_id, position)`：整批变更（一次 dispatch 或一次重建）
 * 交给 `applyAll`，写入某个阶段行前若目标 position 被**另一行**占用，先把占用行
 * 「腾位」到负区间（`-position - 1`，天然与行一一对应），批末再统一还原未被改写的行。
 * 这样换序（交换 position）、重建按 seq 重放、增量写入都走同一条路径，且不依赖
 * 事实里出现顺序的完整性；事实自相矛盾（两行最终占同一 position）时还原会撞唯一
 * 约束，整个事务回滚报错，而不是留一份错投影。
 *
 * 语句在 writer 创建时一次性 prepare：重建要 fold 上万条事实，不能每条都重新编译 SQL。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  Agent,
  Card,
  Conversation,
  Message,
  Project,
  RunEventRow,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../protocol/entities'
import type { Change, Iso, ProjectionRow, ProjectionTable } from '../../kernel/types'
import type { RuleFireRow, RuleSetRow } from '../../protocol/rules'
import type { PluginSettingsRow } from '../../protocol/plugins'
import type { ThreadRow } from '../../protocol/thread'
import type { TaskComment } from '../../protocol/task-comment'
import { StoreError } from './errors'

/** 一条投影变更 + 它所属事实的时间（阶段行首次插入的 created_at 兜底）。 */
export interface ProjectionWrite {
  change: Change
  at: Iso
}

export interface ProjectionWriter {
  apply(change: Change, at: Iso): void
  /** 整批应用（一次 dispatch / 一次重建的全部变更）：跨行换序在批内合法。 */
  applyAll(writes: readonly ProjectionWrite[]): void
  /**
   * 清空白名单十三表。
   *
   * 只能在 `PRAGMA foreign_keys = OFF` 的重建事务里调用：`runs.task_id` 是
   * `ON DELETE CASCADE`，外键开启时清 `tasks` 会连带删掉运行记录与 `run_events`。
   * 顺序按外键依赖倒序（run_events → cards → runs → messages → conversations → tasks → …），
   * 外键关掉时只是让意图可读；`cards` 先于 `runs` 删，即使外键意外开着也不会依赖级联。
   * 规则两表与 `threads` 没有外键，放最后清即可（`threads` 在全部业务行之后清）。
   */
  clear(): void
}

/** `RunRow` 字段 → `runs` 列（顺序与 schema DDL 一致；整行 upsert 与快照列清单共用）。 */
const RUN_FIELDS: ReadonlyArray<readonly [keyof RunRow, string]> = [
  ['purpose', 'purpose'],
  ['taskId', 'task_id'],
  ['stageId', 'stage_id'],
  ['agentId', 'agent_id'],
  ['runtimeId', 'runtime_id'],
  ['conversationId', 'conversation_id'],
  ['ruleId', 'rule_id'],
  ['rulesVersion', 'rules_version'],
  ['executorKey', 'executor_key'],
  ['threadId', 'thread_id'],
  ['cwd', 'cwd'],
  ['access', 'access'],
  ['skill', 'skill'],
  ['promptRef', 'prompt_ref'],
  ['eventIds', 'event_ids_json'],
  ['hops', 'hops'],
  ['turn', 'turn'],
  ['resumeSessionId', 'resume_session_id'],
  ['threadContextRef', 'thread_context_ref'],
  ['queueSeq', 'queue_seq'],
  ['status', 'status'],
  ['prompt', 'prompt'],
  ['output', 'output'],
  ['error', 'error'],
  ['errorCode', 'error_code'],
  ['exitCode', 'exit_code'],
  ['sessionId', 'session_id'],
  ['usage', 'usage_json'],
  ['durationMs', 'duration_ms'],
  ['leaseId', 'lease_id'],
  ['attempt', 'attempt'],
  ['attempts', 'attempts'],
  ['leaseUntil', 'lease_until'],
  ['notBefore', 'not_before'],
  ['deadlineAt', 'deadline_at'],
  ['cancelRequested', 'cancel_requested'],
  ['startedAt', 'started_at'],
  ['endedAt', 'ended_at'],
  ['createdAt', 'created_at'],
]

/**
 * M2 及以前的事实 payload 只有 `protocolFamily`（协议族），M3 起换成 `executorKey`。
 * 重建 fold 的是历史 payload，因此这里必须归一：缺 `executorKey` 时按旧协议族映射
 * （当前只有 `dsh` 一个取值），并补 `argsTemplate` 的空串缺省。
 * 这不是兼容字段：`Runtime` 契约里没有 `protocolFamily`，映射只存在于投影边界。
 */
type LegacyRuntime = Runtime & { protocolFamily?: string }

const normalizeRuntime = (runtime: LegacyRuntime): Runtime => ({
  ...runtime,
  executorKey: runtime.executorKey ?? runtime.protocolFamily ?? '',
  argsTemplate: runtime.argsTemplate ?? '',
})

/**
 * 规整 run 行的缺省值：`snapshot.imported` 的存量行可能缺 M2 新列（T2 迁移），
 * 补默认值后与实时写入得到同一行；`queueSeq` 默认 0 表示「早期导入、无稳定入队序」。
 */
const normalizeRun = (run: RunRow): RunRow => ({
  id: run.id,
  purpose: run.purpose ?? 'stage',
  taskId: run.taskId ?? null,
  stageId: run.stageId ?? null,
  agentId: run.agentId ?? null,
  runtimeId: run.runtimeId ?? null,
  conversationId: run.conversationId ?? null,
  ruleId: run.ruleId ?? null,
  rulesVersion: run.rulesVersion ?? 0,
  executorKey: run.executorKey ?? '',
  threadId: run.threadId ?? null,
  cwd: run.cwd ?? '',
  access: run.access ?? 'edit',
  skill: run.skill ?? null,
  promptRef: run.promptRef ?? null,
  eventIds: run.eventIds ?? [],
  hops: run.hops ?? 0,
  turn: run.turn ?? 1,
  resumeSessionId: run.resumeSessionId ?? null,
  threadContextRef: run.threadContextRef ?? null,
  queueSeq: run.queueSeq ?? 0,
  status: run.status,
  prompt: run.prompt ?? '',
  output: run.output ?? '',
  error: run.error ?? null,
  errorCode: run.errorCode ?? null,
  exitCode: run.exitCode ?? null,
  sessionId: run.sessionId ?? null,
  usage: run.usage ?? null,
  durationMs: run.durationMs ?? null,
  leaseId: run.leaseId ?? null,
  attempt: run.attempt ?? 0,
  attempts: run.attempts ?? 0,
  leaseUntil: run.leaseUntil ?? null,
  notBefore: run.notBefore ?? null,
  deadlineAt: run.deadlineAt ?? null,
  cancelRequested: run.cancelRequested ?? false,
  startedAt: run.startedAt ?? null,
  endedAt: run.endedAt ?? null,
  createdAt: run.createdAt,
})

/** 行内值 → SQLite 可绑定的值（`usage` / `eventIds` 存 JSON、布尔存 0/1）。 */
const runValue = (field: keyof RunRow, run: RunRow): SQLInputValue => {
  switch (field) {
    case 'usage':
      return run.usage === null ? null : JSON.stringify(run.usage)
    case 'eventIds':
      return JSON.stringify(run.eventIds)
    case 'cancelRequested':
      return run.cancelRequested ? 1 : 0
    default:
      return run[field] as SQLInputValue
  }
}

/**
 * 规整任务行的缺省值（M6 / M6.5）：M6 前的 `task.created` / `snapshot.imported` 行没有来源四列，
 * M6.5 前的历史行没有线程两列。`kernel/project` 已归一；这里是投影边界的第二道防线
 * （与 `normalizeRun` 同一模式），保证任何路径写入的 `Change` 都能绑参、且增量与重建折出同一行。
 */
const normalizeTask = (row: Task): Task & { gateFails: number } => {
  const legacy = row as Partial<Task>
  return {
    ...row,
    origin: legacy.origin ?? 'manual',
    ruleId: legacy.ruleId ?? null,
    externalRef: legacy.externalRef ?? null,
    labels: legacy.labels ?? [],
    projectId: legacy.projectId ?? null,
    threadId: legacy.threadId ?? null,
    parentTaskId: legacy.parentTaskId ?? null,
    spawnedByRunId: legacy.spawnedByRunId ?? null,
    batchNo: legacy.batchNo ?? null,
    spawnKey: legacy.spawnKey ?? null,
    handoffFromTaskId: legacy.handoffFromTaskId ?? null,
    handoffFromStageId: legacy.handoffFromStageId ?? null,
    // M11：闸门预算缺省 0（没失败过）
    gateFails: legacy.gateFails ?? 0,
  }
}

/** 规整阶段行的缺省值（M7 / M8 / M11）：缺交接 / 子任务 / 闸门字段时补 null。 */
const normalizeStage = (row: WorkflowStage): WorkflowStage => {
  const legacy = row as Partial<WorkflowStage>
  return {
    ...row,
    handoffWorkflowId: legacy.handoffWorkflowId ?? null,
    handoffStageId: legacy.handoffStageId ?? null,
    subtaskStageId: legacy.subtaskStageId ?? null,
    onChildrenSettled: legacy.onChildrenSettled ?? null,
    spawnPolicy: legacy.spawnPolicy ?? null,
    gate: legacy.gate ?? null,
  }
}

/** `Card` 字段 → `cards` 列（顺序与 schema DDL 一致；整行 upsert 与快照列清单共用）。 */
const CARD_FIELDS: ReadonlyArray<readonly [keyof Card, string]> = [
  ['id', 'id'],
  ['runId', 'run_id'],
  ['taskId', 'task_id'],
  ['conversationId', 'conversation_id'],
  ['title', 'title'],
  ['text', 'text'],
  ['kind', 'kind'],
  ['options', 'options_json'],
  ['key', 'key'],
  ['version', 'version'],
  ['status', 'status'],
  ['delivery', 'delivery'],
  ['deliveryRef', 'delivery_ref'],
  ['optionIndex', 'option_index'],
  ['answeredBy', 'answered_by'],
  ['answeredAt', 'answered_at'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
]

/** 行内值 → SQLite 可绑定的值（`options` 存 JSON）。 */
const cardValue = (field: keyof Card, card: Card): SQLInputValue =>
  field === 'options' ? JSON.stringify(card.options) : (card[field] as SQLInputValue)

/**
 * `ThreadRow` 字段 → `threads` 列（顺序与 schema DDL 一致；整行 upsert 共用）。
 *
 * `taskIds` / `rootTaskIds` / `notes` / `events` 存 JSON 列；`sessions` 不在行里（由 runs 现算），
 * 因此这里没有对应列。
 */
const THREAD_FIELDS: ReadonlyArray<readonly [keyof ThreadRow, string]> = [
  ['id', 'id'],
  ['source', 'source'],
  ['externalRef', 'external_ref'],
  ['title', 'title'],
  ['status', 'status'],
  ['taskIds', 'task_ids_json'],
  ['rootTaskIds', 'root_task_ids_json'],
  ['concurrency', 'concurrency'],
  ['notesVersion', 'notes_version'],
  ['notes', 'notes_json'],
  ['events', 'events_json'],
  ['lastActivityAt', 'last_activity_at'],
  ['createdAt', 'created_at'],
]

/** 行内值 → SQLite 可绑定的值（`taskIds` / `rootTaskIds` / `notes` / `events` 存 JSON）。 */
const threadValue = (field: keyof ThreadRow, thread: ThreadRow): SQLInputValue => {
  switch (field) {
    case 'taskIds':
    case 'rootTaskIds':
    case 'notes':
    case 'events':
      return JSON.stringify(thread[field])
    default:
      return thread[field] as SQLInputValue
  }
}

/**
 * `run_events.payload_json` 沿用 v2 的存放口径：事件里除 `runId/seq/type`
 * 之外的字段组成 JSON 对象（旧的 `repository.runEventsList` 按同一口径还原）。
 */
const runEventPayload = (event: RunEventRow): string => {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (key === 'runId' || key === 'seq' || key === 'type' || value === undefined) continue
    payload[key] = value
  }
  return JSON.stringify(payload)
}

export function createProjectionWriter(db: DatabaseSync): ProjectionWriter {
  const upserts = {
    tasks: db.prepare(
      `INSERT INTO tasks
         (id, title, description, workflow_id, current_stage_id, status, origin, rule_id,
          external_ref, labels_json, thread_id, parent_task_id, spawned_by_run_id, batch_no,
          spawn_key, handoff_from_task_id, handoff_from_stage_id, project_id, gate_fails,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         workflow_id = excluded.workflow_id,
         current_stage_id = excluded.current_stage_id,
         status = excluded.status,
         origin = excluded.origin,
         rule_id = excluded.rule_id,
         external_ref = excluded.external_ref,
         labels_json = excluded.labels_json,
         thread_id = excluded.thread_id,
         parent_task_id = excluded.parent_task_id,
         spawned_by_run_id = excluded.spawned_by_run_id,
         batch_no = excluded.batch_no,
         spawn_key = excluded.spawn_key,
         handoff_from_task_id = excluded.handoff_from_task_id,
         handoff_from_stage_id = excluded.handoff_from_stage_id,
         project_id = excluded.project_id,
         gate_fails = excluded.gate_fails,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ),
    projects: db.prepare(
      `INSERT INTO projects (id, name, path, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         path = excluded.path,
         description = excluded.description,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ),
    workflows: db.prepare(
      `INSERT INTO workflows (id, name, description, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         created_at = excluded.created_at`,
    ),
    workflow_stages: db.prepare(
      `INSERT INTO workflow_stages
         (id, workflow_id, name, position, entry_mode, agent_id, on_complete_stage_id, on_reject_stage_id, handoff_workflow_id, handoff_stage_id, subtask_stage_id, on_children_settled, spawn_policy, instructions, gate_max_fails, gate_on_pass_stage_id, gate_on_fail_stage_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workflow_id = excluded.workflow_id,
         name = excluded.name,
         position = excluded.position,
         entry_mode = excluded.entry_mode,
         agent_id = excluded.agent_id,
         on_complete_stage_id = excluded.on_complete_stage_id,
         on_reject_stage_id = excluded.on_reject_stage_id,
         handoff_workflow_id = excluded.handoff_workflow_id,
         handoff_stage_id = excluded.handoff_stage_id,
         subtask_stage_id = excluded.subtask_stage_id,
         on_children_settled = excluded.on_children_settled,
         spawn_policy = excluded.spawn_policy,
         instructions = excluded.instructions,
         gate_max_fails = excluded.gate_max_fails,
         gate_on_pass_stage_id = excluded.gate_on_pass_stage_id,
         gate_on_fail_stage_id = excluded.gate_on_fail_stage_id`,
    ),
    agents: db.prepare(
      `INSERT INTO agents (id, name, description, runtime_id, system_prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         runtime_id = excluded.runtime_id,
         system_prompt = excluded.system_prompt,
         created_at = excluded.created_at`,
    ),
    runtimes: db.prepare(
      `INSERT INTO runtimes
         (id, name, executor_key, command, profile, args_template, permission_mode, model,
          reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         executor_key = excluded.executor_key,
         command = excluded.command,
         profile = excluded.profile,
         args_template = excluded.args_template,
         permission_mode = excluded.permission_mode,
         model = excluded.model,
         reasoning_effort = excluded.reasoning_effort,
         workdir = excluded.workdir,
         max_concurrent = excluded.max_concurrent,
         enabled = excluded.enabled,
         last_probe_json = excluded.last_probe_json,
         created_at = excluded.created_at`,
    ),
    conversations: db.prepare(
      `INSERT INTO conversations (id, title, agent_id, project_id, session_id, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         agent_id = excluded.agent_id,
         project_id = excluded.project_id,
         session_id = excluded.session_id,
         archived_at = excluded.archived_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ),
    messages: db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         role = excluded.role,
         content = excluded.content,
         error = excluded.error,
         created_at = excluded.created_at`,
    ),
    /** 规则集单行（id='current'）整行替换：版本与规则同属一行，不做合并。 */
    rule_sets: db.prepare(
      `INSERT INTO rule_sets (id, version, replaced_at, rules_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         replaced_at = excluded.replaced_at,
         rules_json = excluded.rules_json`,
    ),
    /** 插件设置单行（id='current'）整行替换：版本与非密钥设置同属一行。 */
    plugin_settings: db.prepare(
      `INSERT INTO plugin_settings (id, version, replaced_at, settings_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         replaced_at = excluded.replaced_at,
         settings_json = excluded.settings_json`,
    ),
  }

  const runColumns = RUN_FIELDS.map(([, column]) => column).join(', ')
  const runPlaceholders = RUN_FIELDS.map(() => '?').join(', ')
  const runUpdates = RUN_FIELDS.map(([, column]) => `${column} = excluded.${column}`).join(', ')
  const insertRun = db.prepare(
    `INSERT INTO runs (id, ${runColumns}) VALUES (?, ${runPlaceholders})
     ON CONFLICT(id) DO UPDATE SET ${runUpdates}`,
  )

  // 卡片同样是整行 upsert：`card.*` 事实携带完整行，投递/回答/关闭都不需要合并旧行。
  const cardColumns = CARD_FIELDS.map(([, column]) => column).join(', ')
  const cardPlaceholders = CARD_FIELDS.map(() => '?').join(', ')
  const cardUpdates = CARD_FIELDS.map(([, column]) => `${column} = excluded.${column}`).join(', ')
  const insertCard = db.prepare(
    `INSERT INTO cards (${cardColumns}) VALUES (${cardPlaceholders})
     ON CONFLICT(id) DO UPDATE SET ${cardUpdates}`,
  )

  /** 运行事件纯追加：重复 `(run_id, seq)` 撞主键报错，不覆盖。 */
  const insertRunEvent = db.prepare(
    `INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )

  /** 规则触发纯追加（M6）：重复 `id` 撞主键报错，不覆盖历史触发记录。 */
  const insertRuleFire =
    db.prepare(`INSERT INTO rule_fires (id, rule_id, version, scheduled_for, fired_at, task_id)
     VALUES (?, ?, ?, ?, ?, ?)`)

  /** 任务上下文 / 反馈纯追加（M7.5）：一条事实一行评论，重复 id 撞主键报错。 */
  const insertTaskComment = db.prepare(
    `INSERT INTO task_comments (id, task_id, author, text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )

  // 线程同样是整行 upsert（M6.5）：`thread.*` 事实携带完整行，按 (source, external_ref) 找线程
  // 是内核在视图里做的，这里只搬运行。
  const threadColumns = THREAD_FIELDS.map(([, column]) => column).join(', ')
  const threadPlaceholders = THREAD_FIELDS.map(() => '?').join(', ')
  const threadUpdates = THREAD_FIELDS.filter(([field]) => field !== 'id')
    .map(([, column]) => `${column} = excluded.${column}`)
    .join(', ')
  const insertThread = db.prepare(
    `INSERT INTO threads (${threadColumns}) VALUES (${threadPlaceholders})
     ON CONFLICT(id) DO UPDATE SET ${threadUpdates}`,
  )

  const deletes = {
    tasks: db.prepare('DELETE FROM tasks WHERE id = ?'),
    workflows: db.prepare('DELETE FROM workflows WHERE id = ?'),
    workflow_stages: db.prepare('DELETE FROM workflow_stages WHERE id = ?'),
    agents: db.prepare('DELETE FROM agents WHERE id = ?'),
    runtimes: db.prepare('DELETE FROM runtimes WHERE id = ?'),
    projects: db.prepare('DELETE FROM projects WHERE id = ?'),
    runs: db.prepare('DELETE FROM runs WHERE id = ?'),
    run_events: db.prepare('DELETE FROM run_events WHERE run_id = ?'),
    /** 卡片随 run 显式联删（重建事务关外键，不能只靠 `cards.run_id` 的级联）。 */
    cardsByRun: db.prepare('DELETE FROM cards WHERE run_id = ?'),
    conversations: db.prepare('DELETE FROM conversations WHERE id = ?'),
    messages: db.prepare('DELETE FROM messages WHERE conversation_id = ?'),
    cards: db.prepare('DELETE FROM cards WHERE id = ?'),
    /** 规则两表、线程表与插件设置表都没有删除事实，语句只为满足 `ProjectionTable` 全集。 */
    rule_sets: db.prepare('DELETE FROM rule_sets WHERE id = ?'),
    rule_fires: db.prepare('DELETE FROM rule_fires WHERE id = ?'),
    threads: db.prepare('DELETE FROM threads WHERE id = ?'),
    plugin_settings: db.prepare('DELETE FROM plugin_settings WHERE id = ?'),
    /** 任务上下文没有删除事实：按 id 与按父任务联删（任务删除时）两条路径。 */
    task_comments: db.prepare('DELETE FROM task_comments WHERE id = ?'),
    taskCommentsByTask: db.prepare('DELETE FROM task_comments WHERE task_id = ?'),
  }

  const clearAll = {
    run_events: db.prepare('DELETE FROM run_events'),
    runs: db.prepare('DELETE FROM runs'),
    messages: db.prepare('DELETE FROM messages'),
    conversations: db.prepare('DELETE FROM conversations'),
    cards: db.prepare('DELETE FROM cards'),
    tasks: db.prepare('DELETE FROM tasks'),
    workflow_stages: db.prepare('DELETE FROM workflow_stages'),
    workflows: db.prepare('DELETE FROM workflows'),
    agents: db.prepare('DELETE FROM agents'),
    runtimes: db.prepare('DELETE FROM runtimes'),
    projects: db.prepare('DELETE FROM projects'),
    rule_fires: db.prepare('DELETE FROM rule_fires'),
    rule_sets: db.prepare('DELETE FROM rule_sets'),
    threads: db.prepare('DELETE FROM threads'),
    plugin_settings: db.prepare('DELETE FROM plugin_settings'),
    task_comments: db.prepare('DELETE FROM task_comments'),
  }

  const stageOccupant = db.prepare(
    'SELECT id FROM workflow_stages WHERE workflow_id = ? AND position = ?',
  )
  const parkStage = db.prepare('UPDATE workflow_stages SET position = ? WHERE id = ?')
  const unparkStages = db.prepare(
    'UPDATE workflow_stages SET position = -position - 1 WHERE workflow_id = ? AND position < 0',
  )

  /** 一行变更 → 一条 upsert；`at` 只给没有 created_at 字段的阶段行兜底。 */
  const writes: Record<ProjectionTable, (row: ProjectionRow, at: Iso) => void> = {
    tasks: (row) => {
      const task = normalizeTask(row as Task)
      upserts.tasks.run(
        task.id,
        task.title,
        task.description,
        task.workflowId,
        task.currentStageId,
        task.status,
        task.origin,
        task.ruleId,
        task.externalRef,
        JSON.stringify(task.labels),
        task.threadId,
        task.parentTaskId,
        task.spawnedByRunId ?? null,
        task.batchNo ?? null,
        task.spawnKey ?? null,
        task.handoffFromTaskId,
        task.handoffFromStageId,
        task.projectId ?? null,
        // 闸门预算已由 `normalizeTask` 归一（缺省 0），这里不再重复兜底
        task.gateFails,
        task.createdAt,
        task.updatedAt,
      )
    },
    projects: (row) => {
      const project = row as Project
      upserts.projects.run(
        project.id,
        project.name,
        project.path,
        project.description,
        project.createdAt,
        project.updatedAt,
      )
    },
    workflows: (row) => {
      const workflow = row as Workflow
      upserts.workflows.run(workflow.id, workflow.name, workflow.description, workflow.createdAt)
    },
    workflow_stages: (row, at) => {
      const stage = normalizeStage(row as WorkflowStage)
      upserts.workflow_stages.run(
        stage.id,
        stage.workflowId,
        stage.name,
        stage.position,
        stage.entryMode,
        stage.agentId,
        stage.onCompleteStageId,
        stage.onRejectStageId,
        stage.handoffWorkflowId,
        stage.handoffStageId,
        stage.subtaskStageId ?? null,
        stage.onChildrenSettled ?? null,
        stage.spawnPolicy ?? null,
        stage.instructions ?? '',
        stage.gate?.maxFails ?? null,
        stage.gate?.onPassStageId ?? null,
        stage.gate?.onFailStageId ?? null,
        at,
      )
    },
    agents: (row) => {
      const agent = row as Agent
      upserts.agents.run(
        agent.id,
        agent.name,
        agent.description,
        agent.runtimeId,
        agent.systemPrompt,
        agent.createdAt,
      )
    },
    runtimes: (row) => {
      const runtime = normalizeRuntime(row as LegacyRuntime)
      upserts.runtimes.run(
        runtime.id,
        runtime.name,
        runtime.executorKey,
        runtime.command,
        runtime.profile,
        runtime.argsTemplate,
        runtime.permissionMode,
        runtime.model,
        runtime.reasoningEffort,
        runtime.workdir,
        runtime.maxConcurrent,
        runtime.enabled ? 1 : 0,
        runtime.lastProbe === null ? null : JSON.stringify(runtime.lastProbe),
        runtime.createdAt,
      )
    },
    runs: (row) => {
      const run = normalizeRun(row as RunRow)
      insertRun.run(run.id, ...RUN_FIELDS.map(([field]) => runValue(field, run)))
    },
    run_events: (row, at) => {
      const event = row as RunEventRow
      insertRunEvent.run(event.runId, event.seq, event.type, runEventPayload(event), at)
    },
    conversations: (row) => {
      const conversation = row as Conversation
      upserts.conversations.run(
        conversation.id,
        conversation.title,
        conversation.agentId,
        // M11：老事实 / 存量导入行没有项目，按 null（默认目录）归一
        conversation.projectId ?? null,
        conversation.sessionId,
        conversation.archivedAt ?? null,
        conversation.createdAt,
        conversation.updatedAt,
      )
    },
    messages: (row) => {
      const message = row as Message
      upserts.messages.run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.error,
        message.createdAt,
      )
    },
    cards: (row) => {
      const card = row as Card
      insertCard.run(...CARD_FIELDS.map(([field]) => cardValue(field, card)))
    },
    rule_sets: (row) => {
      const ruleSet = row as RuleSetRow
      upserts.rule_sets.run(
        ruleSet.id,
        ruleSet.version,
        ruleSet.replacedAt,
        JSON.stringify(ruleSet.rules),
      )
    },
    rule_fires: (row) => {
      const fire = row as RuleFireRow
      insertRuleFire.run(
        fire.id,
        fire.ruleId,
        fire.version,
        fire.scheduledFor,
        fire.firedAt,
        fire.taskId,
      )
    },
    plugin_settings: (row) => {
      const settings = row as PluginSettingsRow
      upserts.plugin_settings.run(
        settings.id,
        settings.version,
        settings.replacedAt,
        JSON.stringify(settings.settings),
      )
    },
    threads: (row) => {
      const thread = row as ThreadRow
      insertThread.run(...THREAD_FIELDS.map(([field]) => threadValue(field, thread)))
    },
    task_comments: (row) => {
      const comment = row as TaskComment
      insertTaskComment.run(
        comment.id,
        comment.taskId,
        comment.author,
        comment.text,
        comment.createdAt,
      )
    },
  }

  /** 目标 position 被另一行占用时，把占用行挪到负区间；返回需要还原的 workflow。 */
  const parkOccupant = (stage: WorkflowStage, parked: Set<string>): void => {
    const occupant = stageOccupant.get(stage.workflowId, stage.position) as unknown as
      { id: string } | undefined
    if (!occupant || occupant.id === stage.id) return
    parkStage.run(-stage.position - 1, occupant.id)
    parked.add(stage.workflowId)
  }

  const applySingle = (change: Change, at: Iso, parked: Set<string>): void => {
    if (!(change.table in writes)) {
      throw new StoreError('invalid_input', `未知投影表: ${String(change.table)}`)
    }
    if (change.row === null) {
      // 级联删除由父键显式完成（事实只携带父 id）：run → run_events + cards；conversation → messages。
      if (change.table === 'runs') {
        deletes.run_events.run(change.key)
        deletes.cardsByRun.run(change.key)
      }
      if (change.table === 'conversations') deletes.messages.run(change.key)
      // M7.5：任务删除联删其上下文 / 反馈（重建事务关外键，不能只靠级联）
      if (change.table === 'tasks') deletes.taskCommentsByTask.run(change.key)
      deletes[change.table].run(change.key)
      return
    }
    if (change.table === 'workflow_stages') parkOccupant(change.row as WorkflowStage, parked)
    writes[change.table](change.row, at)
  }

  const applyAll = (batch: readonly ProjectionWrite[]): void => {
    const parked = new Set<string>()
    try {
      for (const write of batch) applySingle(write.change, write.at, parked)
    } finally {
      // 批末还原「被腾位但没被改写」的阶段行；事实自相矛盾时这里会撞唯一约束并回滚。
      for (const workflowId of parked) unparkStages.run(workflowId)
    }
  }

  const apply = (change: Change, at: Iso): void => applyAll([{ change, at }])

  const clear = (): void => {
    clearAll.run_events.run()
    clearAll.cards.run()
    clearAll.runs.run()
    clearAll.messages.run()
    clearAll.conversations.run()
    clearAll.task_comments.run()
    clearAll.tasks.run()
    clearAll.workflow_stages.run()
    clearAll.workflows.run()
    clearAll.agents.run()
    clearAll.runtimes.run()
    clearAll.projects.run()
    clearAll.rule_fires.run()
    clearAll.rule_sets.run()
    clearAll.threads.run()
    clearAll.plugin_settings.run()
  }

  return { apply, applyAll, clear }
}
