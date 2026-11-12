/**
 * v2 存量导入：把旧表写成 `snapshot.imported` 事实根，之后日志即唯一权威。
 *
 * 两条路径（都对同一份事实日志幂等）：
 *
 * 1. **首次迁移**（`facts` 为空）：把实体五表 + `runs` / `run_events` 按 FK 安全顺序
 *    （runtimes → agents → workflows → workflow_stages → tasks → runs → run_events）
 *    读出、每批 ≤500 行写一条导入根；同一事务里先清空全部投影表再按导入根回填，
 *    最后写 `projection_meta`，之后 `ensureProjection` 直接放行。清空是必须的：
 *    `run_events` 纯追加（重复 `(run_id,seq)` 撞主键），不清就无法与旧行共存；
 *    先清后填也让「首次迁移的结果」与「按事实重建的结果」严格是同一个 fold。
 * 2. **M2 升级补迁移**（`facts` 非空）：M1 只把实体五表写成了事实，`runs` / `run_events`
 *    仍是旧写路径留下的非事实数据；此时**只补运行两表**，条件为「事实日志里没有任何
 *    运行事实、也没有 runs/run_events 的导入根」且「`runs` 表有存量行」。
 *    这条路径只追加事实、不落投影、不写元信息——随后的 `ensureProjection` 会因指纹
 *    失配整体重建，把导入根与后续事实一起重新 fold 成同一份投影（也避免在过期投影上
 *    做部分写入）。
 *
 * 幂等：导入根本身就是 marker——首次迁移后 `facts` 非空、补迁移后事实里有
 * `snapshot.imported(runs/run_events)` 或 `run.*` 事实，两条路径都会在下次启动 no-op。
 * 失败整体回滚，可安全重试。
 *
 * 读旧表用显式列清单（不 `SELECT *` 猜列）：`runs` 只读 v2 的列，M2 新增的调度列
 * 在导入前按固定默认值归一（见 `toRunRow`）——存量行没有这些值，节省一次全表 UPDATE。
 * `run_events` 只读 `(run_id, seq, type, payload_json)`：事件的时间戳不进行类型，
 * 投影 `created_at` 统一取导入根的时刻（与「重建只靠事实」一致，不伪装逐事件时间）。
 *
 * 导入根没有 `cause`：`timeline` 标「迁移导入」，不伪造因果链。
 * 聊天表（`conversations` / `messages` 与旧 `chat_*`，T14b）读成导入根后由投影重建、
 * 随后删除旧表；表不存在（新库 / 已迁移）跳过。
 *
 * 本文件是 **M2 兼容层**：只为「M1 / v2 旧库升级到账本」服务，新库没有任何旧表可读。
 * M4 的 `cards` 不参与 v2 导入（v2 没有卡片数据，`emptyCounts().cards` 恒 0）：首次迁移的
 * `writer.clear()` 顺带清掉旧库里可能残留的 `cards` 行，并在导入后断言它为空；补迁移路径
 * 不落投影，由随后的 `ensureProjection()` 按事实重建把 `cards` 归零。
 * 迁移窗口关闭后整体删除，**M3 再删**（连同 `host/db.ts` 的旧 `runs` 一次性升级）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  ChatRole,
  Conversation,
  EntryMode,
  Message,
  PermissionMode,
  RunErrorCode,
  RunEventRow,
  RunEventType,
  RunRow,
  RunStatus,
  RunUsage,
  Runtime,
  RuntimeProbe,
  Task,
  TaskStatus,
  Workflow,
  WorkflowStage,
} from '../../protocol/entities'
import type { SnapshotImportedPayload } from '../../protocol/facts'
import type {
  FactDraft,
  Fact,
  Iso,
  KernelPort,
  ProjectionRow,
  ProjectionTable,
} from '../../kernel/types'
import { withTx } from '../schema'
import { currentProjectionFormat, writeProjectionMeta } from './projection'
import { appendFacts, factsCount, lastSeq } from './facts'
import { parseAgentEnv } from './agent-env'
import { createProjectionWriter } from './projection-apply'

/** 单条 `snapshot.imported` 事实承载的最大行数（SPEC：按表分批，每批 ≤500 行）。 */
export const IMPORT_BATCH_SIZE = 500

/** 导入根的事实作者：启动对账阶段的宿主。 */
export const IMPORT_ACTOR = { kind: 'host', via: 'reconcile' } as const

/**
 * 首次迁移的读表顺序 = FK 依赖顺序：
 * runtimes → agents → workflows → workflow_stages → tasks → runs → run_events。
 * 同表内部的行间引用（阶段自引用）交给延迟外键在 COMMIT 时校验；
 * `run_events` 在 `runs` 之后，`runs` 在它引用的四张表之后。
 */
export const IMPORT_ORDER = [
  'runtimes',
  'agents',
  'workflows',
  'workflow_stages',
  'tasks',
  'runs',
  'run_events',
  'conversations',
  'messages',
] as const

/** 可迁移的表（导入根 payload 的判别键子集；聊天两表在 T14b 迁入事实后删除旧表）。 */
export type ImportTable = (typeof IMPORT_ORDER)[number]

export interface ImportLegacyOptions {
  /** 导入事实的 `at`（同时是阶段行 / 事件行的 created_at 来源）；默认当前时刻。 */
  at?: Iso
}

export interface ImportLegacyResult {
  /** 本次是否真的写了事实（幂等 / 空库时为 false）。 */
  imported: boolean
  /** 本次导入的行数（未导入时为全 0）。 */
  counts: Record<ProjectionTable, number>
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
  agent_id: string | null
  on_complete_stage_id: string | null
  on_reject_stage_id: string | null
}

interface TaskRow {
  id: string
  title: string
  description: string
  workflow_id: string
  current_stage_id: string | null
  status: string
  created_at: string
  updated_at: string
}

/**
 * 旧 `runs` 行：只列 v2 就有的列。
 * M2 新增列（purpose / 调度列 / 规则列 / 上下文列）由 `toRunRow` 补默认值，
 * 所以这条 SELECT 在旧结构与新结构上都能跑。
 */
interface LegacyRunRow {
  id: string
  task_id: string
  stage_id: string | null
  agent_id: string | null
  runtime_id: string | null
  status: string
  prompt: string
  output: string
  error: string | null
  error_code: string | null
  exit_code: number | null
  session_id: string | null
  usage_json: string | null
  duration_ms: number | null
  started_at: string | null
  ended_at: string | null
  created_at: string
}

interface LegacyRunEventRow {
  run_id: string
  seq: number
  type: string
  payload_json: string
}

interface LegacyChatConversationRow {
  id: string
  title: string
  agent_id: string
  session_id: string | null
  created_at: string
  updated_at: string
}

interface LegacyChatMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  error: string | null
  created_at: string
}

interface LegacyRows {
  runtimes: Runtime[]
  agents: Agent[]
  workflows: Workflow[]
  workflow_stages: WorkflowStage[]
  tasks: Task[]
  runs: RunRow[]
  run_events: RunEventRow[]
  conversations: Conversation[]
  messages: Message[]
}

/**
 * 旧 `runs` 行 → `RunRow`：缺的 M2 列补固定默认值（任务口径见 T2）。
 * `status` / 提示词 / 输出 / 用量 / 时间戳保留原值；`attempt=1`（存量 run 至少被领取过一次）、
 * `queueSeq=0`（无稳定入队序，领取时按 notBefore + queueSeq 排在同一档次）。
 */
function toRunRow(row: LegacyRunRow): RunRow {
  return {
    id: row.id,
    purpose: 'stage',
    taskId: row.task_id,
    stageId: row.stage_id,
    agentId: row.agent_id,
    runtimeId: row.runtime_id,
    conversationId: null,
    ruleId: null,
    rulesVersion: 0,
    executorKey: '',
    threadId: null,
    cwd: '',
    access: 'edit',
    skill: null,
    promptRef: null,
    eventIds: [],
    hops: 0,
    turn: 1,
    resumeSessionId: null,
    threadContextRef: null,
    queueSeq: 0,
    status: row.status as RunStatus,
    prompt: row.prompt,
    output: row.output,
    error: row.error,
    errorCode: row.error_code === null ? null : (row.error_code as RunErrorCode),
    exitCode: row.exit_code,
    sessionId: row.session_id,
    usage: row.usage_json === null ? null : (JSON.parse(row.usage_json) as RunUsage),
    durationMs: row.duration_ms,
    leaseId: null,
    attempt: 1,
    attempts: 0,
    leaseUntil: null,
    notBefore: null,
    deadlineAt: null,
    cancelRequested: false,
    deliverables: null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  }
}

/** 旧事件行 → `RunEventRow`：payload 里的字段平铺回事件（与旧仓储的还原口径一致）。 */
function toRunEventRow(row: LegacyRunEventRow): RunEventRow {
  const payload = JSON.parse(row.payload_json) as Omit<RunEventRow, 'runId' | 'seq' | 'type'>
  return { runId: row.run_id, seq: row.seq, type: row.type as RunEventType, ...payload }
}

/** 实体五表读取：每张表逐列写死，列名变更必须在这里同步（与 `views.ts` / `projection-apply.ts` 对齐）。 */
function readLegacyEntityRows(
  db: DatabaseSync,
): Omit<LegacyRows, 'runs' | 'run_events' | 'conversations' | 'messages'> {
  const runtimes = (
    db
      .prepare(
        `SELECT id, name, executor_key, command, profile, args_template, enabled,
                last_probe_json, created_at
         FROM runtimes ORDER BY created_at, rowid`,
      )
      .all() as unknown as RuntimeRow[]
  ).map((row): Runtime => ({
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
  }))

  const agents = (
    db
      .prepare(
        `SELECT id, name, description, runtime_id, system_prompt, model, reasoning_effort,
                max_concurrent, permission_mode, workdir, env_json, created_at
         FROM agents ORDER BY created_at, rowid`,
      )
      .all() as unknown as AgentRow[]
  ).map((row): Agent => ({
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
  }))

  const workflows = (
    db
      .prepare('SELECT id, name, description, created_at FROM workflows ORDER BY created_at, rowid')
      .all() as unknown as WorkflowRow[]
  ).map((row): Workflow => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
  }))

  // M34：阶段表在 `openDatabase` 里已经按新形状重建过（旧列现算进出口表），这里直接读出口表
  const workflow_stages = (
    db
      .prepare(
        `SELECT id, workflow_id, name, position, entry_mode, agent_id, exits_json, judge_json
         FROM workflow_stages ORDER BY workflow_id, position`,
      )
      .all() as unknown as Array<
      StageRow & { exits_json: string | null; judge_json: string | null }
    >
  ).map((row): WorkflowStage => ({
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    position: row.position,
    entryMode: row.entry_mode as EntryMode,
    // M18：v2 存量没有内置阶段——四个内置阶段由启动补齐按名认领 / 补建。
    builtin: null,
    agentId: row.agent_id,
    exits: JSON.parse(String(row.exits_json ?? '{}')) as WorkflowStage['exits'],
    judge: JSON.parse(String(row.judge_json ?? 'null')) as WorkflowStage['judge'],
    // M29：v2 存量没有派单概念——清单为空。
    handoffs: [],
    // M9：v2 存量没有阶段说明——按空串归一（与投影层 `normalizeStage` 一致）。
    instructions: '',
    // M20：v2 存量没有验收条目——按空数组归一。
    acceptance: [],
    // M21：v2 存量没有阶段内轮次概念——按「不续轮」归一。
    maxRounds: null,
    // M26：v2 存量没有阶段超时概念——按「用全局缺省」归一。
    runTimeoutMs: null,
  }))

  const tasks = (
    db
      .prepare(
        `SELECT id, title, description, workflow_id, current_stage_id, status, created_at, updated_at
         FROM tasks ORDER BY created_at, rowid`,
      )
      .all() as unknown as TaskRow[]
  ).map((row): Task => ({
    id: row.id,
    title: row.title,
    description: row.description,
    workflowId: row.workflow_id,
    // M10：v2 存量没有项目概念——按「未归属」归一（与投影层 `normalizeTask` 一致）。
    projectId: null,
    currentStageId: row.current_stage_id,
    status: row.status as TaskStatus,
    // M6：v2 存量没有来源概念——导入后一律视为手工任务，规则列留空。
    origin: 'manual',
    ruleId: null,
    externalRef: null,
    labels: [],
    // M6.5：v2 存量没有线程概念——不属于任何线程、不是派生任务。
    threadId: null,
    parentTaskId: null,
    // M8：v2 存量没有 spawn 概念。
    spawnedByRunId: null,
    batchNo: null,
    spawnKey: null,
    // M7：v2 存量没有交接概念——来源任务与阶段一律为空。
    handoffFromTaskId: null,
    handoffFromStageId: null,
    handoffFromRunId: null,
    // M11：v2 存量没有闸门概念——预算按 0 归一（与投影层 `normalizeTask` 一致）。
    gateFails: 0,
    stageFails: 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  return { runtimes, agents, workflows, workflow_stages, tasks }
}

/** 旧 `runs` 读取（只读 v2 列；按 created_at, rowid 保持旧看板顺序）。 */
function readLegacyRunRows(db: DatabaseSync): RunRow[] {
  const rows = db
    .prepare(
      `SELECT id, task_id, stage_id, agent_id, runtime_id, status, prompt, output, error,
              error_code, exit_code, session_id, usage_json, duration_ms, started_at,
              ended_at, created_at
       FROM runs ORDER BY created_at, rowid`,
    )
    .all() as unknown as LegacyRunRow[]
  return rows.map(toRunRow)
}

/** 旧 `run_events` 读取：`(run_id, seq)` 原样保留，顺序即重建顺序。 */
function readLegacyRunEventRows(db: DatabaseSync): RunEventRow[] {
  const rows = db
    .prepare('SELECT run_id, seq, type, payload_json FROM run_events ORDER BY run_id, seq')
    .all() as unknown as LegacyRunEventRow[]
  return rows.map(toRunEventRow)
}

function readLegacyRows(db: DatabaseSync): LegacyRows {
  return {
    ...readLegacyEntityRows(db),
    runs: readLegacyRunRows(db),
    run_events: readLegacyRunEventRows(db),
    ...readLegacyChatRows(db),
  }
}

/** 旧聊天表是否存在（M2 之前的库有；新库/已清理的库没有）。 */
export function legacyChatTablesExist(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('chat_conversations','chat_messages')`,
    )
    .get() as unknown as { n: number }
  return row.n > 0
}

/**
 * 旧聊天两表 → 投影行（T14b）：`chat_conversations` / `chat_messages` 是 M2 前
 * 唯一真相源，迁成 `snapshot.imported` 事实根后由投影重建，旧表随后删除。
 * 表不存在（新库 / 已迁移）返回空数组；两表列不一致时按显式列清单读，不猜列。
 */
function readLegacyChatRows(db: DatabaseSync): {
  conversations: Conversation[]
  messages: Message[]
} {
  if (!legacyChatTablesExist(db)) return { conversations: [], messages: [] }

  const conversations = (
    db
      .prepare(
        `SELECT id, title, agent_id, session_id, created_at, updated_at
         FROM chat_conversations ORDER BY created_at, rowid`,
      )
      .all() as unknown as LegacyChatConversationRow[]
  ).map((row): Conversation => ({
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    // M11：旧聊天表没有项目概念——一律落默认目录
    projectId: null,
    sessionId: row.session_id,
    // M9：旧聊天表没有归档概念——一律未归档
    archivedAt: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  const messages = (
    db
      .prepare(
        `SELECT id, conversation_id, role, content, error, created_at
         FROM chat_messages ORDER BY created_at, rowid`,
      )
      .all() as unknown as LegacyChatMessageRow[]
  ).map((row): Message => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as ChatRole,
    content: row.content,
    error: row.error,
    createdAt: row.created_at,
  }))

  return { conversations, messages }
}

/** 删除旧聊天两表（数据已成事实根）：先子表后父表；不存在时 no-op。 */
function dropLegacyChatTables(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS chat_messages')
  db.exec('DROP TABLE IF EXISTS chat_conversations')
}

const emptyCounts = (): Record<ProjectionTable, number> => ({
  tasks: 0,
  workflows: 0,
  workflow_stages: 0,
  agents: 0,
  runtimes: 0,
  // M10：v2 没有项目数据，导入不产 projects 行。
  projects: 0,
  runs: 0,
  run_events: 0,
  conversations: 0,
  messages: 0,
  cards: 0,
  rule_sets: 0,
  rule_fires: 0,
  // M6.5：v2 没有线程数据，导入不产 threads 行；键必须补齐以匹配 `ProjectionTable` 全集。
  threads: 0,
  // M7：v2 没有插件设置；导入不产 plugin_settings 行。
  plugin_settings: 0,
  // M7.5：v2 没有任务上下文 / 反馈；导入不产 task_comments 行。
  task_comments: 0,
  // M14：v2 没有评审报告；导入不产 review_reports 行。
  review_reports: 0,
})

/** 一组行 + 表名 → `snapshot.imported` 草稿（payload 按表收窄成判别联合）。 */
function buildDraft(table: ImportTable, rows: readonly ProjectionRow[], at: Iso): FactDraft {
  const payload: SnapshotImportedPayload = (() => {
    switch (table) {
      case 'runtimes':
        return { table, rows: rows as Runtime[], importedFrom: 'v2' }
      case 'agents':
        return { table, rows: rows as Agent[], importedFrom: 'v2' }
      case 'workflows':
        return { table, rows: rows as Workflow[], importedFrom: 'v2' }
      case 'workflow_stages':
        return { table, rows: rows as WorkflowStage[], importedFrom: 'v2' }
      case 'tasks':
        return { table, rows: rows as Task[], importedFrom: 'v2' }
      case 'runs':
        return { table, rows: rows as RunRow[], importedFrom: 'v2' }
      case 'run_events':
        return { table, rows: rows as RunEventRow[], importedFrom: 'v2' }
      case 'conversations':
        return { table, rows: rows as Conversation[], importedFrom: 'v2' }
      case 'messages':
        return { table, rows: rows as Message[], importedFrom: 'v2' }
    }
  })()
  return { type: 'snapshot.imported', actor: IMPORT_ACTOR, at, payload }
}

/** 导入后逐表校验行数；不符就抛错，由外层事务整体回滚。 */
function verifyCounts(db: DatabaseSync, counts: Record<ProjectionTable, number>): void {
  for (const table of IMPORT_ORDER) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }
    if (row.n !== counts[table]) {
      throw new Error(
        `存量导入校验失败（${table}）：导入 ${counts[table]} 行，投影实际 ${row.n} 行`,
      )
    }
  }
}

/** 事实日志里是否已经有聊天历史（聊天事实或 conversations/messages 的导入根）——补迁移的跳过条件。 */
function hasChatHistory(db: DatabaseSync): boolean {
  const chatFact = db
    .prepare(
      "SELECT 1 AS hit FROM facts WHERE type IN ('conversation.created','conversation.updated','conversation.removed','message.appended') LIMIT 1",
    )
    .get()
  if (chatFact !== undefined) return true
  const roots = db
    .prepare("SELECT payload FROM facts WHERE type = 'snapshot.imported'")
    .all() as unknown as Array<{ payload: string }>
  return roots.some((root) => {
    const table = (JSON.parse(root.payload) as { table?: string }).table
    return table === 'conversations' || table === 'messages'
  })
}

/** 事实日志里是否已经有运行历史（运行事实或 runs/run_events 的导入根）——补迁移的跳过条件。 */
function hasRunHistory(db: DatabaseSync): boolean {
  const runFact = db.prepare("SELECT 1 AS hit FROM facts WHERE type LIKE 'run.%' LIMIT 1").get()
  if (runFact !== undefined) return true
  const roots = db
    .prepare("SELECT payload FROM facts WHERE type = 'snapshot.imported'")
    .all() as unknown as Array<{ payload: string }>
  return roots.some((root) => {
    const table = (JSON.parse(root.payload) as { table?: string }).table
    return table === 'runs' || table === 'run_events'
  })
}

/** 按表分批追加导入根；返回每表写入的行数（调用方决定是否落投影）。 */
function appendImportFacts(
  db: DatabaseSync,
  table: ImportTable,
  rows: readonly ProjectionRow[],
  at: Iso,
  onFact?: (fact: Fact, batch: readonly ProjectionRow[]) => void,
): number {
  for (let start = 0; start < rows.length; start += IMPORT_BATCH_SIZE) {
    const batch = rows.slice(start, start + IMPORT_BATCH_SIZE)
    const [fact] = appendFacts(db, [buildDraft(table, batch, at)])
    onFact?.(fact, batch)
  }
  return rows.length
}

/**
 * 首次迁移（`facts` 为空）：实体五表 + 运行两表 → 导入根 + 投影 + 元信息，单事务。
 */
function importEmptyLedger(
  db: DatabaseSync,
  kernel: KernelPort,
  options: ImportLegacyOptions,
): ImportLegacyResult {
  const legacy = readLegacyRows(db)
  const total = IMPORT_ORDER.reduce((sum, table) => sum + legacy[table].length, 0)
  if (total === 0) {
    // 旧聊天表可能存在但一行都没有：既然没有数据要保留，一并删掉完成清理
    dropLegacyChatTables(db)
    return { imported: false, counts: emptyCounts() }
  }

  const at = options.at ?? new Date().toISOString()
  const counts = emptyCounts()
  const writer = createProjectionWriter(db)
  const touchStageCreatedAt = db.prepare('UPDATE workflow_stages SET created_at = ? WHERE id = ?')

  withTx(db, () => {
    // 阶段自引用、跨批引用都要等 COMMIT 再校验（事务结束自动复位）。
    db.exec('PRAGMA defer_foreign_keys = ON')
    // 这次迁移之后投影完全由事实生成：先清空九表再按导入根回填。
    // `run_events` 是纯追加（重复 (run_id,seq) 撞主键），不清掉就无法与旧行共存；
    // 顺带让「首次迁移的结果」与「按事实重建的结果」是同一个 fold。
    writer.clear()

    for (const table of IMPORT_ORDER) {
      const rows = legacy[table]
      counts[table] = appendImportFacts(db, table, rows, at, (fact, batch) => {
        writer.applyAll(kernel.project(fact).map((change) => ({ change, at: fact.at })))
        if (table === 'workflow_stages') {
          // 阶段行的 created_at 不在行类型里：旧表已有值，导入后对齐成导入 at（与重建等价）。
          for (const row of batch as WorkflowStage[]) touchStageCreatedAt.run(fact.at, row.id)
        }
      })
    }

    verifyCounts(db, counts)
    // M4：v2 无卡片数据，`cards` 只能由 `card.*` 事实投影。首次迁移清表后它必须为空——
    // 旧库遗留行属于「导入前的投影残留」，按导入语义清掉，失败则整体回滚。
    const cards = db.prepare('SELECT COUNT(*) AS n FROM cards').get() as unknown as { n: number }
    if (cards.n !== 0) {
      throw new Error(`存量导入校验失败（cards）：v2 无卡片数据，导入后应为空，实际 ${cards.n} 行`)
    }
    writeProjectionMeta(db, currentProjectionFormat(), lastSeq(db))
  })
  // 旧聊天表的数据已成为导入根：删表完成 M2 清理（重建只依赖事实）
  dropLegacyChatTables(db)

  return { imported: true, counts }
}

/**
 * M2 升级补迁移（`facts` 非空）：补运行两表与聊天两表的事实根。
 *
 * 两条补迁移互相独立（M1 存量可能只有运行、也可能还有旧聊天数据）：
 * 各自按「事实里没有任何历史」判断后追加导入根，随后删掉旧聊天表。
 * 不落投影、不写元信息：调用方紧随其后的 `ensureProjection` 会按新指纹重建，
 * 重建与「导入时直接落投影」走同一条 `project` 路径，所以结果等价。
 */
function backfillRuntimeData(db: DatabaseSync, options: ImportLegacyOptions): ImportLegacyResult {
  const counts = emptyCounts()

  const runs = hasRunHistory(db) ? [] : readLegacyRunRows(db)
  const chat = hasChatHistory(db) ? { conversations: [], messages: [] } : readLegacyChatRows(db)
  if (runs.length === 0 && chat.conversations.length === 0 && chat.messages.length === 0) {
    // 没有需要补迁的行：旧聊天表（若存在）已是空表，直接删掉完成清理
    dropLegacyChatTables(db)
    return { imported: false, counts }
  }

  const at = options.at ?? new Date().toISOString()
  withTx(db, () => {
    db.exec('PRAGMA defer_foreign_keys = ON')
    if (runs.length > 0) {
      counts.runs = appendImportFacts(db, 'runs', runs, at)
      counts.run_events = appendImportFacts(db, 'run_events', readLegacyRunEventRows(db), at)
    }
    if (chat.conversations.length > 0) {
      counts.conversations = appendImportFacts(db, 'conversations', chat.conversations, at)
    }
    if (chat.messages.length > 0) {
      counts.messages = appendImportFacts(db, 'messages', chat.messages, at)
    }
  })
  dropLegacyChatTables(db)

  return { imported: true, counts }
}

/**
 * 需要时导入 v2 存量；幂等。
 *
 * - `facts` 为空 → 首次迁移：实体五表 + 运行两表 + 聊天两表，同一事务落投影并写元信息。
 * - `facts` 非空 → 只补运行 / 聊天两表的事实根（M1 存量）：没有对应历史时动作，
 *   完成后删除旧聊天表。这条路径**要求调用方随后调用 `ensureProjection()`**
 *   （启动顺序：导入 → 对账重建）。
 * - 没有可导入的行 → 不产事实、不写 `projection_meta`。
 *
 * @param db 已打开且建好 schema 的连接（`openDatabase`）
 * @param kernel 内核端口；首次迁移用到 `project`
 * @param options 导入时刻（事实 `at`，也是阶段行 / 事件行的 created_at）；默认当前时刻
 */
export function importLegacyIfNeeded(
  db: DatabaseSync,
  kernel: KernelPort,
  options: ImportLegacyOptions = {},
): ImportLegacyResult {
  if (factsCount(db) === 0) return importEmptyLedger(db, kernel, options)
  return backfillRuntimeData(db, options)
}
