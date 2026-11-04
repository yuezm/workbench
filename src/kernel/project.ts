/**
 * 事实 → 投影变更（五张业务表）。
 *
 * 纯函数、无 IO：一行事实映射一行投影——实体类事实 upsert 那一行，删除类事实的
 * payload 行本身就是 tombstone，投影写 `row: null`。`snapshot.imported` 是唯一批量例外，
 * 按 `payload.table` 批量 upsert。
 *
 * 实时写入与重建共用这一条路径，所以同一事实序列按 seq fold 两次结果必然相同。
 * 删除**不依赖 SQL 级联**：重建时会临时关外键，级联不会发生，级联删除由 `decide`
 * 显式发事实（`workflow.remove` 会逐个产出 stage/task 的 tombstone）。
 */
import type { FactType, SnapshotImportedPayload } from '../protocol/facts'
import type { Change, Fact, Id, ProjectionRow, ProjectionTable } from './types'

/**
 * `Fact` 的默认泛型是单对象类型，`switch (fact.type)` 无法收窄 payload；
 * 展开成按事实名分发的判别联合后，每个分支都能拿到精确 payload。
 */
type AnyFact = { [K in FactType]: Fact<K> }[FactType]

const put = (table: ProjectionTable, row: ProjectionRow): Change => ({
  table,
  key: row.id,
  row,
})

const remove = (table: ProjectionTable, key: Id): Change => ({ table, key, row: null })

function importChanges(payload: SnapshotImportedPayload): Change[] {
  switch (payload.table) {
    case 'tasks':
      return payload.rows.map((row) => put('tasks', row))
    case 'workflows':
      return payload.rows.map((row) => put('workflows', row))
    case 'workflow_stages':
      return payload.rows.map((row) => put('workflow_stages', row))
    case 'agents':
      return payload.rows.map((row) => put('agents', row))
    case 'runtimes':
      return payload.rows.map((row) => put('runtimes', row))
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
      return [put('workflow_stages', fact.payload.stage)]
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
    case 'task.created':
    case 'task.moved':
    case 'task.completed':
      return [put('tasks', fact.payload.task)]
    case 'task.removed':
      return [remove('tasks', fact.payload.task.id)]
    case 'snapshot.imported':
      return importChanges(fact.payload)
  }
}

/** 一行事实 → 该事实要写进投影的变更；删除用 `row: null`。 */
export function project(fact: Fact): Change[] {
  return changesOf(fact as AnyFact)
}
