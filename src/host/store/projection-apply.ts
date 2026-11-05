/**
 * 投影变更落库：`Change.row` ↔ 九张投影表的 snake_case 列，逐列显式映射
 * （不 `SELECT *`、不猜列名）。
 *
 * - 实体五表 / runs / conversations / messages 的整行：主键 `id`，`row === null` 删除。
 * - `run_events`：主键 `(run_id, seq)`，`Change.key = '<runId>:<seq>'`；**纯追加**，
 *   重复键直接撞唯一约束报错（禁止 `INSERT OR REPLACE` 覆盖历史）。
 *
 * 级联删除由父键显式完成（事实只携带父 id）：删除 `runs` 行先按 `run_id` 删 `run_events`；
 * 删除 `conversations` 行先按 `conversation_id` 删 `messages`。重建时同样走这条路径，
 * 所以「删任务 → `run.removed` → 重建」与旧 SQL 级联的可见结果一致（D13）。
 *
 * 运行类事实携带完整 `RunRow`（`kernel/project` 只回填 `queueSeq`）：这里整行 upsert；
 * `snapshot.imported` 的存量行可能缺 M2 新列，由 `normalizeRun` 补默认值。
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
  Conversation,
  Message,
  RunEventRow,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../protocol/entities'
import type { Change, Iso, ProjectionRow, ProjectionTable } from '../../kernel/types'
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
   * 清空白名单九表。
   *
   * 只能在 `PRAGMA foreign_keys = OFF` 的重建事务里调用：`runs.task_id` 是
   * `ON DELETE CASCADE`，外键开启时清 `tasks` 会连带删掉运行记录与 `run_events`。
   * 顺序按外键依赖倒序（run_events → runs → messages → conversations → tasks → …），
   * 外键关掉时只是让意图可读。
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
      `INSERT INTO tasks (id, title, description, workflow_id, current_stage_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         workflow_id = excluded.workflow_id,
         current_stage_id = excluded.current_stage_id,
         status = excluded.status,
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
         (id, workflow_id, name, position, entry_mode, agent_id, on_complete_stage_id, on_reject_stage_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workflow_id = excluded.workflow_id,
         name = excluded.name,
         position = excluded.position,
         entry_mode = excluded.entry_mode,
         agent_id = excluded.agent_id,
         on_complete_stage_id = excluded.on_complete_stage_id,
         on_reject_stage_id = excluded.on_reject_stage_id`,
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
      `INSERT INTO conversations (id, title, agent_id, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         agent_id = excluded.agent_id,
         session_id = excluded.session_id,
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
  }

  const runColumns = RUN_FIELDS.map(([, column]) => column).join(', ')
  const runPlaceholders = RUN_FIELDS.map(() => '?').join(', ')
  const runUpdates = RUN_FIELDS.map(([, column]) => `${column} = excluded.${column}`).join(', ')
  const insertRun = db.prepare(
    `INSERT INTO runs (id, ${runColumns}) VALUES (?, ${runPlaceholders})
     ON CONFLICT(id) DO UPDATE SET ${runUpdates}`,
  )

  /** 运行事件纯追加：重复 `(run_id, seq)` 撞主键报错，不覆盖。 */
  const insertRunEvent = db.prepare(
    `INSERT INTO run_events (run_id, seq, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )

  const deletes = {
    tasks: db.prepare('DELETE FROM tasks WHERE id = ?'),
    workflows: db.prepare('DELETE FROM workflows WHERE id = ?'),
    workflow_stages: db.prepare('DELETE FROM workflow_stages WHERE id = ?'),
    agents: db.prepare('DELETE FROM agents WHERE id = ?'),
    runtimes: db.prepare('DELETE FROM runtimes WHERE id = ?'),
    runs: db.prepare('DELETE FROM runs WHERE id = ?'),
    run_events: db.prepare('DELETE FROM run_events WHERE run_id = ?'),
    conversations: db.prepare('DELETE FROM conversations WHERE id = ?'),
    messages: db.prepare('DELETE FROM messages WHERE conversation_id = ?'),
  }

  const clearAll = {
    run_events: db.prepare('DELETE FROM run_events'),
    runs: db.prepare('DELETE FROM runs'),
    messages: db.prepare('DELETE FROM messages'),
    conversations: db.prepare('DELETE FROM conversations'),
    tasks: db.prepare('DELETE FROM tasks'),
    workflow_stages: db.prepare('DELETE FROM workflow_stages'),
    workflows: db.prepare('DELETE FROM workflows'),
    agents: db.prepare('DELETE FROM agents'),
    runtimes: db.prepare('DELETE FROM runtimes'),
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
      const task = row as Task
      upserts.tasks.run(
        task.id,
        task.title,
        task.description,
        task.workflowId,
        task.currentStageId,
        task.status,
        task.createdAt,
        task.updatedAt,
      )
    },
    workflows: (row) => {
      const workflow = row as Workflow
      upserts.workflows.run(workflow.id, workflow.name, workflow.description, workflow.createdAt)
    },
    workflow_stages: (row, at) => {
      const stage = row as WorkflowStage
      upserts.workflow_stages.run(
        stage.id,
        stage.workflowId,
        stage.name,
        stage.position,
        stage.entryMode,
        stage.agentId,
        stage.onCompleteStageId,
        stage.onRejectStageId,
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
        conversation.sessionId,
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
      // 级联删除由父键显式完成（事实只携带父 id）：run → run_events；conversation → messages。
      if (change.table === 'runs') deletes.run_events.run(change.key)
      if (change.table === 'conversations') deletes.messages.run(change.key)
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
    clearAll.runs.run()
    clearAll.messages.run()
    clearAll.conversations.run()
    clearAll.tasks.run()
    clearAll.workflow_stages.run()
    clearAll.workflows.run()
    clearAll.agents.run()
    clearAll.runtimes.run()
  }

  return { apply, applyAll, clear }
}
