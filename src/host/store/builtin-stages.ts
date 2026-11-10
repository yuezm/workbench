/**
 * 启动补齐内置阶段（M18）：把每个工作流补成「待办 / 已阻塞 / 已完成 / 已取消」四件套。
 *
 * 只在启动时跑一次，幂等：四个内置阶段都在、位置也符合规范顺序时零事实。
 *
 * 认领口径：已经是内置阶段（`builtin` 有值）的按原键保留；老数据 / 模板里名字恰好叫
 * 「待办」「已阻塞」「已完成」「已取消」的阶段按名字认领成内置阶段（保留 id、配置与任务）；
 * 认领不到的键按默认值补建（进入时停下、无流转目标、无闸门）。
 *
 * 位置由规范顺序决定（待办 → 自己添加的阶段 → 已阻塞 → 已完成 → 已取消），
 * 因此补建后会给位置变了的阶段写一条 `stage.updated`。写路径仍是「追加事实 + 应用投影」，
 * 与命令路径同源；投影重建后结果一致。
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  BUILTIN_STAGE_KEYS,
  BUILTIN_STAGE_NAMES,
  type BuiltinStageKey,
  type WorkflowStage,
  type WorkflowWithStages,
} from '../../protocol/entities'
import type { FactDraft, Id, Iso, KernelPort } from '../../kernel/types'
import { withTx } from '../schema'
import { appendFacts } from './facts'
import { createProjectionWriter } from './projection-apply'
import { currentProjectionFormat, writeProjectionMeta } from './projection'
import { queryView } from './views'

/** 补齐事实的作者：启动对账阶段的宿主（与 v2 导入根同口径）。 */
export const BUILTIN_BACKFILL_ACTOR = { kind: 'host', via: 'reconcile' } as const

export interface BuiltinBackfillResult {
  /** 补建的内置阶段数 */
  created: number
  /** 因内置键 / 位置变化而改写的阶段数 */
  updated: number
}

/** 名称 → 内置键（不是内置名返回 null）。 */
function builtinKeyOfName(name: string): BuiltinStageKey | null {
  const trimmed = name.trim()
  for (const key of BUILTIN_STAGE_KEYS) {
    if (BUILTIN_STAGE_NAMES[key] === trimmed) return key
  }
  return null
}

/** 补建用的内置阶段行：进入时停下等人，与内核 `builtinStageInput` 的默认值一致。 */
function builtinStageRow(
  workflowId: Id,
  key: BuiltinStageKey,
  id: Id,
  position: number,
): WorkflowStage {
  return {
    id,
    workflowId,
    name: BUILTIN_STAGE_NAMES[key],
    position,
    entryMode: 'none',
    builtin: key,
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
    handoffWorkflowId: null,
    handoffStageId: null,
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: '',
    acceptance: [],
    maxRounds: null,
    gate: null,
  }
}

/**
 * 一个工作流的内置阶段补齐计划：按规范顺序排好的行 + 需要补建的键。
 *
 * 纯函数（读投影就行）：`entries` 里既有既有行的改写形态，也有补建行。
 */
/** 补齐计划的一项：既有行（可能要改键 / 位置）或需要补建的内置阶段。 */
type PlannedStage =
  | { kind: 'existing'; key: BuiltinStageKey | null; stage: WorkflowStage }
  | { kind: 'create'; key: BuiltinStageKey }

export function planBuiltinStages(
  workflowId: Id,
  stages: readonly WorkflowStage[],
  newId: () => Id,
): {
  rows: WorkflowStage[]
  changed: Array<{ before: WorkflowStage | null; after: WorkflowStage }>
} {
  const claimed = new Map<BuiltinStageKey, WorkflowStage>()
  const users: WorkflowStage[] = []
  for (const stage of stages) {
    const key = stage.builtin ?? builtinKeyOfName(stage.name)
    if (key !== null && !claimed.has(key)) {
      claimed.set(key, stage)
      continue
    }
    users.push(stage)
  }
  const ordered: PlannedStage[] = []
  const todo = claimed.get('todo')
  ordered.push(
    todo === undefined
      ? { kind: 'create', key: 'todo' }
      : { kind: 'existing', key: 'todo', stage: todo },
  )
  for (const stage of users) ordered.push({ kind: 'existing', key: null, stage })
  for (const key of ['blocked', 'done', 'cancelled'] as const) {
    const stage = claimed.get(key)
    ordered.push(stage === undefined ? { kind: 'create', key } : { kind: 'existing', key, stage })
  }
  const changed: Array<{ before: WorkflowStage | null; after: WorkflowStage }> = []
  const rows = ordered.map((entry, position) => {
    if (entry.kind === 'create') {
      const after = builtinStageRow(workflowId, entry.key, newId(), position)
      changed.push({ before: null, after })
      return after
    }
    const before = entry.stage
    const after = { ...before, builtin: entry.key, position }
    if ((before.builtin ?? null) !== entry.key || before.position !== position) {
      changed.push({ before, after })
    }
    return after
  })
  return { rows, changed }
}

/**
 * 补齐全部工作流的内置阶段；返回新建 / 改写的阶段数（0 表示已经是规范形态）。
 *
 * 必须在 `ensureProjection()` 之后调用：读的是投影，写的是事实 + 投影变更。
 */
export function backfillBuiltinStages(
  db: DatabaseSync,
  kernel: KernelPort,
  newId: () => Id,
  now: () => Iso,
): BuiltinBackfillResult {
  const workflows = queryView(db, 'workflows.all') as WorkflowWithStages[]
  const drafts: FactDraft[] = []
  let created = 0
  let updated = 0
  for (const workflow of workflows) {
    const plan = planBuiltinStages(workflow.id, workflow.stages, newId)
    for (const entry of plan.changed) {
      if (entry.before === null) {
        created += 1
        drafts.push({
          type: 'stage.created',
          actor: BUILTIN_BACKFILL_ACTOR,
          at: now(),
          payload: { stage: entry.after },
        })
        continue
      }
      updated += 1
      drafts.push({
        type: 'stage.updated',
        actor: BUILTIN_BACKFILL_ACTOR,
        at: now(),
        payload: { stage: entry.after },
      })
    }
  }
  if (drafts.length === 0) return { created: 0, updated: 0 }

  const writer = createProjectionWriter(db)
  withTx(db, () => {
    // 阶段行有自引用外键（on_complete_stage_id / on_reject_stage_id）：先写行、提交时再校验
    db.exec('PRAGMA defer_foreign_keys = ON')
    const facts = appendFacts(db, drafts)
    const writes = []
    for (const fact of facts) {
      for (const change of kernel.project(fact)) writes.push({ change, at: fact.at })
    }
    writer.applyAll(writes)
    writeProjectionMeta(db, currentProjectionFormat(), facts[facts.length - 1].seq)
  })
  return { created, updated }
}
