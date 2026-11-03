import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  AgentInput,
  ChatConversation,
  ChatMessage,
  ChatRole,
  Run,
  RunStatus,
  Runtime,
  RuntimeInput,
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
  kind: string
  command: string
  args_template: string
  prompt_mode: string
  workdir: string | null
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
  status: string
  prompt: string
  output: string
  error: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
}

interface ChatConversationRow {
  id: string
  title: string
  agent_id: string
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
  kind: r.kind as Runtime['kind'],
  command: r.command,
  args: JSON.parse(r.args_template) as string[],
  promptMode: r.prompt_mode as Runtime['promptMode'],
  workdir: r.workdir,
  createdAt: r.created_at,
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
  status: r.status as RunStatus,
  prompt: r.prompt,
  output: r.output,
  error: r.error,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  createdAt: r.created_at,
})
const mapChatConversation = (r: ChatConversationRow): ChatConversation => ({
  id: r.id,
  title: r.title,
  agentId: r.agent_id,
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
    if (!input.command?.trim()) throw new Error('运行时命令必填')
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO runtimes (id,name,kind,command,args_template,prompt_mode,workdir,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.name.trim(),
        input.kind ?? 'deepseek-harness',
        input.command.trim(),
        JSON.stringify(input.args ?? []),
        input.promptMode ?? 'arg',
        input.workdir ?? null,
        now(),
      )
    return this.runtimeGet(id)
  }
  runtimeUpdate(id: string, patch: Partial<RuntimeInput>): Runtime {
    const cur = this.runtimeGet(id)
    this.db
      .prepare(
        'UPDATE runtimes SET name=?, kind=?, command=?, args_template=?, prompt_mode=?, workdir=? WHERE id=?',
      )
      .run(
        patch.name?.trim() ?? cur.name,
        patch.kind ?? cur.kind,
        patch.command?.trim() ?? cur.command,
        JSON.stringify(patch.args ?? cur.args),
        patch.promptMode ?? cur.promptMode,
        patch.workdir !== undefined ? patch.workdir : cur.workdir,
        id,
      )
    return this.runtimeGet(id)
  }
  runtimeRemove(id: string): void {
    try {
      this.db.prepare('DELETE FROM runtimes WHERE id=?').run(id)
    } catch {
      throw new Error('运行时被智能体引用，无法删除: ' + id)
    }
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
  runCreate(input: {
    taskId: string
    stageId: string | null
    agentId: string | null
    prompt: string
    status: RunStatus
  }): Run {
    const id = randomUUID()
    this.db
      .prepare(
        "INSERT INTO runs (id,task_id,stage_id,agent_id,status,prompt,output,error,started_at,ended_at,created_at) VALUES (?,?,?,?,?,?,'',NULL,NULL,NULL,?)",
      )
      .run(id, input.taskId, input.stageId, input.agentId, input.status, input.prompt, now())
    return this.runGet(id)
  }
  runUpdate(
    id: string,
    patch: Partial<Pick<Run, 'status' | 'output' | 'error' | 'startedAt' | 'endedAt'>>,
  ): Run {
    const cur = this.runGet(id)
    this.db
      .prepare('UPDATE runs SET status=?, output=?, error=?, started_at=?, ended_at=? WHERE id=?')
      .run(
        patch.status ?? cur.status,
        patch.output ?? cur.output,
        patch.error !== undefined ? patch.error : cur.error,
        patch.startedAt !== undefined ? patch.startedAt : cur.startedAt,
        patch.endedAt !== undefined ? patch.endedAt : cur.endedAt,
        id,
      )
    return this.runGet(id)
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
        'INSERT INTO chat_conversations (id,title,agent_id,created_at,updated_at) VALUES (?,?,?,?,?)',
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
