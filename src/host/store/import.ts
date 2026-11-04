/**
 * v2 存量导入（M1 T6）：`facts` 为空且五张投影表有数据时，把旧表按 FK 安全顺序、
 * 每批 ≤500 行写成 `snapshot.imported` 事实根，之后日志即唯一权威。
 *
 * 约定（tasks/m1-plan.md「存量导入」、SPEC-kernel「导入根」）：
 * - 只写一次：`facts` 非空直接 no-op；导入失败整体回滚，可安全重试。
 * - 读旧表用显式列清单（不 `SELECT *` 猜列），snake_case → `protocol/entities` 行。
 * - 每行实体 = 事实 payload 里的一行，`project(fact)` 是纯函数：同一批事实 fold 两次
 *   （导入时的增量写入与以后的重建）必须得到同一份投影。
 * - `workflow_stages.created_at` 不在行类型里：投影插入用事实 `at`；旧表里已有行时
 *   upsert 会保留旧 created_at，因此导入后显式对齐成 `at`，与重建结果一致。
 * - 导入根没有 `cause`：`timeline` 标「迁移导入」，不伪造因果链。
 *
 * 事务：整次导入一个事务（`append` + `project` + 落投影 + 写 `projection_meta`）；
 * 事务内 `PRAGMA defer_foreign_keys = ON`，让「阶段自引用、跨批引用」的外键在 COMMIT 时统一校验。
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  EntryMode,
  PermissionMode,
  Runtime,
  RuntimeProbe,
  RuntimeProtocolFamily,
  Task,
  TaskStatus,
  Workflow,
  WorkflowStage,
} from '../../protocol/entities'
import type { FactDraft, Iso, KernelPort, ProjectionRow, ProjectionTable } from '../../kernel/types'
import { withTx } from '../schema'
import { currentProjectionFormat, writeProjectionMeta } from './projection'
import { appendFacts, factsCount, lastSeq } from './facts'
import { createProjectionWriter } from './projection-apply'

/** 单条 `snapshot.imported` 事实承载的最大行数（SPEC：按表分批，每批 ≤500 行）。 */
export const IMPORT_BATCH_SIZE = 500

/** 导入根的事实作者：启动对账阶段的宿主。 */
export const IMPORT_ACTOR = { kind: 'host', via: 'reconcile' } as const

/**
 * 读表顺序 = FK 依赖顺序：runtimes → agents → workflows → workflow_stages → tasks。
 * 同表内部的行间引用（阶段自引用）交给延迟外键在 COMMIT 时校验。
 */
export const IMPORT_ORDER = ['runtimes', 'agents', 'workflows', 'workflow_stages', 'tasks'] as const

export interface ImportLegacyOptions {
  /** 导入事实的 `at`（同时是阶段行的 created_at 来源）；默认当前时刻。 */
  at?: Iso
}

export interface ImportLegacyResult {
  /** 本次是否真的写了事实（幂等 / 空库时为 false）。 */
  imported: boolean
  /** 本次导入的行数（未导入时为全 0）。 */
  counts: Record<ProjectionTable, number>
}

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

interface LegacyRows {
  runtimes: Runtime[]
  agents: Agent[]
  workflows: Workflow[]
  workflow_stages: WorkflowStage[]
  tasks: Task[]
}

/** 五表读取：每张表逐列写死，列名变更必须在这里同步（与 `views.ts` / `projection-apply.ts` 对齐）。 */
function readLegacyRows(db: DatabaseSync): LegacyRows {
  const runtimes = (
    db
      .prepare(
        `SELECT id, name, protocol_family, command, profile, permission_mode, model,
                reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at
         FROM runtimes ORDER BY created_at, rowid`,
      )
      .all() as unknown as RuntimeRow[]
  ).map((row): Runtime => ({
    id: row.id,
    name: row.name,
    protocolFamily: row.protocol_family as RuntimeProtocolFamily,
    command: row.command,
    profile: row.profile,
    permissionMode: row.permission_mode as PermissionMode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    workdir: row.workdir,
    maxConcurrent: row.max_concurrent,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastProbe:
      row.last_probe_json === null ? null : (JSON.parse(row.last_probe_json) as RuntimeProbe),
  }))

  const agents = (
    db
      .prepare(
        `SELECT id, name, description, runtime_id, system_prompt, created_at
         FROM agents ORDER BY created_at, rowid`,
      )
      .all() as unknown as AgentRow[]
  ).map((row): Agent => ({
    id: row.id,
    name: row.name,
    description: row.description,
    runtimeId: row.runtime_id,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
  }))

  const workflows = (
    db
      .prepare('SELECT id, name, description, created_at FROM workflows ORDER BY created_at, rowid')
      .all() as unknown as WorkflowRow[]
  ).map((row): Workflow => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
  }))

  const workflow_stages = (
    db
      .prepare(
        `SELECT id, workflow_id, name, position, entry_mode, agent_id,
                on_complete_stage_id, on_reject_stage_id
         FROM workflow_stages ORDER BY workflow_id, position`,
      )
      .all() as unknown as StageRow[]
  ).map((row): WorkflowStage => ({
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    position: row.position,
    entryMode: row.entry_mode as EntryMode,
    agentId: row.agent_id,
    onCompleteStageId: row.on_complete_stage_id,
    onRejectStageId: row.on_reject_stage_id,
  }))

  const tasks = (
    db
      .prepare(
        `SELECT id, title, description, workflow_id, current_stage_id, status, created_at, updated_at
         FROM tasks ORDER BY created_at, rowid`,
      )
      .all() as unknown as TaskRow[]
  ).map((row): Task => ({
    id: row.id,
    title: row.title,
    description: row.description,
    workflowId: row.workflow_id,
    currentStageId: row.current_stage_id,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  return { runtimes, agents, workflows, workflow_stages, tasks }
}

const emptyCounts = (): Record<ProjectionTable, number> => ({
  tasks: 0,
  workflows: 0,
  workflow_stages: 0,
  agents: 0,
  runtimes: 0,
})

/** 一组行 + 表名 → `snapshot.imported` 草稿（payload 按表收窄成判别联合）。 */
function buildDraft(table: ProjectionTable, rows: readonly ProjectionRow[], at: Iso): FactDraft {
  switch (table) {
    case 'runtimes':
      return {
        type: 'snapshot.imported',
        actor: IMPORT_ACTOR,
        at,
        payload: { table, rows: rows as Runtime[], importedFrom: 'v2' },
      }
    case 'agents':
      return {
        type: 'snapshot.imported',
        actor: IMPORT_ACTOR,
        at,
        payload: { table, rows: rows as Agent[], importedFrom: 'v2' },
      }
    case 'workflows':
      return {
        type: 'snapshot.imported',
        actor: IMPORT_ACTOR,
        at,
        payload: { table, rows: rows as Workflow[], importedFrom: 'v2' },
      }
    case 'workflow_stages':
      return {
        type: 'snapshot.imported',
        actor: IMPORT_ACTOR,
        at,
        payload: { table, rows: rows as WorkflowStage[], importedFrom: 'v2' },
      }
    case 'tasks':
      return {
        type: 'snapshot.imported',
        actor: IMPORT_ACTOR,
        at,
        payload: { table, rows: rows as Task[], importedFrom: 'v2' },
      }
  }
}

/** 导入后逐表校验行数；不符就抛错，由外层事务整体回滚。 */
function verifyCounts(db: DatabaseSync, counts: Record<ProjectionTable, number>): void {
  for (const table of IMPORT_ORDER) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }
    if (row.n !== counts[table]) {
      throw new Error(
        `存量导入校验失败（${table}）：导入 ${counts[table]} 行，投影实际 ${row.n} 行`,
      )
    }
  }
}

/**
 * 需要时导入 v2 存量五表；幂等。
 *
 * - `facts` 非空 → 不动作（已经导入过 / 新库已开始记账），返回 `imported: false`。
 * - 五表全空 → 不产事实、不写 `projection_meta`（空库由调用方的 `ensureProjection` 收尾）。
 * - 否则单事务内按表分批追加 `snapshot.imported` → `project(fact)` → 落投影 → 写元信息。
 *
 * @param db 已打开且建好 schema 的连接（`openDatabase`）
 * @param kernel 内核端口；只用到 `project`
 * @param options 导入时刻（事实 `at` 与阶段 created_at）；默认当前时刻
 */
export function importLegacyIfNeeded(
  db: DatabaseSync,
  kernel: KernelPort,
  options: ImportLegacyOptions = {},
): ImportLegacyResult {
  if (factsCount(db) !== 0) return { imported: false, counts: emptyCounts() }

  const legacy = readLegacyRows(db)
  const total = IMPORT_ORDER.reduce((sum, table) => sum + legacy[table].length, 0)
  if (total === 0) return { imported: false, counts: emptyCounts() }

  const at = options.at ?? new Date().toISOString()
  const counts = emptyCounts()
  const writer = createProjectionWriter(db)
  const touchStageCreatedAt = db.prepare('UPDATE workflow_stages SET created_at = ? WHERE id = ?')

  withTx(db, () => {
    // 阶段自引用、跨批引用都要等 COMMIT 再校验（事务结束自动复位）。
    db.exec('PRAGMA defer_foreign_keys = ON')

    for (const table of IMPORT_ORDER) {
      const rows = legacy[table]
      counts[table] = rows.length
      for (let start = 0; start < rows.length; start += IMPORT_BATCH_SIZE) {
        const batch = rows.slice(start, start + IMPORT_BATCH_SIZE)
        const [fact] = appendFacts(db, [buildDraft(table, batch, at)])
        writer.applyAll(kernel.project(fact).map((change) => ({ change, at: fact.at })))
        if (table === 'workflow_stages') {
          for (const row of batch as WorkflowStage[]) touchStageCreatedAt.run(fact.at, row.id)
        }
      }
    }

    verifyCounts(db, counts)
    writeProjectionMeta(db, currentProjectionFormat(), lastSeq(db))
  })

  return { imported: true, counts }
}
