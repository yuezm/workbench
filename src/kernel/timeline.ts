/**
 * `why` 时间线：从一个实体的相关事实出发，沿 `cause` 链向上补齐前置事实。
 *
 * 纯函数、无 IO；只接受宿主交来的事实序列（未排序也可以，输出总是按 seq 升序）。
 * 迁移导入根 `snapshot.imported` 是基线而不是因果链的一环——它被标成「迁移导入」，
 * 不向上追溯，也不伪造来由。
 */
import type { FactType, SnapshotImportedPayload } from '../protocol/facts'
import type { Fact, Id, Seq } from './types'

/** 可追溯的实体范围（M1 投影集五表；run/thread/card 等在 M2 之后补）。 */
export type TimelineScope = 'task' | 'workflow' | 'stage' | 'agent' | 'runtime'

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
      return [{ scope: 'task', id: fact.payload.task.id }]
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
