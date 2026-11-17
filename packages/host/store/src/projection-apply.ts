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
import type { DatabaseSync } from 'node:sqlite'
import type { EventSkipRow } from '@workbench/protocol/rules'
import type {
  Agent,
  Conversation,
  Message,
  Project,
  RunRow,
  Runtime,
  ScriptStep,
  StageScript,
  Task,
  Workflow,
  WorkflowStage,
} from '@workbench/protocol/entities'
import type { Change, Iso, ProjectionRow, ProjectionTable } from '@workbench/kernel/core/types'
import type { RuleFireRow, RuleSetRow } from '@workbench/protocol/rules'
import type { PluginSettingsRow } from '@workbench/protocol/plugins'
import type { ThreadRow } from '@workbench/protocol/thread'
import type { Assessment, Mandate } from '@workbench/protocol/authority'
import type { TaskComment } from '@workbench/protocol/task-comment'
import type { ReviewReport } from '@workbench/protocol/review'
import { StoreError } from './errors'
import { TABLE_SHAPES, insertSql, valuesOf } from './columns'
import { legacyHandoffs } from '@workbench/kernel/scopes/workflow/stage-handoffs'
import { legacyExits, legacyJudge } from '@workbench/kernel/scopes/workflow/stage-machine'

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
 * 规整智能体行的执行配置：M27 之前的事实只有身份与系统提示词（执行配置放在运行时上），
 * 这里按「模型默认 / 可写 / 并发 1 / 无工作目录 / 无环境变量」归一，重建与增量同口径。
 */
const normalizeAgent = (agent: Agent): Agent => ({
  ...agent,
  model: agent.model ?? null,
  reasoningEffort: agent.reasoningEffort ?? null,
  maxConcurrent: agent.maxConcurrent ?? 1,
  permissionMode: agent.permissionMode ?? 'workspace-write',
  workdir: agent.workdir ?? null,
  env: agent.env ?? {},
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
  deliverables: run.deliverables ?? null,
  // M49：老事实没有证据列，按空数组归一（非闸门轮次也恒为空）
  checks: run.checks ?? [],
  // M40：老事实没有脚本快照，按「不是脚本轮」归一；M42 把老的 `args` 归一成一步
  script: normalizeScript(run.script),
  startedAt: run.startedAt ?? null,
  endedAt: run.endedAt ?? null,
  createdAt: run.createdAt,
})

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
    // M30：老行不知道来自哪一轮，按人工离开（null）归一
    handoffFromRunId: legacy.handoffFromRunId ?? null,
    // M11：闸门预算缺省 0（没失败过）
    gateFails: legacy.gateFails ?? 0,
  }
}

/** 规整阶段行的缺省值（M7 / M8 / M11 / M18 / M34）：缺交接 / 子任务 / 闸门 / 内置键时补 null。 */
const normalizeStage = (row: WorkflowStage): WorkflowStage => {
  const legacy = row as Partial<WorkflowStage>
  const judge = legacyJudge(legacy)
  return {
    ...row,
    builtin: legacy.builtin ?? null,
    handoffs: legacy.handoffs ?? legacyHandoffs(legacy),
    exits: legacyExits(legacy),
    judge,
    // M34：验收只属于闸门阶段——执行阶段的条目在投影边界一并作废（与 kernel 归一同步）
    acceptance: judge === null ? [] : (row.acceptance ?? []),
    subtaskStageId: legacy.subtaskStageId ?? null,
    onChildrenSettled: legacy.onChildrenSettled ?? null,
    spawnPolicy: legacy.spawnPolicy ?? null,
    // M40：老事实没有脚本配置，按「不是脚本阶段」归一；M42 把老的 `args` 归一成一步
    script: normalizeScript(legacy.script),
  }
}

/** 单步规整：`label` 缺省空串，`acceptance` 缺省「与验收无关」。 */
const normalizeStep = (step: ScriptStep): ScriptStep => ({
  label: step.label ?? '',
  args: step.args ?? [],
  ...(step.acceptance === undefined || step.acceptance === null
    ? {}
    : { acceptance: step.acceptance }),
})

/**
 * 规整脚本配置（M40 / M42）：老事实只有一条 `args`（一条命令），归一成「一步」；
 * `runAll` 缺省 true。步骤内部同样补齐，避免投影里出现半截形状。
 *
 * 用途与 `normalizeRun` / `normalizeStage` 一致：任何路径写入的行都能绑参，
 * 增量与重建折出同一行。`args` 这类已废弃键在这里脱落（不再有第二份真相源）。
 */
const normalizeScript = (script: StageScript | null | undefined): StageScript | null => {
  if (script === undefined || script === null) return null
  const legacy = script as StageScript & { args?: readonly string[] }
  const steps = legacy.steps ?? [{ label: '', args: legacy.args ?? [] }]
  return {
    runtimeId: legacy.runtimeId,
    steps: steps.map(normalizeStep),
    cwd: legacy.cwd ?? null,
    env: legacy.env ?? {},
    timeoutMs: legacy.timeoutMs ?? null,
    runAll: legacy.runAll ?? true,
  }
}

export function createProjectionWriter(db: DatabaseSync): ProjectionWriter {
  /**
   * 语句按表缓存：`INSERT` 的列清单、占位符与冲突分支都由列描述符（`./columns`）生成，
   * 加一列不需要改这里，也不需要同步第二份列清单。
   */
  const statements = new Map<ProjectionTable, ReturnType<DatabaseSync['prepare']>>()
  const statementOf = (table: ProjectionTable) => {
    const cached = statements.get(table)
    if (cached !== undefined) return cached
    const prepared = db.prepare(insertSql(TABLE_SHAPES[table]))
    statements.set(table, prepared)
    return prepared
  }

  /** 一行 → 一条 upsert；`at` 供 `'@at'` 列（阶段 / 运行事件的 created_at）使用。 */
  const writeRow = (table: ProjectionTable, row: object, at?: Iso): void => {
    statementOf(table).run(...valuesOf(TABLE_SHAPES[table], row, at))
  }

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
    mandates: db.prepare('DELETE FROM mandates WHERE id = ?'),
    assessments: db.prepare('DELETE FROM assessments WHERE id = ?'),
    mandatesByTask: db.prepare('DELETE FROM mandates WHERE task_id = ?'),
    threads: db.prepare('DELETE FROM threads WHERE id = ?'),
    plugin_settings: db.prepare('DELETE FROM plugin_settings WHERE id = ?'),
    /** 任务上下文没有删除事实：按 id 与按父任务联删（任务删除时）两条路径。 */
    task_comments: db.prepare('DELETE FROM task_comments WHERE id = ?'),
    taskCommentsByTask: db.prepare('DELETE FROM task_comments WHERE task_id = ?'),
    /** M14：评审报告没有单独的删除事实，随任务删除联删。 */
    review_reports: db.prepare('DELETE FROM review_reports WHERE id = ?'),
    reviewReportsByTask: db.prepare('DELETE FROM review_reports WHERE task_id = ?'),
    /** M42：事件与跳过行没有删除事实，语句只为满足 `ProjectionTable` 全集。 */
    events: db.prepare('DELETE FROM events WHERE id = ?'),
    event_skips: db.prepare('DELETE FROM event_skips WHERE id = ?'),
  }

  const clearAll = {
    mandates: db.prepare('DELETE FROM mandates'),
    assessments: db.prepare('DELETE FROM assessments'),
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
    review_reports: db.prepare('DELETE FROM review_reports'),
    events: db.prepare('DELETE FROM events'),
    event_skips: db.prepare('DELETE FROM event_skips'),
  }

  const stageOccupant = db.prepare(
    'SELECT id FROM workflow_stages WHERE workflow_id = ? AND position = ?',
  )
  const parkStage = db.prepare('UPDATE workflow_stages SET position = ? WHERE id = ?')
  const unparkStages = db.prepare(
    'UPDATE workflow_stages SET position = -position - 1 WHERE workflow_id = ? AND position < 0',
  )

  const writes: Record<ProjectionTable, (row: ProjectionRow, at: Iso) => void> = {
    tasks: (row) => writeRow('tasks', normalizeTask(row as Task)),
    projects: (row) => writeRow('projects', row as Project),
    workflows: (row) => writeRow('workflows', row as Workflow),
    // 阶段行没有 createdAt 字段：首次插入用事实时刻（描述符里的 `'@at'` 列）
    workflow_stages: (row, at) =>
      writeRow('workflow_stages', normalizeStage(row as WorkflowStage), at),
    agents: (row) => writeRow('agents', normalizeAgent(row as Agent)),
    runtimes: (row) => writeRow('runtimes', normalizeRuntime(row as LegacyRuntime)),
    runs: (row) => writeRow('runs', normalizeRun(row as RunRow)),
    run_events: (row, at) => writeRow('run_events', row, at),
    conversations: (row) => writeRow('conversations', row as Conversation),
    messages: (row) => writeRow('messages', row as Message),
    cards: (row) => writeRow('cards', row),
    rule_sets: (row) => writeRow('rule_sets', row as RuleSetRow),
    rule_fires: (row) => writeRow('rule_fires', row as RuleFireRow),
    plugin_settings: (row) => writeRow('plugin_settings', row as PluginSettingsRow),
    threads: (row) => writeRow('threads', row as ThreadRow),
    events: (row) => writeRow('events', row),
    event_skips: (row) => writeRow('event_skips', row as EventSkipRow),
    task_comments: (row) => writeRow('task_comments', row as TaskComment),
    review_reports: (row) => writeRow('review_reports', row as ReviewReport),
    mandates: (row) => writeRow('mandates', row as Mandate),
    assessments: (row) => writeRow('assessments', row as Assessment),
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
      if (change.table === 'tasks') {
        deletes.taskCommentsByTask.run(change.key)
        // M14：评审报告同样随任务删除联删（无独立删除事实）
        deletes.reviewReportsByTask.run(change.key)
        // A2：授权随任务删除联删（历史要跟着任务走，不留孤儿行）
        deletes.mandatesByTask.run(change.key)
      }
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
    clearAll.review_reports.run()
  }

  return { apply, applyAll, clear }
}
