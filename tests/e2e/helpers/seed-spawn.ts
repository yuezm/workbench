/**
 * M8 任务派生 E2E 的种子夹具（纯 Node，不碰 Electron）：
 *
 * 1. 用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里建库；
 * 2. 建一个两阶段工作流（均为 `none`，不启真 CLI），在首阶段建父任务；
 * 3. e2e 在真实应用里 `task.create` 带 `parentTaskId` 挂子任务，再完成子任务，
 *    断言父任务收到 rollup 通知（`none` 阶段降级为任务评论）。
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

export interface SpawnSeed {
  dbPath: string
  workflowId: string
  stageId: string
  /** M10：项目（子任务必须与父任务同项目） */
  projectId: string
  parentTaskId: string
  parentThreadId: string
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`派生种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

export async function seedSpawnBase(dbPath: string): Promise<SpawnSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const workflowFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-spawn-workflow',
      input: {
        name: 'e2e 派生流程',
        stages: [
          { name: '待办', entryMode: 'none' },
          { name: '完成', entryMode: 'none' },
        ],
      },
    }).facts
    const workflow = payloadOf<{ workflow: Workflow }>(
      workflowFacts,
      'workflow.created',
      '派生工作流',
    ).workflow
    const view = store.query('workflows.all').find((row) => row.id === workflow.id)
    const stage = view?.stages[0]
    if (stage === undefined) throw new Error('派生种子缺少阶段')

    // M10：任务必须挂在项目下（子任务继承父任务的项目）。
    const projectFacts = store.dispatch({
      type: 'project.create',
      commandId: 'e2e-spawn-project',
      input: { name: '派生项目', path: dbPath },
    }).facts
    const project = payloadOf<{ project: Project }>(projectFacts, 'project.created', '项目').project

    const taskFacts = store.dispatch({
      type: 'task.create',
      commandId: 'e2e-spawn-parent',
      input: {
        title: 'e2e 父任务',
        workflowId: workflow.id,
        projectId: project.id,
        stageId: stage.id,
      },
    }).facts
    const parent = payloadOf<{ task: Task }>(taskFacts, 'task.created', '父任务').task
    if (parent.threadId === null) throw new Error('派生种子：父任务没有线程')

    return {
      dbPath,
      workflowId: workflow.id,
      stageId: stage.id,
      projectId: project.id,
      parentTaskId: parent.id,
      parentThreadId: parent.threadId,
    }
  } finally {
    db.close()
  }
}

export interface SpawnState {
  childCount: number
  childParentId: string | null
  childThreadId: string | null
  childOrigin: string | null
  parentComment: string | null
}

export function readSpawnState(dbPath: string, seed: SpawnSeed): SpawnState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const child = db
      .prepare(
        `SELECT parent_task_id, thread_id, origin FROM tasks
         WHERE parent_task_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get(seed.parentTaskId) as
      { parent_task_id: string; thread_id: string | null; origin: string } | undefined
    const childCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?')
        .get(seed.parentTaskId) as { n: number }
    ).n
    const comment = db
      .prepare(
        `SELECT text FROM task_comments WHERE task_id = ? AND author = 'agent'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(seed.parentTaskId) as { text: string } | undefined
    return {
      childCount,
      childParentId: child?.parent_task_id ?? null,
      childThreadId: child?.thread_id ?? null,
      childOrigin: child?.origin ?? null,
      parentComment: comment?.text ?? null,
    }
  } finally {
    db.close()
  }
}
