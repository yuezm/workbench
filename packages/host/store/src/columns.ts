/**
 * 投影表的**列描述符**：一张表的列清单与每列的编解码，只在这里定义一次。
 *
 * 为什么要有这一层：投影行原先有四处表述——DDL（`host/schema`）、写侧字段表
 * （`projection-apply` 的 `RUN_FIELDS` + `runValue`）、读侧列常量（`views` 的
 * `TASK_COLUMNS` 等）与读侧映射（`views` 的 `mapRun`）。四处之间没有编译期约束，
 * 改漏一处不报错；编解码还不对称（写侧 `JSON.stringify(v ?? null)`，读侧又额外
 * 容忍空串与字符串 `'null'`）。现在三者都从本文件派生：
 *
 * - **写**：`INSERT` 的列清单、占位符个数、`ON CONFLICT … excluded.*` 全由描述符生成；
 * - **读**：`SELECT` 列清单与「一行 → 契约对象」的映射由描述符生成；
 * - **形状**：DDL 仍是 DDL（约束、外键、默认值在那里），但「列清单是否与描述符一致」
 *   由 `tests/host/store/columns.test.ts` 用真实库的 `PRAGMA table_info` 断言。
 *
 * 三条约定：
 * 1. 列顺序与 DDL 一致（护栏测试按顺序比对）；
 * 2. `prop` 是契约里的字段名；两个保留名不是字段：
 *    `'@at'` = 写入时补的事实时刻（`workflow_stages.created_at` / `run_events.created_at`），
 *    `'@payload'` = `run_events` 的复合 payload（除 runId/seq/type 外的字段）；
 * 3. 编解码成对写在一处：`encode` 把契约值变成可绑定值，`decode` 把它变回契约值，
 *    「读侧兜写侧的缺省」这种不对称在结构上不可能再出现。
 */
import type { SQLInputValue } from 'node:sqlite'
import type { ProjectionTable } from '@workbench/kernel/core/types'
import type { CardChannelRef, RunEventRow } from '@workbench/protocol/entities'
import { parseAgentEnv } from './agent-env'

/**
 * 契约行（投影的 `Change.row`）：按字段名取值。
 *
 * 用 `object` 而不是 `Record<string, unknown>` 收口：契约类型都是具名 interface，
 * 没有索引签名，写成 Record 会把每一处调用点都变成不合法的赋值。
 */
export type ProjectionRowShape = object

/** 一列的编解码：两个方向只在这一处定义。 */
export interface ColumnCodec {
  encode(value: unknown, row: ProjectionRowShape): SQLInputValue
  decode(raw: unknown): unknown
}

export interface ColumnDef {
  /** 契约字段名（或保留名 `'@at'` / `'@payload'`） */
  prop: string
  /** 表里的列名 */
  column: string
  codec: ColumnCodec
}

/** 冲突语义：整行覆盖 / 纯追加 / 只回写一列（补跑与投递重试用）。 */
export type ConflictMode = 'all' | 'none' | 'received_at' | 'replayed_at'

export interface TableShape {
  table: ProjectionTable
  columns: readonly ColumnDef[]
  conflict: ConflictMode
  /**
   * 冲突更新时**不覆盖**的列：整行由事实携带，但个别列只属于首次写入
   * （`workflow_stages.created_at` = 阶段被创建的时刻，改阶段不该把它挪到现在）。
   */
  keepOnConflict?: readonly string[]
}

/** 绑定值归一：`undefined` 落 NULL、布尔落 0/1（node:sqlite 不认 boolean）。 */
const toCell = (value: unknown): SQLInputValue => {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value as SQLInputValue
}

/** 逐列直取（无 JSON、无枚举收窄）。 */
const plain: ColumnCodec = { encode: (value) => toCell(value), decode: (raw) => raw }

/** NOT NULL 的文本列但没有 DDL 默认值：缺字段按空串落库（与旧写侧 `?? ''` 同口径）。 */
const text: ColumnCodec = {
  encode: (value) => toCell(value ?? ''),
  decode: (raw) => raw,
}

/** 布尔列（INTEGER 0/1）。 */
const bool: ColumnCodec = {
  encode: (value) => (value === true ? 1 : 0),
  decode: (raw) => raw === 1,
}

const isBlank = (raw: unknown): boolean =>
  raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')

/** 坏 JSON 一律按 fallback 归一：一条脏行不该把整张视图读挂。 */
const parseOr = (raw: string, fallback: unknown): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** JSON 数组列（NOT NULL DEFAULT '[]'）：写侧缺省补 `[]`，读侧空串 / 坏值按 `[]`。 */
const jsonArray: ColumnCodec = {
  encode: (value) => JSON.stringify(value ?? []),
  decode: (raw) => (isBlank(raw) ? [] : parseOr(String(raw), [])),
}

/** JSON 对象列（`exits_json` / `env_json` / 投递记录）：缺省补 `{}`。 */
const jsonObject: ColumnCodec = {
  encode: (value) => JSON.stringify(value ?? {}),
  decode: (raw) => {
    const parsed = isBlank(raw) ? {} : parseOr(String(raw), {})
    return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ? {} : parsed
  },
}

/** 可空 JSON 列（`usage_json` / `artifact_json`）：NULL 与「没有」同义。 */
const jsonNullable: ColumnCodec = {
  encode: (value) => (value === null || value === undefined ? null : JSON.stringify(value)),
  decode: (raw) => (isBlank(raw) ? null : parseOr(String(raw), null)),
}

/**
 * NOT NULL 的 JSON 文本列（`script_json` / `judge_json`，默认值就是字符串 `'null'`）。
 *
 * 写侧恒写 `JSON.stringify(v ?? null)`（历史行因此存的是字符串 `'null'`）；
 * 读侧把 `'null'` / 空串一并归一成 `null`——这条口径只在这里出现一次。
 */
const jsonLiteral: ColumnCodec = {
  encode: (value) => JSON.stringify(value ?? null),
  decode: (raw) => {
    if (isBlank(raw)) return null
    const text = String(raw)
    return text === 'null' ? null : parseOr(text, null)
  },
}

/** `agents.env_json`：键值对，键名形状由协议层校验，读侧按同一口径还原。 */
const agentEnv: ColumnCodec = {
  encode: (value) => JSON.stringify(value ?? {}),
  decode: (raw) => parseAgentEnv(isBlank(raw) ? '{}' : String(raw)),
}

/** `cards.delivery_refs_json`：按通道的投递记录（解析不出对象就按「没发过」）。 */
export const deliveryRefs: ColumnCodec = {
  encode: (value) => JSON.stringify(value ?? {}),
  decode: (raw) => {
    const parsed = isBlank(raw) ? {} : parseOr(String(raw), {})
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, CardChannelRef>
  },
}

/**
 * `run_events.payload_json`：除 `runId / seq / type` 之外的字段组成 JSON 对象
 * （沿用 v2 的存放口径，旧观察者按同一规则还原）。
 */
export const runEventPayloadCodec: ColumnCodec = {
  encode: (_value, row) => {
    const event = row as unknown as RunEventRow
    const payload: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event)) {
      // `@at` 是写入侧注进去的事实时刻，属于列不属于 payload
      if (key === 'runId' || key === 'seq' || key === 'type' || key.startsWith('@')) continue
      if (value === undefined) continue
      payload[key] = value
    }
    return JSON.stringify(payload)
  },
  decode: (raw) => (isBlank(raw) ? {} : parseOr(String(raw), {})),
}

/** 写入时补的事实时刻（行里没有这个字段的表用）。 */
const factAt: ColumnCodec = {
  encode: (_value, row) => toCell((row as Record<string, unknown>)['@at']),
  decode: (raw) => raw,
}

/** 列定义简写：`[prop, column, codec?]`。 */
const col = (prop: string, column: string, codec: ColumnCodec = plain): ColumnDef => ({
  prop,
  column,
  codec,
})

/** 列名与字段名同形的列（snake_case 与 camelCase 逐个写出来，便于与 DDL 对照）。 */
const col2 = (prop: string, column: string): ColumnDef => col(prop, column)

const table = (
  name: ProjectionTable,
  columns: readonly ColumnDef[],
  conflict: ConflictMode = 'all',
  keepOnConflict: readonly string[] = [],
): TableShape =>
  keepOnConflict.length === 0
    ? { table: name, columns, conflict }
    : { table: name, columns, conflict, keepOnConflict }

/**
 * 全部投影表（顺序与 `PROJECTION_TABLES` 无关，护栏测试按 `PROJECTION_TABLES` 取）。
 *
 * 列顺序严格按 `host/schema` 的 DDL 书写——`columns.test.ts` 会拿真实库的
 * `PRAGMA table_info` 逐列比对，顺序不一致即失败。
 */
export const TABLE_SHAPES: Readonly<Record<ProjectionTable, TableShape>> = {
  runtimes: table('runtimes', [
    col2('id', 'id'),
    col2('name', 'name'),
    col2('executorKey', 'executor_key'),
    col2('command', 'command'),
    col2('profile', 'profile'),
    col2('argsTemplate', 'args_template'),
    col('enabled', 'enabled', bool),
    col('lastProbe', 'last_probe_json', jsonNullable),
    col2('createdAt', 'created_at'),
  ]),
  agents: table('agents', [
    col2('id', 'id'),
    col2('name', 'name'),
    col2('description', 'description'),
    col2('runtimeId', 'runtime_id'),
    col2('systemPrompt', 'system_prompt'),
    col2('model', 'model'),
    col2('reasoningEffort', 'reasoning_effort'),
    col2('maxConcurrent', 'max_concurrent'),
    col2('permissionMode', 'permission_mode'),
    col2('workdir', 'workdir'),
    col('env', 'env_json', agentEnv),
    col2('createdAt', 'created_at'),
  ]),
  workflows: table('workflows', [
    col2('id', 'id'),
    col2('name', 'name'),
    col2('description', 'description'),
    col2('createdAt', 'created_at'),
  ]),
  workflow_stages: table(
    'workflow_stages',
    [
      col2('id', 'id'),
      col2('workflowId', 'workflow_id'),
      col2('name', 'name'),
      col2('position', 'position'),
      col2('entryMode', 'entry_mode'),
      col2('agentId', 'agent_id'),
      col('script', 'script_json', jsonLiteral),
      col('exits', 'exits_json', jsonObject),
      col('handoffs', 'handoffs_json', jsonArray),
      col2('subtaskStageId', 'subtask_stage_id'),
      col2('onChildrenSettled', 'on_children_settled'),
      col2('spawnPolicy', 'spawn_policy'),
      col('instructions', 'instructions', text),
      col('acceptance', 'acceptance_json', jsonArray),
      col2('runTimeoutMs', 'run_timeout_ms'),
      col('judge', 'judge_json', jsonLiteral),
      col2('builtin', 'builtin'),
      // 阶段行没有 createdAt 字段：首次插入用事实时刻（写入侧的 `at`）
      col('@at', 'created_at', factAt),
    ],
    'all',
    ['created_at'],
  ),
  tasks: table('tasks', [
    col2('id', 'id'),
    col2('title', 'title'),
    col2('description', 'description'),
    col2('workflowId', 'workflow_id'),
    col2('currentStageId', 'current_stage_id'),
    col2('status', 'status'),
    col2('origin', 'origin'),
    col2('ruleId', 'rule_id'),
    col2('externalRef', 'external_ref'),
    col('labels', 'labels_json', jsonArray),
    col2('threadId', 'thread_id'),
    col2('parentTaskId', 'parent_task_id'),
    col2('spawnedByRunId', 'spawned_by_run_id'),
    col2('batchNo', 'batch_no'),
    col2('spawnKey', 'spawn_key'),
    col2('handoffFromTaskId', 'handoff_from_task_id'),
    col2('handoffFromStageId', 'handoff_from_stage_id'),
    col2('handoffFromRunId', 'handoff_from_run_id'),
    col2('projectId', 'project_id'),
    col2('gateFails', 'gate_fails'),
    col2('createdAt', 'created_at'),
    col2('updatedAt', 'updated_at'),
  ]),
  projects: table('projects', [
    col2('id', 'id'),
    col2('name', 'name'),
    col2('path', 'path'),
    col2('description', 'description'),
    col2('createdAt', 'created_at'),
    col2('updatedAt', 'updated_at'),
  ]),
  runs: table('runs', [
    col2('id', 'id'),
    col2('taskId', 'task_id'),
    col2('stageId', 'stage_id'),
    col2('agentId', 'agent_id'),
    col('script', 'script_json', jsonLiteral),
    col2('runtimeId', 'runtime_id'),
    col2('purpose', 'purpose'),
    col2('conversationId', 'conversation_id'),
    col2('ruleId', 'rule_id'),
    col2('rulesVersion', 'rules_version'),
    col2('executorKey', 'executor_key'),
    col2('threadId', 'thread_id'),
    col2('cwd', 'cwd'),
    col2('access', 'access'),
    col2('skill', 'skill'),
    col2('promptRef', 'prompt_ref'),
    col('eventIds', 'event_ids_json', jsonArray),
    col2('hops', 'hops'),
    col2('turn', 'turn'),
    col2('resumeSessionId', 'resume_session_id'),
    col2('threadContextRef', 'thread_context_ref'),
    col2('queueSeq', 'queue_seq'),
    col2('status', 'status'),
    col2('prompt', 'prompt'),
    col2('output', 'output'),
    col2('error', 'error'),
    col2('errorCode', 'error_code'),
    col2('exitCode', 'exit_code'),
    col2('sessionId', 'session_id'),
    col('usage', 'usage_json', jsonNullable),
    col2('durationMs', 'duration_ms'),
    col2('leaseId', 'lease_id'),
    col2('attempt', 'attempt'),
    col2('attempts', 'attempts'),
    col2('leaseUntil', 'lease_until'),
    col2('notBefore', 'not_before'),
    col2('deadlineAt', 'deadline_at'),
    col('cancelRequested', 'cancel_requested', bool),
    col('deliverables', 'deliverables_json', jsonNullable),
    col2('startedAt', 'started_at'),
    col2('endedAt', 'ended_at'),
    col2('createdAt', 'created_at'),
  ]),
  run_events: table(
    'run_events',
    [
      col2('runId', 'run_id'),
      col2('seq', 'seq'),
      col2('type', 'type'),
      col('@payload', 'payload_json', runEventPayloadCodec),
      col('@at', 'created_at', factAt),
    ],
    'none',
  ),
  conversations: table('conversations', [
    col2('id', 'id'),
    col2('title', 'title'),
    col2('agentId', 'agent_id'),
    col2('projectId', 'project_id'),
    col2('threadId', 'thread_id'),
    col2('sessionId', 'session_id'),
    col2('archivedAt', 'archived_at'),
    col2('createdAt', 'created_at'),
    col2('updatedAt', 'updated_at'),
  ]),
  messages: table('messages', [
    col2('id', 'id'),
    col2('conversationId', 'conversation_id'),
    col2('role', 'role'),
    col2('content', 'content'),
    col2('error', 'error'),
    col2('createdAt', 'created_at'),
  ]),
  cards: table('cards', [
    col2('id', 'id'),
    col2('runId', 'run_id'),
    col2('taskId', 'task_id'),
    col2('conversationId', 'conversation_id'),
    col2('title', 'title'),
    col2('text', 'text'),
    col2('kind', 'kind'),
    col('options', 'options_json', jsonArray),
    col2('key', 'key'),
    col2('version', 'version'),
    col2('status', 'status'),
    col2('delivery', 'delivery'),
    col2('deliveryRef', 'delivery_ref'),
    col('deliveryRefs', 'delivery_refs_json', deliveryRefs),
    col2('deliveryAttempts', 'delivery_attempts'),
    col2('nextDeliveryAt', 'next_delivery_at'),
    col('deliveryGivenUp', 'delivery_given_up', bool),
    col2('optionIndex', 'option_index'),
    col2('answeredBy', 'answered_by'),
    col2('answeredByRef', 'answered_by_ref'),
    col2('answeredAt', 'answered_at'),
    col2('createdAt', 'created_at'),
    col2('updatedAt', 'updated_at'),
  ]),
  rule_sets: table('rule_sets', [
    col2('id', 'id'),
    col2('version', 'version'),
    col2('replacedAt', 'replaced_at'),
    col('rules', 'rules_json', jsonArray),
  ]),
  rule_fires: table(
    'rule_fires',
    [
      col2('id', 'id'),
      col2('ruleId', 'rule_id'),
      col2('version', 'version'),
      col2('scheduledFor', 'scheduled_for'),
      col2('firedAt', 'fired_at'),
      col2('taskId', 'task_id'),
    ],
    'none',
  ),
  threads: table('threads', [
    col2('id', 'id'),
    col2('source', 'source'),
    col2('externalRef', 'external_ref'),
    col2('title', 'title'),
    col2('status', 'status'),
    col('taskIds', 'task_ids_json', jsonArray),
    col('rootTaskIds', 'root_task_ids_json', jsonArray),
    col2('concurrency', 'concurrency'),
    col2('notesVersion', 'notes_version'),
    col('notes', 'notes_json', jsonArray),
    col('events', 'events_json', jsonArray),
    col2('lastActivityAt', 'last_activity_at'),
    col2('createdAt', 'created_at'),
  ]),
  plugin_settings: table('plugin_settings', [
    col2('id', 'id'),
    col2('version', 'version'),
    col2('replacedAt', 'replaced_at'),
    col('settings', 'settings_json', jsonArray),
  ]),
  task_comments: table(
    'task_comments',
    [
      col2('id', 'id'),
      col2('taskId', 'task_id'),
      col2('author', 'author'),
      col2('text', 'text'),
      col2('createdAt', 'created_at'),
    ],
    'none',
  ),
  review_reports: table('review_reports', [
    col2('id', 'id'),
    col2('taskId', 'task_id'),
    col2('stageId', 'stage_id'),
    col2('runId', 'run_id'),
    col2('threadId', 'thread_id'),
    col2('rev', 'rev'),
    col2('verdict', 'verdict'),
    col('checks', 'checks_json', jsonArray),
    col('findings', 'findings_json', jsonArray),
    col('artifact', 'artifact_json', jsonNullable),
    col2('createdAt', 'created_at'),
    col2('updatedAt', 'updated_at'),
  ]),
  events: table(
    'events',
    [
      col2('id', 'id'),
      col2('source', 'source'),
      col2('type', 'type'),
      col2('subject', 'subject'),
      col2('summary', 'summary'),
      col2('detailRef', 'detail_ref'),
      col2('link', 'link'),
      col2('hops', 'hops'),
      col2('originRunId', 'origin_run_id'),
      col2('dedupeKey', 'dedupe_key'),
      col2('receivedAt', 'received_at'),
    ],
    'received_at',
  ),
  event_skips: table(
    'event_skips',
    [
      col2('id', 'id'),
      col2('ruleId', 'rule_id'),
      col2('eventId', 'event_id'),
      col2('version', 'version'),
      col2('skippedAt', 'skipped_at'),
      col2('replayedAt', 'replayed_at'),
    ],
    'replayed_at',
  ),
}

/** 一行的绑定值（按描述符顺序；`at` 供 `'@at'` 列使用）。 */
export function valuesOf(shape: TableShape, row: object, at?: string): SQLInputValue[] {
  const source: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  if (at !== undefined) source['@at'] = at
  return shape.columns.map((def) => def.codec.encode(source[def.prop], source))
}

/** `INSERT` 语句（列清单、占位符与 `ON CONFLICT` 分支都由描述符生成）。 */
export function insertSql(shape: TableShape): string {
  const columns = shape.columns.map((def) => def.column)
  const placeholders = columns.map(() => '?')
  const head = `INSERT INTO ${shape.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
  if (shape.conflict === 'none') return head
  if (shape.conflict === 'all') {
    const keep = shape.keepOnConflict ?? []
    const updates = columns
      .filter((column) => column !== 'id' && !keep.includes(column))
      .map((column) => `${column} = excluded.${column}`)
    return `${head}\nON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`
  }
  // 补跑 / 重投只回写一个时刻列，其余列保持首次写入的值
  return `${head}\nON CONFLICT(id) DO UPDATE SET ${shape.conflict} = excluded.${shape.conflict}`
}

/** `SELECT` 列清单。 */
export function selectList(shape: TableShape): string {
  return shape.columns.map((def) => def.column).join(', ')
}

/**
 * 一行 → 契约对象：按描述符的 `prop` 组装，JSON 列由同一个 codec 还原。
 *
 * `'@at'` / `'@payload'` 是写入侧的保留名，读侧不产生字段，因此跳过。
 */
export function fromRow<T>(shape: TableShape, raw: object): T {
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const def of shape.columns) {
    if (def.prop.startsWith('@')) continue
    out[def.prop] = def.codec.decode(source[def.column])
  }
  return out as T
}
