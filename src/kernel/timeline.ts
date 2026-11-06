/**
 * `why` 时间线：从一个实体的相关事实出发，沿 `cause` 链向上补齐前置事实。
 *
 * 纯函数、无 IO；只接受宿主交来的事实序列（未排序也可以，输出总是按 seq 升序）。
 * 迁移导入根 `snapshot.imported` 是基线而不是因果链的一环——它被标成「迁移导入」，
 * 不向上追溯，也不伪造来由。
 *
 * 可追溯实体在 M2 扩到运行与对话：`run` 是运行类事实的主体，`conversation` / `message`
 * 是聊天事实的主体（`message.appended` 同时命中它所属的对话，方便从对话视角看整段历史）。
 */
import type { FactType, SnapshotImportedPayload } from '../protocol/facts'
import type { Fact, Id, Seq } from './types'

/** 可追溯的实体范围（投影十表中的可展示实体）。 */
export type TimelineScope =
  | 'task'
  | 'workflow'
  | 'stage'
  | 'agent'
  | 'runtime'
  | 'run'
  | 'conversation'
  | 'message'
  | 'card'
  | 'thread'

/** 导入根在时间线上的标注文案。 */
export const IMPORT_ROOT_LABEL = '迁移导入'

export interface TimelineEntry {
  fact: Fact
  /** 迁移导入根：没有 `cause` 的 `snapshot.imported`，引用链到此为止 */
  imported: boolean
  /** 展示标注：普通事实为 null，导入根为「迁移导入」 */
  label: string | null
}

/** 与 `project` 同因：默认泛型的 `Fact` 不能按事实名收窄 payload。 */
type AnyFact = { [K in FactType]: Fact<K> }[FactType]

interface EntityRef {
  scope: TimelineScope
  id: Id
}

/** 导入根按表落到实体范围；同一批 rows 里任意一行命中即算该实体的时间线入口。 */
function importRefs(payload: SnapshotImportedPayload): EntityRef[] {
  switch (payload.table) {
    case 'tasks':
      return payload.rows.map((row) => ({ scope: 'task', id: row.id }))
    case 'workflows':
      return payload.rows.map((row) => ({ scope: 'workflow', id: row.id }))
    case 'workflow_stages':
      return payload.rows.map((row) => ({ scope: 'stage', id: row.id }))
    case 'agents':
      return payload.rows.map((row) => ({ scope: 'agent', id: row.id }))
    case 'runtimes':
      return payload.rows.map((row) => ({ scope: 'runtime', id: row.id }))
    case 'runs':
      return payload.rows.map((row) => ({ scope: 'run', id: row.id }))
    case 'run_events':
      return payload.rows.map((row) => ({ scope: 'run', id: row.runId }))
    case 'conversations':
      return payload.rows.map((row) => ({ scope: 'conversation', id: row.id }))
    case 'messages':
      return payload.rows.flatMap((row) => [
        { scope: 'conversation', id: row.conversationId },
        { scope: 'message', id: row.id },
      ])
  }
}

function refsOf(fact: AnyFact): EntityRef[] {
  switch (fact.type) {
    case 'workflow.created':
    case 'workflow.updated':
    case 'workflow.removed':
      return [{ scope: 'workflow', id: fact.payload.workflow.id }]
    case 'stage.created':
    case 'stage.updated':
    case 'stage.deleted':
      return [{ scope: 'stage', id: fact.payload.stage.id }]
    case 'agent.created':
    case 'agent.updated':
    case 'agent.removed':
      return [{ scope: 'agent', id: fact.payload.agent.id }]
    case 'runtime.created':
    case 'runtime.updated':
    case 'runtime.removed':
    case 'runtime.probed':
      return [{ scope: 'runtime', id: fact.payload.runtime.id }]
    case 'task.created':
    case 'task.moved':
    case 'task.completed':
    case 'task.removed':
    case 'task.comment_added':
      // M7.5：上下文 / 反馈归到任务的时间线（评论行自带 taskId）
      return [
        {
          scope: 'task',
          id:
            fact.type === 'task.comment_added' ? fact.payload.comment.taskId : fact.payload.task.id,
        },
      ]
    case 'run.queued':
    case 'run.claimed':
    case 'run.lease_extended':
    case 'run.waiting':
    case 'run.abandoned':
    case 'run.succeeded':
    case 'run.failed':
    case 'run.cancelled':
    case 'run.usage':
    case 'run.cancel_requested':
      // 运行状态事实携带完整 RunRow；帧 / 审计 / 删除事实只带 runId。
      return [{ scope: 'run', id: fact.payload.run.id }]
    case 'run.frames':
    case 'run.receipt_rejected':
    case 'run.removed':
      return [{ scope: 'run', id: fact.payload.runId }]
    case 'card.opened':
    case 'card.updated':
    case 'card.delivered':
    case 'card.delivery_failed':
    case 'card.answered':
    case 'card.resolved':
      // 卡片事实同时归到卡片与它所属的 run：运行时间线能看到该轮产生的卡与回答。
      return [
        { scope: 'run', id: fact.payload.card.runId },
        { scope: 'card', id: fact.payload.card.id },
      ]
    case 'event.received':
      // 派生事件挂在父 run 的时间线上；事件自身没有投影表，不单独成一条 scope。
      return fact.payload.originRunId === null
        ? []
        : [{ scope: 'run', id: fact.payload.originRunId }]
    case 'event.dropped':
      // 熔断审计事实只带 eventId：不归入任何实体，只在 cause 链上出现。
      return []
    case 'event.merged':
      // 合并事件归到被合并的 run 的时间线
      return [{ scope: 'run', id: fact.payload.run.id }]
    case 'thread.opened':
    case 'thread.event_attached':
    case 'thread.task_attached':
    case 'thread.note_appended':
    case 'thread.closed':
    case 'thread.reopened':
    case 'thread.bound':
      return [{ scope: 'thread', id: fact.payload.thread.id }]
    case 'rules.replaced':
    case 'rule.fired':
      // 规则事实归到规则集（没有独立 scope）；规则任务由 task.created 的 cause/ruleId 追溯。
      return []
    case 'plugins.replaced':
      // 插件设置快照没有独立 scope：设置变更只影响插件装载与授权，不挂业务实体。
      return []
    case 'conversation.created':
    case 'conversation.updated':
    case 'conversation.removed':
      return [{ scope: 'conversation', id: fact.payload.conversation.id }]
    case 'message.appended':
      return [
        { scope: 'conversation', id: fact.payload.conversationId },
        { scope: 'message', id: fact.payload.messageId },
      ]
    case 'snapshot.imported':
      return importRefs(fact.payload)
  }
}

const toEntry = (fact: Fact): TimelineEntry => {
  const imported = fact.type === 'snapshot.imported'
  return { fact, imported, label: imported ? IMPORT_ROOT_LABEL : null }
}

/**
 * 某实体的 `why` 链：命中该实体的事实 + 它们沿 `cause` 指向前置事实的整条链，
 * 去重后按 seq 升序返回。`cause` 指向的事实不在入参序列里时链条就此截断（不补猜测）。
 */
export function timeline(facts: Fact[], scope: TimelineScope, id: Id): TimelineEntry[] {
  const bySeq = new Map<Seq, Fact>()
  for (const fact of facts) bySeq.set(fact.seq, fact)

  const included = new Map<Seq, Fact>()
  const visit = (fact: Fact): void => {
    if (included.has(fact.seq)) return
    included.set(fact.seq, fact)
    const cause = fact.cause
    if (cause === undefined || cause === null) return
    const parent = bySeq.get(cause)
    if (parent) visit(parent)
  }

  for (const fact of facts) {
    const hit = refsOf(fact as AnyFact).some((ref) => ref.scope === scope && ref.id === id)
    if (hit) visit(fact)
  }

  return [...included.values()].sort((a, b) => a.seq - b.seq).map(toEntry)
}
