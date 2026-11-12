/**
 * M7 跨工作流交接 E2E 的种子夹具（纯 Node，不碰 Electron）：
 *
 * 1. 用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里建库；
 * 2. 种两个工作流：源工作流 A（首阶段 `entryMode='none'`，交接目标 = B）与 B（单阶段）；
 * 3. 在 A 首阶段建一条手工任务（不产 run：none 阶段）；
 * 4. e2e 在真实应用里 `task.complete`，断言 B 出现一条 `origin='handoff'` 的关联任务。
 *
 * 断言一律读临时 userData 里的库文件（应用运行中亦可，WAL + busy_timeout）。
 */
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../../src/host/db'
import { createStore } from '../../../src/host/store/index'
import { decide } from '../../../src/kernel/decide'
import { nextWakeAt } from '../../../src/kernel/next-wake'
import { project } from '../../../src/kernel/project'
import type { Fact, KernelPort } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import type { Project, Task, Workflow } from '../../../src/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

export interface HandoffSeed {
  dbPath: string
  sourceWorkflowId: string
  targetWorkflowId: string
  sourceTaskId: string
  sourceStageId: string
  targetStageId: string
  sourceTitle: string
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`交接种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

/** 建库 → 种两个工作流 + 源任务 → 返回交接断言需要的 id。 */
export async function seedHandoffBase(dbPath: string): Promise<HandoffSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const targetFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-handoff-target-workflow',
      input: {
        name: 'e2e 交接目标流程',
        stages: [{ name: '接收', entryMode: 'none' }],
      },
    }).facts
    const targetWorkflow = payloadOf<{ workflow: Workflow }>(
      targetFacts,
      'workflow.created',
      '目标工作流',
    ).workflow
    const targetView = store.query('workflows.all').find((row) => row.id === targetWorkflow.id)
    // M18：内置四阶段由系统补齐，这里取用户阶段（`builtin == null`）
    const targetStage = targetView?.stages.find((stage) => stage.builtin == null)
    if (targetStage === undefined) throw new Error('交接种子缺少目标阶段')

    const sourceTitle = 'e2e 交接源任务'
    const sourceFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-handoff-source-workflow',
      input: {
        name: 'e2e 交接源流程',
        stages: [
          {
            name: '完成',
            entryMode: 'none',
            handoffWorkflowId: targetWorkflow.id,
            handoffStageId: targetStage.id,
          },
          { name: '收尾', entryMode: 'none' },
        ],
      },
    }).facts
    const sourceWorkflow = payloadOf<{ workflow: Workflow }>(
      sourceFacts,
      'workflow.created',
      '源工作流',
    ).workflow
    const sourceView = store.query('workflows.all').find((row) => row.id === sourceWorkflow.id)
    const sourceStage = sourceView?.stages.find(
      (stage) => stage.builtin == null && stage.name === '完成',
    )
    if (sourceStage === undefined) throw new Error('交接种子缺少源阶段')

    // M10：任务必须挂在项目下（交接产物沿用来源任务的项目）。
    const projectFacts = store.dispatch({
      type: 'project.create',
      commandId: 'e2e-handoff-project',
      input: { name: '交接项目', path: dbPath },
    }).facts
    const project = payloadOf<{ project: Project }>(projectFacts, 'project.created', '项目').project

    const taskFacts = store.dispatch({
      type: 'task.create',
      commandId: 'e2e-handoff-source-task',
      input: {
        title: sourceTitle,
        workflowId: sourceWorkflow.id,
        projectId: project.id,
        stageId: sourceStage.id,
      },
    }).facts
    const task = payloadOf<{ task: Task }>(taskFacts, 'task.created', '源任务').task

    return {
      dbPath,
      sourceWorkflowId: sourceWorkflow.id,
      targetWorkflowId: targetWorkflow.id,
      sourceTaskId: task.id,
      sourceStageId: sourceStage.id,
      targetStageId: targetStage.id,
      sourceTitle,
    }
  } finally {
    db.close()
  }
}

/** 交接产物在库里的可见状态（应用运行中只读复查）。 */
export interface HandoffState {
  /** 目标工作流里的任务数 */
  targetTaskCount: number
  /** 目标工作流任务的关键列 */
  origin: string | null
  handoffFromTaskId: string | null
  handoffFromStageId: string | null
  handoffFromRunId: string | null
  title: string | null
  threadId: string | null
  threadSource: string | null
  /** 源任务状态 */
  sourceStatus: string | null
  /** `task.created` 事实总数（重复触发不应增加） */
  taskCreatedFacts: number
}

export function readHandoffState(dbPath: string, seed: HandoffSeed): HandoffState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db
      .prepare(
        `SELECT origin, handoff_from_task_id, handoff_from_stage_id, title, thread_id
         FROM tasks WHERE workflow_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get(seed.targetWorkflowId) as
      | {
          origin: string
          handoff_from_task_id: string | null
          handoff_from_stage_id: string | null
          title: string
          thread_id: string | null
        }
      | undefined
    const targetTaskCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?')
        .get(seed.targetWorkflowId) as { n: number }
    ).n
    const source = db.prepare('SELECT status FROM tasks WHERE id = ?').get(seed.sourceTaskId) as
      { status: string } | undefined
    const thread = row?.thread_id
      ? (db.prepare('SELECT source FROM threads WHERE id = ?').get(row.thread_id) as
          { source: string } | undefined)
      : undefined
    const factCount = (
      db.prepare("SELECT COUNT(*) AS n FROM facts WHERE type = 'task.created'").get() as {
        n: number
      }
    ).n
    return {
      targetTaskCount,
      origin: row?.origin ?? null,
      handoffFromTaskId: row?.handoff_from_task_id ?? null,
      handoffFromStageId: row?.handoff_from_stage_id ?? null,
      handoffFromRunId: null,
      title: row?.title ?? null,
      threadId: row?.thread_id ?? null,
      threadSource: thread?.source ?? null,
      sourceStatus: source?.status ?? null,
      taskCreatedFacts: factCount,
    }
  } finally {
    db.close()
  }
}
