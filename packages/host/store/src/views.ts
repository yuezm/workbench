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
import { nextRuleFires, previewEvent } from '@workbench/kernel/scopes/rules'
import type {
  AuthorityView,
  UsageAgentRow,
  UsageDailyRow,
  UsageTotals,
} from '@workbench/protocol/views'
import { compatAuthority } from '@workbench/protocol/authority'
import type { Mandate } from '@workbench/protocol/authority'
import type { EventRow, RuleSkip } from '@workbench/kernel/core/types'
import type {
  Agent,
  Card,
  CardChannelRef,
  Conversation,
  Message,
  Project,
  Run,
  RunEvent,
  RunRow,
  Runtime,
  RuntimeStatus,
  Task,
  Workflow,
  WorkflowStage,
  WorkflowWithStages,
} from '@workbench/protocol/entities'
import type { RuleSetRow, RuleSetView } from '@workbench/protocol/rules'
import type { PluginSettingsRow, PluginSettingsView } from '@workbench/protocol/plugins'
import type { ThreadRow } from '@workbench/protocol/thread'
import type { TaskComment } from '@workbench/protocol/task-comment'
import type { ReviewReport } from '@workbench/protocol/review'
import type {
  ActiveRun,
  RuntimeWorkload,
  StaleChatRun,
  ThreadDetail,
  ViewId,
  WaitingRun,
  WorkflowStageMetrics,
} from '@workbench/protocol/views'
import { VIEW_IDS } from '@workbench/protocol/views'
import type { Id, Iso, ProjectionTable, View } from '@workbench/kernel/core/types'
import { lastSeq } from './facts'

import { StoreError } from './errors'
import { TABLE_SHAPES, fromRow, runEventPayloadCodec, selectList } from './columns'

/**
 * 读路径的两个助手：**列清单**与**行映射**都来自列描述符（`./columns`）。
 *
 * 这里不再有第二份列清单，也不再由 `mapX` 各自兜缺省——历史行里 `'null'` / 空串这类
 * 归一由描述符的 codec 统一负责，写侧与读侧因此不可能再各写一套。
 */
const columnsOf = (table: ProjectionTable): string => selectList(TABLE_SHAPES[table])

/** 一行 → 契约对象；枚举收窄由调用点的 `T` 决定，运行时不做校验。 */
const rowOf = <T>(table: ProjectionTable, row: object): T => fromRow<T>(TABLE_SHAPES[table], row)

interface ActiveRunRow {
  id: string
  /** 聊天 run 不挂任务；阶段 run 才有 */
  task_id: string | null
  stage_id: string | null
  status: string
}

const mapWorkflow = (row: object): Workflow => rowOf<Workflow>('workflows', row)

const mapStage = (row: object): WorkflowStage => rowOf<WorkflowStage>('workflow_stages', row)

const mapAgent = (row: object): Agent => rowOf<Agent>('agents', row)

const mapRuntime = (row: object): Runtime => rowOf<Runtime>('runtimes', row)

const mapTask = (row: object): Task => rowOf<Task>('tasks', row)

/** `projects` 行 → `Project`：逐列直取（无 JSON 列）。 */
const mapProject = (row: object): Project => rowOf<Project>('projects', row)

/** `threads` 行 → `ThreadRow`：四个 JSON 列还原，其余逐列直取（`sessions` 不落行）。 */
const mapThread = (row: object): ThreadRow => rowOf<ThreadRow>('threads', row)

/** `task_comments` 行 → `TaskComment`：逐列直取（无 JSON 列）。 */
const mapTaskComment = (row: object): TaskComment => rowOf<TaskComment>('task_comments', row)

/** `runs` 行 → `RunRow`：JSON 列还原、布尔列从 0/1 还原，其余逐列直取。 */
const mapRun = (row: object): RunRow => rowOf<RunRow>('runs', row)

const mapConversation = (row: object): Conversation => rowOf<Conversation>('conversations', row)

const mapMessage = (row: object): Message => rowOf<Message>('messages', row)

/** `cards` 行 → `Card`：`options_json` 还原为 `string[]`，枚举列按契约收窄。 */
const mapCard = (row: object): Card => rowOf<Card>('cards', row)

/** `delivery_refs_json` → `Record<通道键, CardChannelRef>`：解析失败按空对象（投影不因坏值崩）。 */
export function readDeliveryRefs(raw: string | null | undefined): Record<string, CardChannelRef> {
  if (raw === undefined || raw === null || raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, CardChannelRef>
}

const readWorkflows = (db: DatabaseSync): Workflow[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('workflows')} FROM workflows ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapWorkflow)

/** 阶段按 (workflow_id, position) 排；调用方按 workflow 分组后顺序即稳定。 */
const readStages = (db: DatabaseSync): WorkflowStage[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('workflow_stages')} FROM workflow_stages ORDER BY workflow_id, position`,
      )
      .all() as unknown as object[]
  ).map(mapStage)

const readAgents = (db: DatabaseSync): Agent[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('agents')} FROM agents ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapAgent)

const readRuntimes = (db: DatabaseSync): Runtime[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('runtimes')} FROM runtimes ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapRuntime)

const readProjects = (db: DatabaseSync): Project[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('projects')} FROM projects ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapProject)

const readTasks = (db: DatabaseSync): Task[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('tasks')} FROM tasks ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapTask)

const readThreads = (db: DatabaseSync): ThreadRow[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('threads')} FROM threads ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapThread)

const readTaskComments = (db: DatabaseSync): TaskComment[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('task_comments')} FROM task_comments ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapTaskComment)

/** 某任务的上下文 / 反馈：按追加顺序（`createdAt` 升序，同毫秒按 rowid）。 */
const readTaskCommentsByTask = (db: DatabaseSync, taskId: string): TaskComment[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('task_comments')} FROM task_comments
         WHERE task_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as unknown as object[]
  ).map(mapTaskComment)

const readRuns = (db: DatabaseSync): RunRow[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('runs')} FROM runs ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapRun)

/**
 * 投影行 → IPC 运行行：调度列不外露（与 M1 的 `Run` 字段一致）。
 * `taskId` 由调用方传入（`runs.byTask` 的 SQL 已按 `task_id = ? AND purpose='stage'` 过滤）。
 */
const toRun = (row: object, taskId: string): Run => {
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
        `SELECT ${columnsOf('runs')} FROM runs
         WHERE task_id = ? AND purpose = 'stage'
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as unknown as object[]
  ).map((row) => toRun(row, taskId))

const readRunById = (db: DatabaseSync, runId: string): RunRow | null => {
  const row = db.prepare(`SELECT ${columnsOf('runs')} FROM runs WHERE id = ?`).get(runId)
  return row === undefined ? null : rowOf<RunRow>('runs', row)
}

/** 运行事件流：payload 的编解码与写侧共用同一个 codec（./columns）。 */
const readRunEvents = (db: DatabaseSync, runId: string): RunEvent[] => {
  const rows = db
    .prepare(`SELECT ${columnsOf('run_events')} FROM run_events WHERE run_id = ? ORDER BY seq`)
    .all(runId) as unknown as Array<Record<string, unknown>>
  return rows.map((row) => {
    const payload = runEventPayloadCodec.decode(row['payload_json']) as Omit<
      RunEvent,
      'seq' | 'type'
    >
    return { seq: Number(row['seq']), type: row['type'] as RunEvent['type'], ...payload }
  })
}

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

/** 会话清单按最近更新排序（与旧仓储 ORDER BY updated_at DESC 一致）。 */
const CONVERSATION_ORDER = 'ORDER BY updated_at DESC, created_at DESC, rowid'

const readConversations = (db: DatabaseSync): Conversation[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('conversations')} FROM conversations ${CONVERSATION_ORDER}`)
      .all() as unknown as object[]
  ).map(mapConversation)

/** 某项目下的会话（M11）：口径与 `tasks.byProject` 一致，排序同会话清单。 */
const readConversationsByProject = (db: DatabaseSync, projectId: string): Conversation[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('conversations')} FROM conversations
         WHERE project_id = ? ${CONVERSATION_ORDER}`,
      )
      .all(projectId) as unknown as object[]
  ).map(mapConversation)

/** 没有项目的会话（M11）：老事实 / 存量行都归入「默认目录」。 */
const readConversationsUnassigned = (db: DatabaseSync): Conversation[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('conversations')} FROM conversations
         WHERE project_id IS NULL ${CONVERSATION_ORDER}`,
      )
      .all() as unknown as object[]
  ).map(mapConversation)

/**
 * M47 话题：全部 `open` 线程，按最后活动倒序。
 *
 * 宿主用它找「这个会话当前属于哪个话题」（飞书入站没有结构证据时的活跃窗口），
 * 界面用它铺话题清单；已收口的话题不出现（要回看得进线程详情）。
 */
const readOpenThreads = (db: DatabaseSync): ThreadRow[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('threads')} FROM threads
         WHERE status = 'open'
         ORDER BY last_activity_at DESC, created_at DESC, rowid`,
      )
      .all() as unknown as object[]
  ).map(mapThread)

/** M47：某话题下的会话，排序同会话清单（最近更新在前）。 */
const readConversationsByThread = (db: DatabaseSync, threadId: string): Conversation[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('conversations')} FROM conversations
         WHERE thread_id = ? ${CONVERSATION_ORDER}`,
      )
      .all(threadId) as unknown as object[]
  ).map(mapConversation)

const readMessages = (db: DatabaseSync): Message[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('messages')} FROM messages ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapMessage)

const readCards = (db: DatabaseSync): Card[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('cards')} FROM cards ORDER BY created_at, rowid`)
      .all() as unknown as object[]
  ).map(mapCard)

/** 全部 open 卡（顶部待审批条）：只按状态过滤，按创建时间升序。 */
const readOpenCards = (db: DatabaseSync): Card[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('cards')} FROM cards
         WHERE status = 'open'
         ORDER BY created_at, rowid`,
      )
      .all() as unknown as object[]
  ).map(mapCard)

/** 某个 run 的卡片（含已答 / 已关闭，回答续接与审计用），按创建时间升序。 */
const readCardsByRun = (db: DatabaseSync, runId: string): Card[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('cards')} FROM cards
         WHERE run_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(runId) as unknown as object[]
  ).map(mapCard)

const readMessagesByConversation = (db: DatabaseSync, conversationId: string): Message[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('messages')} FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`,
      )
      .all(conversationId) as unknown as object[]
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
    .prepare(`SELECT ${columnsOf('rule_sets')} FROM rule_sets WHERE id = 'current'`)
    .get() as unknown as object | undefined
  if (row === undefined) return null
  return rowOf<RuleSetRow>('rule_sets', row)
}

/**
 * A1 `authority.current`：规则页渲染准入配置的唯一来源。
 *
 * 兼容模式（规则集没有 `authority` 块）报 `mode='compat'`，其余字段取
 * `compatAuthority()` 的缺省值，界面据此提示「准入未开启」；配置了就原样回显，
 * 不做二次归一（写入侧已经归一过，读侧再改会出现「存的和看的不一样」）。
 */
const readAuthorityView = (db: DatabaseSync): AuthorityView => {
  const ruleSet = readRuleSet(db)
  const policyVersion = ruleSet?.version ?? 0
  const authority = ruleSet?.authority ?? null
  if (authority === null) {
    const compat = compatAuthority()
    return {
      mode: 'compat',
      sources: compat.sources,
      assessorAgentId: compat.assessorAgentId,
      assessBatch: compat.assessBatch,
      assessWindowMs: compat.assessWindowMs,
      policyVersion,
    }
  }
  return { ...authority, policyVersion }
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
    .prepare(`SELECT ${columnsOf('plugin_settings')} FROM plugin_settings WHERE id = 'current'`)
    .get() as unknown as object | undefined
  if (row === undefined) return null
  return rowOf<PluginSettingsRow>('plugin_settings', row)
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
      .prepare(`SELECT ${columnsOf('review_reports')} FROM review_reports`)
      .all() as unknown as object[]
  ).map((row) => rowOf<ReviewReport>('review_reports', row))

/**
 * 按需装载的 `tasks` 切片（性能整改：装载 + decide 的 p99 瓶颈）。
 *
 * 视图里只有 `tasks` 会随数据量线性增长（生产是数万行），而绝大多数命令只按 id 取一两个
 * 任务。每次决策都把整表 `mapTask` 一遍（逐行 JSON.parse）是 40ms 量级的固定开销，真正
 * 的内核计算只有几毫秒——瓶颈在装载，不在决策。
 *
 * 这里把 `tasks` 做成惰性 Map，语义与「一次性装载整表」等价：
 * - `get` / `has` 命中缓存直接返回，否则按 id 单行查库并缓存；
 * - 任何全量遍历（`size` / `values` / `keys` / `entries` / `forEach` / 迭代器）才一次性装载整表。
 *
 * 视图在一次 `dispatch` 内同步用完（`loadView` → `decide` → 单事务写入），惰性读不会跨
 * 写事务，快照一致性（`view.seq`）不受影响；全量遍历看到的仍是同一份快照，只是把装载代价
 * 推迟到真正需要整表的那一刻（如 handoff / spawn 的 dedup 扫描、cron 规则的 externalRef 去重）。
 */
class LazyTaskMap extends Map<Id, Task> {
  readonly #db: DatabaseSync
  #loaded = false
  #byId: ReturnType<DatabaseSync['prepare']> | null = null

  constructor(db: DatabaseSync) {
    super()
    this.#db = db
  }

  #loadAll(): void {
    if (this.#loaded) return
    for (const task of readTasks(this.#db)) super.set(task.id, task)
    this.#loaded = true
  }

  #readOne(id: Id): Task | undefined {
    this.#byId ??= this.#db.prepare(`SELECT ${columnsOf('tasks')} FROM tasks WHERE id = ?`)
    const row = this.#byId.get(id) as unknown as object | undefined
    if (row === undefined) return undefined
    const task = mapTask(row)
    super.set(task.id, task)
    return task
  }

  override get(id: Id): Task | undefined {
    const cached = super.get(id)
    if (cached !== undefined || this.#loaded) return cached
    return this.#readOne(id)
  }

  override has(id: Id): boolean {
    if (super.has(id)) return true
    if (this.#loaded) return false
    return this.#readOne(id) !== undefined
  }

  override get size(): number {
    this.#loadAll()
    return super.size
  }

  override values() {
    this.#loadAll()
    return super.values()
  }

  override keys() {
    this.#loadAll()
    return super.keys()
  }

  override entries() {
    this.#loadAll()
    return super.entries()
  }

  override forEach(
    callbackfn: (value: Task, key: Id, map: Map<Id, Task>) => void,
    thisArg?: unknown,
  ): void {
    this.#loadAll()
    super.forEach(callbackfn, thisArg)
  }

  override [Symbol.iterator]() {
    this.#loadAll()
    return super[Symbol.iterator]()
  }
}

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
    tasks: slice.has('tasks') ? new LazyTaskMap(db) : new Map(),
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
    // A1：准入配置与规则集同一行；缺该块 = 兼容模式（不做准入判定）
    authority: ruleSet?.authority ?? null,
    ruleFiredAt: slice.has('rule_fires') ? readRuleFiredAt(db) : new Map(),
    // A2：授权按 taskId 索引（领活前重校验、人工停止撤销都读它）
    mandates: slice.has('mandates') ? readMandates(db) : new Map(),
    pluginSettings: pluginSettings?.settings ?? [],
    pluginSettingsVersion: pluginSettings?.version ?? 0,
  }
}

/** A2：授权行按 taskId 索引（一任务一行，最新一次授予；撤销覆盖同一行）。 */
const readMandates = (db: DatabaseSync): Map<Id, Mandate> => {
  const rows = db
    .prepare(`SELECT ${columnsOf('mandates')} FROM mandates ORDER BY granted_at, id`)
    .all() as unknown as Array<Record<string, unknown>>
  return new Map(
    rows.map((row) => {
      const mandate = rowOf<Mandate>('mandates', row)
      return [mandate.taskId, mandate] as const
    }),
  )
}

/** M42：事件投影行（补跑还原入参用）。 */
const readEvents = (db: DatabaseSync): EventRow[] =>
  (
    db
      .prepare(`SELECT ${columnsOf('events')} FROM events ORDER BY received_at, rowid`)
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
        `SELECT ${columnsOf('event_skips')} FROM event_skips WHERE replayed_at IS NULL ORDER BY skipped_at, rowid`,
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
      .prepare(
        `SELECT ${columnsOf('tasks')} FROM tasks WHERE workflow_id = ? ORDER BY created_at, rowid`,
      )
      .all(workflowId) as unknown as object[]
  ).map(mapTask)

/** 某项目下的任务（M10）：按创建顺序；看板再按工作流过滤，并按最近活动倒序铺开。 */
const readTasksByProject = (db: DatabaseSync, projectId: string): Task[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('tasks')} FROM tasks WHERE project_id = ? ORDER BY created_at, rowid`,
      )
      .all(projectId) as unknown as object[]
  ).map(mapTask)

/** 没有项目的任务（M10）：v2 存量与老规则建的任务，界面归入「未归属」。 */
const readTasksUnassigned = (db: DatabaseSync): Task[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('tasks')} FROM tasks WHERE project_id IS NULL ORDER BY created_at, rowid`,
      )
      .all() as unknown as object[]
  ).map(mapTask)

/** 某任务的直接子任务（M8）：按创建顺序；无子任务返回空数组。 */
const readTasksByParent = (db: DatabaseSync, parentTaskId: string): Task[] =>
  (
    db
      .prepare(
        `SELECT ${columnsOf('tasks')} FROM tasks WHERE parent_task_id = ? ORDER BY created_at, rowid`,
      )
      .all(parentTaskId) as unknown as object[]
  ).map(mapTask)

const readTask = (db: DatabaseSync, taskId: string): Task | null => {
  const row = db
    .prepare(`SELECT ${columnsOf('tasks')} FROM tasks WHERE id = ?`)
    .get(taskId) as unknown as object | undefined
  return row ? mapTask(row) : null
}

const readThread = (db: DatabaseSync, threadId: string): ThreadRow | null => {
  const row = db
    .prepare(`SELECT ${columnsOf('threads')} FROM threads WHERE id = ?`)
    .get(threadId) as unknown as object | undefined
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
        `SELECT ${columnsOf('tasks')} FROM tasks
         WHERE id IN (${placeholders})
         ORDER BY created_at, rowid`,
      )
      .all(...taskIds) as unknown as object[]
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
    case 'threads.open':
      // M47：话题清单（宿主找活跃话题、界面铺列表）
      return readOpenThreads(db)
    case 'conversations.byThread':
      // M47：话题下的会话（话题页把几段对话按时间拼起来）
      return readConversationsByThread(db, readStringParam(params, 'threadId'))
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
    case 'authority.current':
      // A1：规则页回显准入配置；没有该块时报 compat（其余字段给兼容缺省）
      return readAuthorityView(db)
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
