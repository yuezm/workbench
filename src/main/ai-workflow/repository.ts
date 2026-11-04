import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  AgentInput,
  ChatConversation,
  ChatMessage,
  ChatRole,
  PermissionMode,
  Run,
  RunEvent,
  RunStatus,
  RunUsage,
  Runtime,
  RuntimeInput,
  RuntimeProbe,
  RuntimeProtocolFamily,
  StageInput,
  Task,
  TaskInput,
  TaskStatus,
  Workflow,
  WorkflowInput,
  WorkflowStage,
  WorkflowWithStages,
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

const PROTOCOL_FAMILIES: readonly RuntimeProtocolFamily[] = ['dsh']
const PERMISSION_MODES: readonly PermissionMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/** 并发上限归一：至少 1，最多 8（本地单机没必要更多） */
function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isInteger(value) || value < 1) throw new Error('并发上限必须是正整数')
  return Math.min(value, 8)
}

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
const mapStage = (r: StageRow): WorkflowStage => ({
  id: r.id,
  workflowId: r.workflow_id,
  name: r.name,
  position: r.position,
  entryMode: r.entry_mode as WorkflowStage['entryMode'],
  agentId: r.agent_id,
  onCompleteStageId: r.on_complete_stage_id,
  onRejectStageId: r.on_reject_stage_id,
})
const mapTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  description: r.description,
  workflowId: r.workflow_id,
  currentStageId: r.current_stage_id,
  status: r.status as TaskStatus,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
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

/** 数据访问层：纯 SQL，不含业务规则。 */
export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------- runtimes ----------
  runtimesList(): Runtime[] {
    return (
      this.db.prepare('SELECT * FROM runtimes ORDER BY created_at').all() as unknown as RuntimeRow[]
    ).map(mapRuntime)
  }
  runtimeGet(id: string): Runtime {
    const row = this.db.prepare('SELECT * FROM runtimes WHERE id=?').get(id) as unknown as
      RuntimeRow | undefined
    if (!row) throw new Error('运行时不存在: ' + id)
    return mapRuntime(row)
  }
  runtimeCreate(input: RuntimeInput): Runtime {
    if (!input.name?.trim()) throw new Error('运行时名称必填')
    const protocolFamily = input.protocolFamily ?? 'dsh'
    if (!PROTOCOL_FAMILIES.includes(protocolFamily))
      throw new Error('不支持的协议族: ' + protocolFamily)
    const permissionMode = input.permissionMode ?? 'workspace-write'
    if (!PERMISSION_MODES.includes(permissionMode))
      throw new Error('不支持的权限模式: ' + permissionMode)
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO runtimes
          (id,name,protocol_family,command,profile,permission_mode,model,reasoning_effort,
           workdir,max_concurrent,enabled,last_probe_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        id,
        input.name.trim(),
        protocolFamily,
        input.command?.trim() || 'dsh',
        input.profile?.trim() || 'multica',
        permissionMode,
        input.model ?? null,
        input.reasoningEffort ?? null,
        input.workdir ?? null,
        normalizeConcurrency(input.maxConcurrent),
        input.enabled === false ? 0 : 1,
        now(),
      )
    return this.runtimeGet(id)
  }
  runtimeUpdate(id: string, patch: Partial<RuntimeInput>): Runtime {
    const cur = this.runtimeGet(id)
    if (patch.protocolFamily !== undefined && !PROTOCOL_FAMILIES.includes(patch.protocolFamily))
      throw new Error('不支持的协议族: ' + patch.protocolFamily)
    if (patch.permissionMode !== undefined && !PERMISSION_MODES.includes(patch.permissionMode))
      throw new Error('不支持的权限模式: ' + patch.permissionMode)
    this.db
      .prepare(
        `UPDATE runtimes SET
          name=?, protocol_family=?, command=?, profile=?, permission_mode=?,
          model=?, reasoning_effort=?, workdir=?, max_concurrent=?, enabled=?
         WHERE id=?`,
      )
      .run(
        patch.name?.trim() || cur.name,
        patch.protocolFamily ?? cur.protocolFamily,
        patch.command?.trim() || cur.command,
        patch.profile?.trim() || cur.profile,
        patch.permissionMode ?? cur.permissionMode,
        patch.model !== undefined ? patch.model : cur.model,
        patch.reasoningEffort !== undefined ? patch.reasoningEffort : cur.reasoningEffort,
        patch.workdir !== undefined ? patch.workdir : cur.workdir,
        patch.maxConcurrent !== undefined
          ? normalizeConcurrency(patch.maxConcurrent)
          : cur.maxConcurrent,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled ? 1 : 0,
        id,
      )
    return this.runtimeGet(id)
  }
  /** 写入最近一次探测结论（探测结果同时是 UI 的健康状态来源） */
  runtimeSetProbe(id: string, probe: RuntimeProbe): Runtime {
    this.runtimeGet(id)
    this.db
      .prepare('UPDATE runtimes SET last_probe_json=? WHERE id=?')
      .run(JSON.stringify(probe), id)
    return this.runtimeGet(id)
  }
  runtimeRemove(id: string): void {
    try {
      this.db.prepare('DELETE FROM runtimes WHERE id=?').run(id)
    } catch {
      throw new Error('运行时被智能体引用，无法删除: ' + id)
    }
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

  // ---------- agents ----------
  agentsList(): Agent[] {
    return (
      this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as unknown as AgentRow[]
    ).map(mapAgent)
  }
  agentGet(id: string): Agent {
    const row = this.db.prepare('SELECT * FROM agents WHERE id=?').get(id) as unknown as
      AgentRow | undefined
    if (!row) throw new Error('智能体不存在: ' + id)
    return mapAgent(row)
  }
  agentCreate(input: AgentInput): Agent {
    if (!input.name?.trim()) throw new Error('智能体名称必填')
    this.runtimeGet(input.runtimeId)
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO agents (id,name,description,runtime_id,system_prompt,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        id,
        input.name.trim(),
        input.description ?? '',
        input.runtimeId,
        input.systemPrompt ?? '',
        now(),
      )
    return this.agentGet(id)
  }
  agentUpdate(id: string, patch: Partial<AgentInput>): Agent {
    const cur = this.agentGet(id)
    if (patch.runtimeId) this.runtimeGet(patch.runtimeId)
    this.db
      .prepare('UPDATE agents SET name=?, description=?, runtime_id=?, system_prompt=? WHERE id=?')
      .run(
        patch.name?.trim() ?? cur.name,
        patch.description ?? cur.description,
        patch.runtimeId ?? cur.runtimeId,
        patch.systemPrompt ?? cur.systemPrompt,
        id,
      )
    return this.agentGet(id)
  }
  agentRemove(id: string): void {
    try {
      this.db.prepare('DELETE FROM agents WHERE id=?').run(id)
    } catch {
      throw new Error('智能体被工作流阶段或对话引用，无法删除: ' + id)
    }
  }

  // ---------- workflows / stages ----------
  private stagesOf(workflowId: string): WorkflowStage[] {
    return (
      this.db
        .prepare('SELECT * FROM workflow_stages WHERE workflow_id=? ORDER BY position')
        .all(workflowId) as unknown as StageRow[]
    ).map(mapStage)
  }
  workflowGet(id: string): WorkflowWithStages {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id=?').get(id) as unknown as
      WorkflowRow | undefined
    if (!row) throw new Error('工作流不存在: ' + id)
    const wf: Workflow = {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
    }
    return { ...wf, stages: this.stagesOf(id) }
  }
  workflowsList(): WorkflowWithStages[] {
    const rows = this.db
      .prepare('SELECT id FROM workflows ORDER BY created_at')
      .all() as unknown as Array<{
      id: string
    }>
    return rows.map((r) => this.workflowGet(r.id))
  }
  private validateStages(stages: StageInput[]): void {
    if (!stages.length) throw new Error('工作流至少需要一个阶段')
    const n = stages.length
    stages.forEach((s, i) => {
      if (!s.name?.trim()) throw new Error(`第 ${i + 1} 个阶段名称必填`)
      if (s.entryMode === 'agent' && !s.agentId)
        throw new Error(`阶段「${s.name}」设为交给智能体时必须选择智能体`)
      for (const [label, idx] of [
        ['完成后进入', s.onCompleteIndex],
        ['打回时退回到', s.onRejectIndex],
      ] as const) {
        if (idx === null || idx === undefined) continue
        if (!Number.isInteger(idx) || idx < 0 || idx >= n)
          throw new Error(`阶段「${s.name}」的${label}目标越界`)
        if (idx === i) throw new Error(`阶段「${s.name}」的${label}不能指向自己`)
      }
    })
  }
  private insertStages(workflowId: string, stages: StageInput[]): void {
    const ids = stages.map(() => randomUUID())
    const ins = this.db.prepare(
      'INSERT INTO workflow_stages (id,workflow_id,name,position,entry_mode,agent_id,on_complete_stage_id,on_reject_stage_id,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?)',
    )
    const upd = this.db.prepare(
      'UPDATE workflow_stages SET on_complete_stage_id=?, on_reject_stage_id=? WHERE id=?',
    )
    const ts = now()
    stages.forEach((s, i) => {
      ins.run(ids[i], workflowId, s.name.trim(), i, s.entryMode, s.agentId ?? null, ts)
    })
    stages.forEach((s, i) => {
      const oc = s.onCompleteIndex ?? null
      const orj = s.onRejectIndex ?? null
      upd.run(oc === null ? null : ids[oc], orj === null ? null : ids[orj], ids[i])
    })
  }
  workflowCreate(input: WorkflowInput): WorkflowWithStages {
    if (!input.name?.trim()) throw new Error('工作流名称必填')
    this.validateStages(input.stages)
    const id = randomUUID()
    this.tx(() => {
      this.db
        .prepare('INSERT INTO workflows (id,name,description,created_at) VALUES (?,?,?,?)')
        .run(id, input.name.trim(), input.description ?? '', now())
      this.insertStages(id, input.stages)
    })
    return this.workflowGet(id)
  }
  workflowUpdate(id: string, input: WorkflowInput): WorkflowWithStages {
    if (!input.name?.trim()) throw new Error('工作流名称必填')
    this.validateStages(input.stages)
    this.workflowGet(id)
    this.tx(() => {
      this.db
        .prepare('UPDATE workflows SET name=?, description=? WHERE id=?')
        .run(input.name.trim(), input.description ?? '', id)
      // 记录任务当前阶段的位置，重建阶段后按位置回挂，避免任务丢阶段
      const tasks = this.db
        .prepare('SELECT id, current_stage_id FROM tasks WHERE workflow_id=?')
        .all(id) as unknown as Array<{ id: string; current_stage_id: string | null }>
      const posRows = this.db
        .prepare('SELECT id, position FROM workflow_stages WHERE workflow_id=?')
        .all(id) as unknown as Array<{ id: string; position: number }>
      const posOf = new Map(posRows.map((r) => [r.id, r.position]))
      this.db.prepare('DELETE FROM workflow_stages WHERE workflow_id=?').run(id)
      this.insertStages(id, input.stages)
      const newStages = this.stagesOf(id)
      for (const t of tasks) {
        const oldPos = t.current_stage_id ? posOf.get(t.current_stage_id) : undefined
        if (oldPos === undefined) continue
        const target = newStages[Math.min(oldPos, newStages.length - 1)]
        this.db
          .prepare('UPDATE tasks SET current_stage_id=? WHERE id=?')
          .run(target?.id ?? null, t.id)
      }
    })
    return this.workflowGet(id)
  }
  workflowRemove(id: string): void {
    this.db.prepare('DELETE FROM workflows WHERE id=?').run(id)
  }

  // ---------- tasks ----------
  taskGet(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as
      TaskRow | undefined
    if (!row) throw new Error('任务不存在: ' + id)
    return mapTask(row)
  }
  tasksList(workflowId: string): Task[] {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE workflow_id=? ORDER BY created_at')
        .all(workflowId) as unknown as TaskRow[]
    ).map(mapTask)
  }
  taskCreate(input: TaskInput): Task {
    if (!input.title?.trim()) throw new Error('任务标题必填')
    const wf = this.workflowGet(input.workflowId)
    const stageId = input.stageId || wf.stages[0]?.id || null
    if (stageId && !wf.stages.some((s) => s.id === stageId))
      throw new Error('起始阶段不属于该工作流: ' + stageId)
    const id = randomUUID()
    const ts = now()
    this.db
      .prepare(
        'INSERT INTO tasks (id,title,description,workflow_id,current_stage_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.title.trim(),
        input.description ?? '',
        input.workflowId,
        stageId,
        'active',
        ts,
        ts,
      )
    return this.taskGet(id)
  }
  taskUpdate(
    id: string,
    patch: Partial<Pick<Task, 'title' | 'description' | 'currentStageId' | 'status'>>,
  ): Task {
    const cur = this.taskGet(id)
    this.db
      .prepare(
        'UPDATE tasks SET title=?, description=?, current_stage_id=?, status=?, updated_at=? WHERE id=?',
      )
      .run(
        patch.title?.trim() ?? cur.title,
        patch.description ?? cur.description,
        patch.currentStageId !== undefined ? patch.currentStageId : cur.currentStageId,
        patch.status ?? cur.status,
        now(),
        id,
      )
    return this.taskGet(id)
  }
  taskRemove(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(id)
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
