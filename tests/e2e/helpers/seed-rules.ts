/**
 * M6 规则 E2E 的种子夹具（纯 Node，不碰 Electron）：
 *
 * 1. 用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里建库；
 * 2. 种运行时 / 智能体 / 两阶段工作流（首阶段 `entryMode='agent'`，规则任务进入即产 run）；
 * 3. **不种规则**——规则由 e2e 走 UI 保存（`rules.replace` 落事实/投影）；
 * 4. 运行时种下后立即停用：规则任务进入 agent 阶段产生的 `run.queued` 不会被调度器领取，
 *    断言可稳定停在「已入队、未执行」，也不会起任何子进程。
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
import type { Agent, Runtime, Workflow } from '../../../src/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

export interface RulesSeed {
  dbPath: string
  workflowId: string
  workflowName: string
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`规则种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

/** 建库 → 种配置（运行时停用）→ 返回规则页要选的工作流。 */
export async function seedRulesBase(dbPath: string): Promise<RulesSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const runtimeFacts = store.dispatch({
      type: 'runtime.create',
      commandId: 'e2e-rules-runtime',
      input: {
        name: 'e2e 规则运行时',
        executorKey: 'dsh',
        command: process.execPath,
        profile: 'multica',
        permissionMode: 'workspace-write',
        maxConcurrent: 1,
        enabled: true,
      },
    }).facts
    const runtime = payloadOf<{ runtime: Runtime }>(
      runtimeFacts,
      'runtime.created',
      '运行时',
    ).runtime

    const agentFacts = store.dispatch({
      type: 'agent.create',
      commandId: 'e2e-rules-agent',
      input: { name: 'e2e 规则智能体', runtimeId: runtime.id },
    }).facts
    const agent = payloadOf<{ agent: Agent }>(agentFacts, 'agent.created', '智能体').agent

    const workflowName = 'e2e 规则流程'
    const workflowFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-rules-workflow',
      input: {
        name: workflowName,
        stages: [
          { name: '执行', entryMode: 'agent', agentId: agent.id },
          { name: '收尾', entryMode: 'none' },
        ],
      },
    }).facts
    const workflow = payloadOf<{ workflow: Workflow }>(
      workflowFacts,
      'workflow.created',
      '工作流',
    ).workflow

    // M10：任务必须挂在项目下。种一个项目，规则表单默认选中它，看板才看得到规则任务。
    store.dispatch({
      type: 'project.create',
      commandId: 'e2e-rules-project',
      input: { name: 'e2e 规则项目', path: dbPath },
    })

    // 停用运行时：规则任务产出的 run.queued 留在队列里，e2e 可稳定断言且不起子进程。
    store.dispatch({
      type: 'runtime.update',
      commandId: 'e2e-rules-disable-runtime',
      id: runtime.id,
      patch: { enabled: false },
    })

    return { dbPath, workflowId: workflow.id, workflowName }
  } finally {
    db.close()
  }
}

/** 规则建任务后的关键列（tasks / facts / runs）。 */
export interface RuleTaskState {
  taskCount: number
  taskTitle: string | null
  origin: string | null
  ruleId: string | null
  externalRef: string | null
  taskCreatedFacts: number
  queuedRuns: number
  runRuleId: string | null
}

/** 只读复查（应用运行中也可读）：目标工作流的任务 + 规则事实 + 排队 run。 */
export function readRuleTaskState(dbPath: string, workflowId: string): RuleTaskState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const task = db
      .prepare(
        `SELECT id, title, origin, rule_id, external_ref
         FROM tasks WHERE workflow_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get(workflowId) as
      | {
          id: string
          title: string
          origin: string
          rule_id: string | null
          external_ref: string | null
        }
      | undefined
    const taskCount = (
      db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?').get(workflowId) as {
        n: number
      }
    ).n
    const taskCreatedFacts = (
      db.prepare("SELECT COUNT(*) AS n FROM facts WHERE type = 'task.created'").get() as {
        n: number
      }
    ).n
    const queued = db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs
         WHERE status = 'queued' AND task_id IN (SELECT id FROM tasks WHERE workflow_id = ?)`,
      )
      .get(workflowId) as { n: number }
    const run = task
      ? (db.prepare('SELECT rule_id FROM runs WHERE task_id = ? LIMIT 1').get(task.id) as
          { rule_id: string | null } | undefined)
      : undefined
    return {
      taskCount,
      taskTitle: task?.title ?? null,
      origin: task?.origin ?? null,
      ruleId: task?.rule_id ?? null,
      externalRef: task?.external_ref ?? null,
      taskCreatedFacts,
      queuedRuns: queued.n,
      runRuleId: run?.rule_id ?? null,
    }
  } finally {
    db.close()
  }
}
