/**
 * 投影变更落库：`Change.row` ↔ 五张投影表的 snake_case 列，逐列显式映射
 * （不 `SELECT *`、不猜列名）；五表主键都是 `id`，`row === null` 表示删除。
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
import type { Agent, Runtime, Task, Workflow, WorkflowStage } from '../../protocol/entities'
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
   * 清空白名单五表。
   *
   * 只能在 `PRAGMA foreign_keys = OFF` 的重建事务里调用：`runs.task_id` 是
   * `ON DELETE CASCADE`，外键开启时清 `tasks` 会连带删掉运行记录与 `run_events`。
   */
  clear(): void
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
         (id, name, protocol_family, command, profile, permission_mode, model, reasoning_effort,
          workdir, max_concurrent, enabled, last_probe_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         protocol_family = excluded.protocol_family,
         command = excluded.command,
         profile = excluded.profile,
         permission_mode = excluded.permission_mode,
         model = excluded.model,
         reasoning_effort = excluded.reasoning_effort,
         workdir = excluded.workdir,
         max_concurrent = excluded.max_concurrent,
         enabled = excluded.enabled,
         last_probe_json = excluded.last_probe_json,
         created_at = excluded.created_at`,
    ),
  }

  const deletes = {
    tasks: db.prepare('DELETE FROM tasks WHERE id = ?'),
    workflows: db.prepare('DELETE FROM workflows WHERE id = ?'),
    workflow_stages: db.prepare('DELETE FROM workflow_stages WHERE id = ?'),
    agents: db.prepare('DELETE FROM agents WHERE id = ?'),
    runtimes: db.prepare('DELETE FROM runtimes WHERE id = ?'),
  }

  const clearAll = {
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
      const runtime = row as Runtime
      upserts.runtimes.run(
        runtime.id,
        runtime.name,
        runtime.protocolFamily,
        runtime.command,
        runtime.profile,
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
    // 顺序按外键依赖倒序（任务 → 阶段 → 工作流 → 智能体 → 运行时）；重建事务关了外键，顺序只为可读。
    clearAll.tasks.run()
    clearAll.workflow_stages.run()
    clearAll.workflows.run()
    clearAll.agents.run()
    clearAll.runtimes.run()
  }

  return { apply, applyAll, clear }
}
