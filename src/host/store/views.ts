/**
 * 视图装载与查询。
 *
 * - `loadView`：按 `kernel.viewSpec(input)` 给出的投影表切片装载只读视图，外加活跃 run 的
 *   任务集合（内核判断「执行中」只认它）；内核不查库。
 * - `queryView`：`query(view, params)` 的读路径，行 → 协议行类型（`protocol/entities`）。
 *
 * 两张读路径都逐列写死 SELECT，不 `SELECT *`：列名变更必须在这里同步。
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
  WorkflowWithStages,
} from '../../protocol/entities'
import type { ActiveRun, ViewId } from '../../protocol/views'
import { VIEW_IDS } from '../../protocol/views'
import type { ProjectionTable, View } from '../../kernel/types'
import { lastSeq } from './facts'
import { StoreError } from './errors'

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

interface AgentRow {
  id: string
  name: string
  description: string
  runtime_id: string
  system_prompt: string
  created_at: string
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

interface ActiveRunRow {
  id: string
  task_id: string
  stage_id: string | null
  status: string
}

const mapWorkflow = (row: WorkflowRow): Workflow => ({
  id: row.id,
  name: row.name,
  description: row.description,
  createdAt: row.created_at,
})

const mapStage = (row: StageRow): WorkflowStage => ({
  id: row.id,
  workflowId: row.workflow_id,
  name: row.name,
  position: row.position,
  entryMode: row.entry_mode as EntryMode,
  agentId: row.agent_id,
  onCompleteStageId: row.on_complete_stage_id,
  onRejectStageId: row.on_reject_stage_id,
})

const mapAgent = (row: AgentRow): Agent => ({
  id: row.id,
  name: row.name,
  description: row.description,
  runtimeId: row.runtime_id,
  systemPrompt: row.system_prompt,
  createdAt: row.created_at,
})

const mapRuntime = (row: RuntimeRow): Runtime => ({
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
})

const mapTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  description: row.description,
  workflowId: row.workflow_id,
  currentStageId: row.current_stage_id,
  status: row.status as TaskStatus,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const readWorkflows = (db: DatabaseSync): Workflow[] =>
  (
    db
      .prepare('SELECT id, name, description, created_at FROM workflows ORDER BY created_at, rowid')
      .all() as unknown as WorkflowRow[]
  ).map(mapWorkflow)

/** 阶段按 (workflow_id, position) 排；调用方按 workflow 分组后顺序即稳定。 */
const readStages = (db: DatabaseSync): WorkflowStage[] =>
  (
    db
      .prepare(
        `SELECT id, workflow_id, name, position, entry_mode, agent_id,
                on_complete_stage_id, on_reject_stage_id
         FROM workflow_stages ORDER BY workflow_id, position`,
      )
      .all() as unknown as StageRow[]
  ).map(mapStage)

const readAgents = (db: DatabaseSync): Agent[] =>
  (
    db
      .prepare(
        'SELECT id, name, description, runtime_id, system_prompt, created_at FROM agents ORDER BY created_at, rowid',
      )
      .all() as unknown as AgentRow[]
  ).map(mapAgent)

const readRuntimes = (db: DatabaseSync): Runtime[] =>
  (
    db
      .prepare(
        `SELECT id, name, protocol_family, command, profile, permission_mode, model,
                reasoning_effort, workdir, max_concurrent, enabled, last_probe_json, created_at
         FROM runtimes ORDER BY created_at, rowid`,
      )
      .all() as unknown as RuntimeRow[]
  ).map(mapRuntime)

const readTasks = (db: DatabaseSync): Task[] =>
  (
    db
      .prepare(
        `SELECT id, title, description, workflow_id, current_stage_id, status, created_at, updated_at
         FROM tasks ORDER BY created_at, rowid`,
      )
      .all() as unknown as TaskRow[]
  ).map(mapTask)

const toMap = <T extends { id: string }>(rows: readonly T[]): Map<string, T> =>
  new Map(rows.map((row) => [row.id, row]))

/** 存在 queued/running run 的任务 id；读 `runs`（非投影表）是装载视图的一部分。 */
const readActiveTaskIds = (db: DatabaseSync): Set<string> => {
  const rows = db
    .prepare("SELECT DISTINCT task_id FROM runs WHERE status IN ('queued','running')")
    .all() as unknown as Array<{ task_id: string }>
  return new Set(rows.map((row) => row.task_id))
}

/** 按输入声明的切片装载视图：未声明的表不查，`activeTaskIds` 总是装载。 */
export function loadView(db: DatabaseSync, tables: readonly ProjectionTable[]): View {
  const slice = new Set<ProjectionTable>(tables)
  return {
    seq: lastSeq(db),
    workflows: slice.has('workflows') ? toMap(readWorkflows(db)) : new Map(),
    stages: slice.has('workflow_stages') ? toMap(readStages(db)) : new Map(),
    agents: slice.has('agents') ? toMap(readAgents(db)) : new Map(),
    runtimes: slice.has('runtimes') ? toMap(readRuntimes(db)) : new Map(),
    tasks: slice.has('tasks') ? toMap(readTasks(db)) : new Map(),
    activeTaskIds: readActiveTaskIds(db),
  }
}

const readWorkflowsWithStages = (db: DatabaseSync): WorkflowWithStages[] => {
  const stagesByWorkflow = new Map<string, WorkflowStage[]>()
  for (const stage of readStages(db)) {
    const bucket = stagesByWorkflow.get(stage.workflowId)
    if (bucket) bucket.push(stage)
    else stagesByWorkflow.set(stage.workflowId, [stage])
  }
  return readWorkflows(db).map((workflow) => ({
    ...workflow,
    stages: stagesByWorkflow.get(workflow.id) ?? [],
  }))
}

const readTasksByWorkflow = (db: DatabaseSync, workflowId: string): Task[] =>
  (
    db
      .prepare(
        `SELECT id, title, description, workflow_id, current_stage_id, status, created_at, updated_at
         FROM tasks WHERE workflow_id = ? ORDER BY created_at, rowid`,
      )
      .all(workflowId) as unknown as TaskRow[]
  ).map(mapTask)

const readTask = (db: DatabaseSync, taskId: string): Task | null => {
  const row = db
    .prepare(
      `SELECT id, title, description, workflow_id, current_stage_id, status, created_at, updated_at
       FROM tasks WHERE id = ?`,
    )
    .get(taskId) as unknown as TaskRow | undefined
  return row ? mapTask(row) : null
}

const readActiveRuns = (db: DatabaseSync, taskId: string): ActiveRun[] =>
  (
    db
      .prepare(
        `SELECT id, task_id, stage_id, status FROM runs
         WHERE task_id = ? AND status IN ('queued','running')
         ORDER BY created_at, rowid`,
      )
      .all(taskId) as unknown as ActiveRunRow[]
  ).map((row) => ({
    id: row.id,
    taskId: row.task_id,
    stageId: row.stage_id,
    status: row.status as ActiveRun['status'],
  }))

const readStringParam = (params: unknown, key: string): string => {
  if (typeof params !== 'object' || params === null) {
    throw new StoreError('invalid_input', `视图缺少参数 ${key}`)
  }
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value === '') {
    throw new StoreError('invalid_input', `视图缺少参数 ${key}`)
  }
  return value
}

/** `query(view, params)` 的实现：视图 id 与参数形状由 `protocol/views` 固定。 */
export function queryView(db: DatabaseSync, view: ViewId, params?: unknown): unknown {
  if (!(VIEW_IDS as readonly string[]).includes(view)) {
    throw new StoreError('invalid_input', `未知视图: ${String(view)}`)
  }
  switch (view) {
    case 'workflows.all':
      return readWorkflowsWithStages(db)
    case 'agents.all':
      return readAgents(db)
    case 'runtimes.all':
      return readRuntimes(db)
    case 'tasks.byWorkflow':
      return readTasksByWorkflow(db, readStringParam(params, 'workflowId'))
    case 'task.byId':
      return readTask(db, readStringParam(params, 'taskId'))
    case 'runs.active-by-task':
      return readActiveRuns(db, readStringParam(params, 'taskId'))
  }
}
