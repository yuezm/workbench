/**
 * M41「新建任务可选工作流」的 E2E 种子：两条互不相干的工作流 + 一个项目。
 *
 * 为什么不复用 `seedRulesBase`：它只造一条工作流，而看板默认停在 `workflows[0]`
 * （顺序由 `useEntityOrder` 的渲染层偏好决定，未登记按视图顺序）。往那个夹具里多塞
 * 一条工作流会让一批既有用例的默认看板漂移，所以这里单独建库，只给「弹窗换工作流」用。
 *
 * 阶段全用 `entryMode='none'`：用例只关心任务落在哪条流程的哪一列，不需要运行时与
 * 智能体，也就不起任何子进程。四个内置阶段（待办 / 已阻塞 / 已完成 / 已取消）由内核
 * 自动补齐，种子只提交自己添加的阶段。
 */
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '@workbench/host-store/db'
import { createStore } from '@workbench/host-store/index'
import { decide } from '@workbench/kernel/decide'
import { nextWakeAt } from '@workbench/kernel/core/next-wake'
import { project } from '@workbench/kernel/scopes/project'
import type { Fact, KernelPort } from '@workbench/kernel/core/types'
import { viewSpec } from '@workbench/kernel/scopes/view-spec'
import type { Workflow } from '@workbench/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

export interface TwoWorkflowsSeed {
  dbPath: string
  firstWorkflowId: string
  firstWorkflowName: string
  secondWorkflowId: string
  secondWorkflowName: string
  /** 第二条工作流里的中间用户阶段（弹窗里选它当起始阶段） */
  secondUserStageName: string
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`新建任务种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

/** 建库 → 种项目 + 两条工作流 → 返回弹窗里要选的那条工作流。 */
export async function seedTwoWorkflows(dbPath: string): Promise<TwoWorkflowsSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const createWorkflow = (commandId: string, name: string, stages: string[]): Workflow => {
      const facts = store.dispatch({
        type: 'workflow.create',
        commandId,
        input: {
          name,
          stages: stages.map((stageName) => ({ name: stageName, entryMode: 'none' as const })),
        },
      }).facts
      return payloadOf<{ workflow: Workflow }>(facts, 'workflow.created', name).workflow
    }

    const firstWorkflowName = '交付流程'
    const first = createWorkflow('e2e-newtask-wf-first', firstWorkflowName, ['方案', '实施'])

    const secondWorkflowName = '缺陷流程'
    const secondUserStageName = '修复'
    const second = createWorkflow('e2e-newtask-wf-second', secondWorkflowName, [
      '报告',
      secondUserStageName,
      '回归',
    ])

    // 任务必须挂在项目下（M10），否则看板只看「默认目录」那一批
    store.dispatch({
      type: 'project.create',
      commandId: 'e2e-newtask-project',
      input: { name: 'e2e 投递项目', path: dbPath },
    })

    return {
      dbPath,
      firstWorkflowId: first.id,
      firstWorkflowName,
      secondWorkflowId: second.id,
      secondWorkflowName,
      secondUserStageName,
    }
  } finally {
    db.close()
  }
}

/** 建完任务后复查它到底落在哪条工作流的哪个阶段（只读，应用运行中也可读）。 */
export interface TaskPlacement {
  workflowName: string
  stageName: string
  description: string
}

export function readTaskPlacement(dbPath: string, title: string): TaskPlacement | null {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db
      .prepare(
        `SELECT w.name AS workflowName, s.name AS stageName, t.description AS description
         FROM tasks t
         JOIN workflows w ON w.id = t.workflow_id
         JOIN workflow_stages s ON s.id = t.current_stage_id
         WHERE t.title = ?`,
      )
      .get(title) as TaskPlacement | undefined
    return row ?? null
  } finally {
    db.close()
  }
}
