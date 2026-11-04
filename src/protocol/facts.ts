/**
 * 事实契约（M1 子集）：事实名常量 + 各事实 payload 类型。
 *
 * 约定：实体类事实的 payload 用同名字段包一行（`workflow` / `stage` / `agent` /
 * `runtime` / `task`），删除类事实携带删除前的末态行作为 tombstone，
 * 让 `timeline` 不必回查投影即可还原历史（阶段 id 稳定，不悬空）。
 * runtime 事实一律携带完整行（含 `lastProbe`）：`project` 只做「一行事实 → 一行投影」，
 * 不做特判；探测结论变化单独走 `runtime.probed`。凭据类字段不进事实。
 */
import type { Agent, Runtime, Task, Workflow, WorkflowStage } from './entities'

/** M1 事实名全集；`event.*` / `run.*` / `card.*` / `thread.*` 等 M2 之后落地。 */
export const FACT_TYPES = [
  'workflow.created',
  'workflow.updated',
  'workflow.removed',
  'stage.created',
  'stage.updated',
  'stage.deleted',
  'agent.created',
  'agent.updated',
  'agent.removed',
  'runtime.created',
  'runtime.updated',
  'runtime.removed',
  'runtime.probed',
  'task.created',
  'task.moved',
  'task.completed',
  'task.removed',
  'snapshot.imported',
] as const

export type FactType = (typeof FACT_TYPES)[number]

// ---------- 工作流 / 阶段 ----------

export interface WorkflowCreatedPayload {
  workflow: Workflow
}

export interface WorkflowUpdatedPayload {
  workflow: Workflow
}

/** tombstone：删除前的末态行 */
export interface WorkflowRemovedPayload {
  workflow: Workflow
}

export interface StageCreatedPayload {
  stage: WorkflowStage
}

export interface StageUpdatedPayload {
  stage: WorkflowStage
}

/** tombstone：历史 run 的 stageId 据此仍可解释 */
export interface StageDeletedPayload {
  stage: WorkflowStage
}

// ---------- 智能体 ----------

export interface AgentCreatedPayload {
  agent: Agent
}

export interface AgentUpdatedPayload {
  agent: Agent
}

/** tombstone：删除前的末态行 */
export interface AgentRemovedPayload {
  agent: Agent
}

// ---------- 运行时 ----------

/** 配置事实携带完整行（含 `lastProbe`），重建时无需回查其它事实。 */
export interface RuntimeCreatedPayload {
  runtime: Runtime
}

export interface RuntimeUpdatedPayload {
  runtime: Runtime
}

/** tombstone：删除前的末态行（含末次探测结论） */
export interface RuntimeRemovedPayload {
  runtime: Runtime
}

/** 探测事实携带更新后的完整行：`lastProbe` 是行的一部分，投影直接 upsert。 */
export interface RuntimeProbedPayload {
  runtime: Runtime
}

// ---------- 任务 ----------

export interface TaskCreatedPayload {
  task: Task
}

export interface TaskMovedPayload {
  task: Task
  /** 移动前阶段；null = 无阶段 */
  from: string | null
  /** 移动后阶段；null = 无阶段 */
  to: string | null
}

export interface TaskCompletedPayload {
  task: Task
}

/** tombstone：删除前的末态行 */
export interface TaskRemovedPayload {
  task: Task
}

// ---------- 存量导入 ----------

/** v2 存量按表分批写成导入根（无 `cause`，`timeline` 标注「迁移导入」）。 */
export type SnapshotImportedPayload =
  | { table: 'tasks'; rows: Task[]; importedFrom: 'v2' }
  | { table: 'workflows'; rows: Workflow[]; importedFrom: 'v2' }
  | { table: 'workflow_stages'; rows: WorkflowStage[]; importedFrom: 'v2' }
  | { table: 'agents'; rows: Agent[]; importedFrom: 'v2' }
  | { table: 'runtimes'; rows: Runtime[]; importedFrom: 'v2' }

/** 事实名 → payload 类型；`FactPayload<T>` 供 kernel 的 `FactDraft` 收窄。 */
export interface FactPayloads {
  'workflow.created': WorkflowCreatedPayload
  'workflow.updated': WorkflowUpdatedPayload
  'workflow.removed': WorkflowRemovedPayload
  'stage.created': StageCreatedPayload
  'stage.updated': StageUpdatedPayload
  'stage.deleted': StageDeletedPayload
  'agent.created': AgentCreatedPayload
  'agent.updated': AgentUpdatedPayload
  'agent.removed': AgentRemovedPayload
  'runtime.created': RuntimeCreatedPayload
  'runtime.updated': RuntimeUpdatedPayload
  'runtime.removed': RuntimeRemovedPayload
  'runtime.probed': RuntimeProbedPayload
  'task.created': TaskCreatedPayload
  'task.moved': TaskMovedPayload
  'task.completed': TaskCompletedPayload
  'task.removed': TaskRemovedPayload
  'snapshot.imported': SnapshotImportedPayload
}

export type FactPayload<T extends FactType> = FactPayloads[T]
