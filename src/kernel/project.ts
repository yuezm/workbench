/**
 * 事实 → 投影变更（实体五表 + runs / run_events / conversations / messages / cards）。
 *
 * 纯函数、无 IO。实体类事实一行映射一行（payload 行即完整行，删除类事实的行是
 * tombstone，投影写 `row: null`）；`snapshot.imported` 是批量例外，按 `payload.table`
 * 批量 upsert。M4 的 `card.*` 同样是整行 upsert；`event.received` / `event.dropped`
 * 只入账不投影，因此返回空变更。
 *
 * 运行类事实与实体事实同口径：**每条状态事实携带完整的 `run: RunRow`**，`project`
 * 只做「事实 → 行」的搬运（`run.queued` 额外用事实的 `seq` 回填 `queueSeq`，供领取 FIFO
 * 的稳定序号）。这样重建只靠事实、不需要回查数据库。
 *
 * `run_events` 是纯追加：`Change.key = '<runId>:<seq>'`，冲突即报错（禁止覆盖历史）。
 * 级联删除由宿主按父键完成：`run.removed` 只产 `runs` 删除，`projection-apply` 删行时
 * 按 `run_id` 联删 `run_events`；`conversation.removed` 同理联删 `messages`；任务删除联删
 * `task_comments`（M7.5）。
 *
 * 实时写入与重建共用这一条路径，所以同一事实序列按 seq fold 两次结果必然相同。
 */
import type { FactType, SnapshotImportedPayload } from '../protocol/facts'
import type { Task, Card, WorkflowStage } from '../protocol/entities'
import type { Change, Fact, Id, ProjectionRow, ProjectionTable } from './types'

/**
 * `Fact` 的默认泛型是单对象类型，`switch (fact.type)` 无法收窄 payload；
 * 展开成按事实名分发的判别联合后，每个分支都能拿到精确 payload。
 */
type AnyFact = { [K in FactType]: Fact<K> }[FactType]

/** 整行 upsert（主键即 `row.id`）。 */
const put = (table: ProjectionTable, row: ProjectionRow & { id: Id }): Change => ({
  table,
  key: row.id,
  row,
})

/** 显式指定投影键的 upsert（`run_events` 的主键是 `(runId, seq)`，行里没有 `id`）。 */
const putKeyed = (table: ProjectionTable, key: Id, row: ProjectionRow): Change => ({
  table,
  key,
  row,
})

const remove = (table: ProjectionTable, key: Id): Change => ({ table, key, row: null })

const runEventKey = (runId: Id, seq: number): Id => `${runId}:${seq}`

/**
 * 老事实 replay 的任务行归一（M6/M6.5）：`task.created` 等历史 payload 没有
 * `origin/ruleId/externalRef/labels`，M6.5 前的 payload 没有 `threadId/parentTaskId`；
 * 重建时按默认值补齐，避免投影列写入 undefined。
 */
export function normalizeTask(row: Task): Task {
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
  }
}

/** 老事实 replay 的阶段行归一（M7/M8/M9）：缺交接 / 子任务 / 阶段说明字段时补默认值。 */ function normalizeStage(
  row: WorkflowStage,
): WorkflowStage {
  const legacy = row as Partial<WorkflowStage>
  return {
    ...row,
    handoffWorkflowId: legacy.handoffWorkflowId ?? null,
    handoffStageId: legacy.handoffStageId ?? null,
    subtaskStageId: legacy.subtaskStageId ?? null,
    onChildrenSettled: legacy.onChildrenSettled ?? null,
    spawnPolicy: legacy.spawnPolicy ?? null,
    instructions: legacy.instructions ?? '',
    // M20：老事实没有验收条目，按「未声明」归一
    acceptance: legacy.acceptance ?? [],
    // M21：老事实没有轮次上限，按「不续轮」归一
    maxRounds: legacy.maxRounds ?? null,
  }
}

/**
 * 老事实 replay 的卡片行归一（M12）：M4–M11 的 `card.*` payload 没有 `kind`，
 * 按当时的口径补齐——`options` 非空 = `ask`，否则 = `notice`。重建后投影列不会写 undefined。
 */
export function normalizeCard(row: Card): Card {
  const legacy = row as Partial<Card>
  return { ...row, kind: legacy.kind ?? (row.options.length > 0 ? 'ask' : 'notice') }
}

function importChanges(payload: SnapshotImportedPayload): Change[] {
  switch (payload.table) {
    case 'tasks':
      return payload.rows.map((row) => put('tasks', normalizeTask(row)))
    case 'workflows':
      return payload.rows.map((row) => put('workflows', row))
    case 'workflow_stages':
      return payload.rows.map((row) => put('workflow_stages', row))
    case 'agents':
      return payload.rows.map((row) => put('agents', row))
    case 'runtimes':
      return payload.rows.map((row) => put('runtimes', row))
    case 'runs':
      // 存量行可能缺 M2 新列：默认值由宿主 writer 归一（见 `projection-apply`）。
      return payload.rows.map((row) => put('runs', row))
    case 'run_events':
      return payload.rows.map((row) => putKeyed('run_events', runEventKey(row.runId, row.seq), row))
    case 'conversations':
      return payload.rows.map((row) => put('conversations', row))
    case 'messages':
      return payload.rows.map((row) => put('messages', row))
  }
}

function changesOf(fact: AnyFact): Change[] {
  switch (fact.type) {
    case 'workflow.created':
    case 'workflow.updated':
      return [put('workflows', fact.payload.workflow)]
    case 'workflow.removed':
      return [remove('workflows', fact.payload.workflow.id)]
    case 'stage.created':
    case 'stage.updated':
      return [put('workflow_stages', normalizeStage(fact.payload.stage))]
    case 'stage.deleted':
      return [remove('workflow_stages', fact.payload.stage.id)]
    case 'agent.created':
    case 'agent.updated':
      return [put('agents', fact.payload.agent)]
    case 'agent.removed':
      return [remove('agents', fact.payload.agent.id)]
    case 'runtime.created':
    case 'runtime.updated':
    case 'runtime.probed':
      return [put('runtimes', fact.payload.runtime)]
    case 'runtime.removed':
      return [remove('runtimes', fact.payload.runtime.id)]
    case 'project.created':
    case 'project.updated':
      // M10：项目事实携带完整行（含 updatedAt），整行 upsert；重建不回查
      return [put('projects', fact.payload.project)]
    case 'project.removed':
      return [remove('projects', fact.payload.project.id)]
    case 'task.created':
    case 'task.updated':
    case 'task.moved':
    case 'task.completed':
      // M6：规则任务带 origin/ruleId/externalRef/labels；老事实缺字段由归一补齐。
      return [put('tasks', normalizeTask(fact.payload.task))]
    case 'task.removed':
      return [remove('tasks', fact.payload.task.id)]
    case 'task.comment_added':
      // M7.5：任务上下文 / 反馈是纯追加行；任务删除时由投影层按 task_id 联删（事实只带评论行）
      return [put('task_comments', fact.payload.comment)]
    case 'task.children_settled':
      // M8：审计事实，不写表；效果由 run.queued / card.opened / task.completed 表达。
      return []
    case 'run.queued':
      // 入队事实是唯一需要回填字段的 run 事实：queueSeq 取事实 seq（领取 FIFO 稳定序号）。
      return [put('runs', { ...fact.payload.run, queueSeq: fact.seq })]
    case 'run.claimed':
    case 'run.lease_extended':
    case 'run.waiting':
    case 'run.abandoned':
    case 'run.succeeded':
    case 'run.failed':
    case 'run.cancelled':
    case 'run.usage':
    case 'run.cancel_requested':
      // 完整行演进：状态、租约、终态、用量、取消标记都在 payload.run 里。
      return [put('runs', fact.payload.run)]
    case 'run.frames':
      return fact.payload.frames.map((frame) =>
        putKeyed('run_events', runEventKey(frame.runId, frame.seq), frame),
      )
    case 'run.receipt_rejected':
      // 审计事实：迟到 / 重复 / 不匹配的回执不覆盖终态。
      return []
    case 'run.removed':
      // 只删 runs：`run_events` 由宿主按 run_id 联删（事实只携带 runId）。
      return [remove('runs', fact.payload.runId)]
    case 'card.opened':
    case 'card.updated':
    case 'card.delivered':
    case 'card.delivery_failed':
    case 'card.answered':
    case 'card.resolved':
      // M4：卡片事实一律携带完整 `Card` 行，整行 upsert（投递/回答/关闭都不需要合并旧行）；
      // M12：老事实缺 `kind` 时按「选项是否为空」归一。
      return [put('cards', normalizeCard(fact.payload.card))]
    case 'event.received':
    case 'event.dropped':
      // M4 只入账、不投影；M6 起命中规则建任务由 decide 直接产 task.created，不回收这些事实。
      return []
    case 'event.merged':
      // M6.5：事件合并进 queued run 的 eventIds（payload 带整行 run，重建不回查）
      return [put('runs', fact.payload.run)]
    case 'thread.opened':
    case 'thread.event_attached':
    case 'thread.task_attached':
    case 'thread.note_appended':
    case 'thread.closed':
    case 'thread.reopened':
    case 'thread.bound':
      // M6.5：线程事实一律携带完整 ThreadRow，整行 upsert
      return [put('threads', fact.payload.thread)]
    case 'thread.removed':
      // 只删 threads：线程内的 run 由同批 `run.removed` 逐条删除，不在这里联删
      return [remove('threads', fact.payload.thread.id)]
    case 'rules.replaced':
      // M6：规则集整批替换，一行事实 → 单行投影（key='current'）
      return [put('rule_sets', fact.payload.ruleSet)]
    case 'rule.fired':
      // M6：cron 触发记录，append-only（重复 id 由投影层主键报错）
      return [put('rule_fires', fact.payload.fire)]
    case 'plugins.replaced':
      // M7：插件设置整批替换，一行事实 → 单行投影（key='current'）
      return [put('plugin_settings', fact.payload.pluginSettings)]
    case 'review.reported':
    case 'review.addressed':
      // M14：评审结论与逐条处置都携带完整报告行（findings 状态已在行内），整行 upsert。
      // 改版是新 rev = 新行 id；处置是同一行 id 的状态演进——与 `card.*` 同口径。
      return [put('review_reports', fact.payload.report)]
    case 'conversation.created':
    case 'conversation.updated':
      // M9：老事实没有 `archivedAt`，按 null 归一，重建与增量折出同一行；
      // M11：老事实没有 `projectId`，同样按 null 归一（默认目录）
      return [
        put('conversations', {
          ...fact.payload.conversation,
          projectId: fact.payload.conversation.projectId ?? null,
          archivedAt: fact.payload.conversation.archivedAt ?? null,
        }),
      ]
    case 'conversation.removed':
      // 只删 conversations：`messages` 由宿主按 conversation_id 联删。
      return [remove('conversations', fact.payload.conversation.id)]
    case 'message.appended': {
      const payload = fact.payload
      return [
        put('messages', {
          id: payload.messageId,
          conversationId: payload.conversationId,
          role: payload.role,
          content: payload.content,
          error: payload.error ?? null,
          createdAt: fact.at,
        }),
      ]
    }
    case 'snapshot.imported':
      return importChanges(fact.payload)
  }
}

/** 一行事实 → 该事实要写进投影的变更；删除用 `row: null`。 */
export function project(fact: Fact): Change[] {
  return changesOf(fact as AnyFact)
}
