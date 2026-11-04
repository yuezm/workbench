import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  ChatConversation,
  ChatMessage,
  ChatRole,
  PermissionMode,
  Run,
  RunEvent,
  RunStatus,
  RunUsage,
  Runtime,
  RuntimeProbe,
  RuntimeProtocolFamily,
} from '../../shared/ai-workflow-api'

interface RuntimeRow {
  id: string
  name: string
  protocol_family: string
  command: string
  profile: string
  permission_mode: string
  model: string | null
  reasoning_effort: string | null
  workdir: string | null
  max_concurrent: number
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
  created_at: string
}
interface RunRow {
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
interface RunEventRow {
  run_id: string
  seq: number
  type: string
  payload_json: string
}
interface ChatConversationRow {
  id: string
  title: string
  agent_id: string
  session_id: string | null
  created_at: string
  updated_at: string
}
interface ChatMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  error: string | null
  created_at: string
}

const now = (): string => new Date().toISOString()

const mapRuntime = (r: RuntimeRow): Runtime => ({
  id: r.id,
  name: r.name,
  protocolFamily: r.protocol_family as RuntimeProtocolFamily,
  command: r.command,
  profile: r.profile,
  permissionMode: r.permission_mode as PermissionMode,
  model: r.model,
  reasoningEffort: r.reasoning_effort,
  workdir: r.workdir,
  maxConcurrent: r.max_concurrent,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  lastProbe: r.last_probe_json ? (JSON.parse(r.last_probe_json) as RuntimeProbe) : null,
})
const mapAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  description: r.description,
  runtimeId: r.runtime_id,
  systemPrompt: r.system_prompt,
  createdAt: r.created_at,
})
const mapRun = (r: RunRow): Run => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  agentId: r.agent_id,
  runtimeId: r.runtime_id,
  status: r.status as RunStatus,
  prompt: r.prompt,
  output: r.output,
  error: r.error,
  errorCode: r.error_code as Run['errorCode'],
  exitCode: r.exit_code,
  sessionId: r.session_id,
  usage: r.usage_json ? (JSON.parse(r.usage_json) as RunUsage) : null,
  durationMs: r.duration_ms,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  createdAt: r.created_at,
})
const mapChatConversation = (r: ChatConversationRow): ChatConversation => ({
  id: r.id,
  title: r.title,
  agentId: r.agent_id,
  sessionId: r.session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})
const mapChatMessage = (r: ChatMessageRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role as ChatRole,
  content: r.content,
  error: r.error,
  createdAt: r.created_at,
})

/**
 * 数据访问层：只保留**运行侧**与聊天（M1 投影集之外、仍直接读写）的 SQL。
 *
 * 五张投影表（tasks / workflows / workflow_stages / agents / runtimes）的写路径已收口到
 * `host/store`：这里不再有它们的 INSERT/UPDATE/DELETE，也不再承载配置/任务的 CRUD。
 * 仅 `runtimeGet` / `agentGet` 因 runner / chat 现读执行配置而临时保留，T8 收尾时随
 * 调用方切到 `store.query` 一并删除。
 */
export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  // ---------- 执行配置只读（runner / chat 过渡期使用） ----------
  runtimeGet(id: string): Runtime {
    const row = this.db.prepare('SELECT * FROM runtimes WHERE id=?').get(id) as unknown as
      RuntimeRow | undefined
    if (!row) throw new Error('运行时不存在: ' + id)
    return mapRuntime(row)
  }
  agentGet(id: string): Agent {
    const row = this.db.prepare('SELECT * FROM agents WHERE id=?').get(id) as unknown as
      AgentRow | undefined
    if (!row) throw new Error('智能体不存在: ' + id)
    return mapAgent(row)
  }
  /** 各运行时的在跑/排队数（只统计 active run） */
  runtimeWorkloads(): Array<{ runtimeId: string; running: number; queued: number }> {
    const rows = this.db
      .prepare(
        `SELECT runtime_id, status, COUNT(*) AS n FROM runs
         WHERE runtime_id IS NOT NULL AND status IN ('queued','running')
         GROUP BY runtime_id, status`,
      )
      .all() as unknown as Array<{ runtime_id: string; status: string; n: number }>
    const byId = new Map<string, { runtimeId: string; running: number; queued: number }>()
    for (const row of rows) {
      const entry = byId.get(row.runtime_id) ?? { runtimeId: row.runtime_id, running: 0, queued: 0 }
      if (row.status === 'running') entry.running = row.n
      else entry.queued = row.n
      byId.set(row.runtime_id, entry)
    }
    return [...byId.values()]
  }

  // ---------- runs ----------
  runGet(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as
      RunRow | undefined
    if (!row) throw new Error('运行记录不存在: ' + id)
    return mapRun(row)
  }
  runsListByTask(taskId: string): Run[] {
    return (
      this.db
        .prepare('SELECT * FROM runs WHERE task_id=? ORDER BY created_at')
        .all(taskId) as unknown as RunRow[]
    ).map(mapRun)
  }
  runsListByStatus(status: RunStatus): Run[] {
    return (
      this.db
        .prepare('SELECT * FROM runs WHERE status=? ORDER BY created_at')
        .all(status) as unknown as RunRow[]
    ).map(mapRun)
  }
  /** 该任务是否有排队/执行中的 run（判断「执行中」用，而不是阶段配置） */
  activeRunForTask(taskId: string): Run | null {
    // created_at 只有毫秒精度：同毫秒时用 rowid 兜底，保证「最新一条」稳定
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(taskId) as unknown as RunRow | undefined
    return row ? mapRun(row) : null
  }
  runCreate(input: {
    taskId: string
    stageId: string | null
    agentId: string | null
    runtimeId: string | null
    prompt: string
    status: RunStatus
  }): Run {
    const id = randomUUID()
    this.db
      .prepare(
        "INSERT INTO runs (id,task_id,stage_id,agent_id,runtime_id,status,prompt,output,error,error_code,exit_code,session_id,usage_json,duration_ms,started_at,ended_at,created_at) VALUES (?,?,?,?,?,?,?,'',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)",
      )
      .run(
        id,
        input.taskId,
        input.stageId,
        input.agentId,
        input.runtimeId,
        input.status,
        input.prompt,
        now(),
      )
    return this.runGet(id)
  }
  runUpdate(
    id: string,
    patch: Partial<
      Pick<
        Run,
        | 'status'
        | 'output'
        | 'error'
        | 'errorCode'
        | 'exitCode'
        | 'sessionId'
        | 'usage'
        | 'durationMs'
        | 'startedAt'
        | 'endedAt'
      >
    >,
  ): Run {
    const cur = this.runGet(id)
    this.db
      .prepare(
        `UPDATE runs SET status=?, output=?, error=?, error_code=?, exit_code=?,
          session_id=?, usage_json=?, duration_ms=?, started_at=?, ended_at=? WHERE id=?`,
      )
      .run(
        patch.status ?? cur.status,
        patch.output ?? cur.output,
        patch.error !== undefined ? patch.error : cur.error,
        patch.errorCode !== undefined ? patch.errorCode : cur.errorCode,
        patch.exitCode !== undefined ? patch.exitCode : cur.exitCode,
        patch.sessionId !== undefined ? patch.sessionId : cur.sessionId,
        patch.usage !== undefined
          ? patch.usage === null
            ? null
            : JSON.stringify(patch.usage)
          : cur.usage
            ? JSON.stringify(cur.usage)
            : null,
        patch.durationMs !== undefined ? patch.durationMs : cur.durationMs,
        patch.startedAt !== undefined ? patch.startedAt : cur.startedAt,
        patch.endedAt !== undefined ? patch.endedAt : cur.endedAt,
        id,
      )
    return this.runGet(id)
  }
  /** 追加运行事件（按 seq 幂等覆盖，便于重放） */
  runEventsAppend(runId: string, events: RunEvent[]): void {
    if (events.length === 0) return
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO run_events (run_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,?)',
    )
    const ts = now()
    for (const event of events) {
      const payload: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(event)) {
        if (key === 'seq' || key === 'type' || value === undefined) continue
        payload[key] = value
      }
      ins.run(runId, event.seq, event.type, JSON.stringify(payload), ts)
    }
  }
  runEventsList(runId: string): RunEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id=? ORDER BY seq')
      .all(runId) as unknown as RunEventRow[]
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as Omit<RunEvent, 'seq' | 'type'>
      return { seq: row.seq, type: row.type as RunEvent['type'], ...payload }
    })
  }

  // ---------- 对话 ----------
  chatConversationsList(): ChatConversation[] {
    return (
      this.db
        .prepare('SELECT * FROM chat_conversations ORDER BY updated_at DESC, created_at DESC')
        .all() as unknown as ChatConversationRow[]
    ).map(mapChatConversation)
  }
  chatConversationGet(id: string): ChatConversation {
    const row = this.db
      .prepare('SELECT * FROM chat_conversations WHERE id=?')
      .get(id) as unknown as ChatConversationRow | undefined
    if (!row) throw new Error('对话不存在: ' + id)
    return mapChatConversation(row)
  }
  chatConversationCreate(agentId: string): ChatConversation {
    // 先确认智能体存在：外键报错不便于定位，这里给出可读文案
    this.agentGet(agentId)
    const id = randomUUID()
    const ts = now()
    this.db
      .prepare(
        'INSERT INTO chat_conversations (id,title,agent_id,session_id,created_at,updated_at) VALUES (?,?,?,NULL,?,?)',
      )
      .run(id, '新对话', agentId, ts, ts)
    return this.chatConversationGet(id)
  }
  chatConversationRemove(id: string): void {
    // 消息由外键 ON DELETE CASCADE 一并删除
    this.db.prepare('DELETE FROM chat_conversations WHERE id=?').run(id)
  }
  chatConversationRename(id: string, title: string): void {
    this.db
      .prepare('UPDATE chat_conversations SET title=?, updated_at=? WHERE id=?')
      .run(title, now(), id)
  }
  chatConversationTouch(id: string): void {
    this.db.prepare('UPDATE chat_conversations SET updated_at=? WHERE id=?').run(now(), id)
  }
  /** 记录（或清空）续接用的协议会话 id */
  chatConversationSetSession(id: string, sessionId: string | null): void {
    this.db.prepare('UPDATE chat_conversations SET session_id=? WHERE id=?').run(sessionId, id)
  }
  chatMessagesList(conversationId: string): ChatMessage[] {
    // created_at 只有毫秒精度：同毫秒时用 rowid 兜底，保证轮次顺序稳定
    return (
      this.db
        .prepare('SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY created_at, rowid')
        .all(conversationId) as unknown as ChatMessageRow[]
    ).map(mapChatMessage)
  }
  chatMessageCreate(input: {
    conversationId: string
    role: ChatRole
    content: string
    error?: string | null
  }): ChatMessage {
    const id = randomUUID()
    const error = input.error ?? null
    const createdAt = now()
    // 对话不存在时外键直接报错，不留下孤立消息
    this.db
      .prepare(
        'INSERT INTO chat_messages (id,conversation_id,role,content,error,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, input.conversationId, input.role, input.content, error, createdAt)
    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      error,
      createdAt,
    }
  }
}
