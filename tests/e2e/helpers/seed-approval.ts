/**
 * M4 审批 E2E 的种子夹具（纯 Node，不碰 Electron）：
 *
 * 1. 用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里建库；
 * 2. 种运行时 / 智能体 / 两阶段工作流 / 任务，`task.create` 的进入效果产 `run.queued`，
 *    再 `run.claim` 领成 `running`（拿到 leaseId / turn）；
 * 3. `run.receipt{ask}` 让 run 进入 `waiting` 并开一张 `delivery='pending'` 的卡；
 * 4. 把运行时置为停用：回答后续接的 `run.queued` 不会被调度器领取，e2e 能稳定断言
 *    「续接已入队、尚未执行」；等待期本身也不会有任何子进程；
 * 5. 不写 `process_registry`——「等待期无子进程」的断言基线就是空表。
 *
 * 返回 id 与只读复查函数所需的键；所有断言都从库文件读，应用运行中亦可（WAL + busy_timeout）。
 */
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../../src/host/db'
import { createStore } from '../../../src/host/store/index'
import { decide } from '../../../src/kernel/decide'
import { nextWakeAt } from '../../../src/kernel/core/next-wake'
import { project } from '../../../src/kernel/scopes/project'
import type { Fact, KernelPort } from '../../../src/kernel/core/types'
import { viewSpec } from '../../../src/kernel/scopes/view-spec'
import type {
  Agent,
  Card,
  Project,
  RunRow,
  Runtime,
  Task,
  Workflow,
} from '../../../src/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

/** 会话 id：回答续接后 `resume_session_id` 必须与它一致。 */
export const APPROVAL_SESSION_ID = 'sess-e2e-approval'

export interface ApprovalSeed {
  dbPath: string
  runtimeId: string
  taskId: string
  runId: string
  cardId: string
  /** 等待期在库里已有的 run_events 行数（应为 0） */
  runEvents: number
}

/** 只读复查：runs / cards / process_registry / run_events / facts 的关键列。 */
export interface ApprovalState {
  runStatus: string | null
  leaseId: string | null
  leaseUntil: string | null
  deadlineAt: string | null
  usageJson: string | null
  turn: number | null
  sessionId: string | null
  resumeSessionId: string | null
  cardStatus: string | null
  cardDelivery: string | null
  cardDeliveryRef: string | null
  cardOptionIndex: number | null
  cardAnsweredBy: string | null
  processRegistryRows: number
  runEvents: number
  facts: number
  /** `card.answered` 事实条数（重复回答断言用） */
  answeredFacts: number
  /** `run.queued` 事实条数（重复回答断言用） */
  queuedFacts: number
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`审批种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

/** 建库 → 种配置/任务 → 领取 run → 回执带 ask → 等待态 + open 卡。 */
export async function seedApprovalState(dbPath: string): Promise<ApprovalSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const runtimeFacts = store.dispatch({
      type: 'runtime.create',
      commandId: 'e2e-approval-runtime',
      input: {
        name: 'e2e 审批运行时',
        executorKey: 'dsh',
        command: process.execPath,
        profile: 'multica',
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
      commandId: 'e2e-approval-agent',
      input: {
        name: 'e2e 审批智能体',
        runtimeId: runtime.id,
        permissionMode: 'workspace-write',
        maxConcurrent: 1,
      },
    }).facts
    const agent = payloadOf<{ agent: Agent }>(agentFacts, 'agent.created', '智能体').agent

    const workflowFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-approval-workflow',
      input: {
        name: '审批流程',
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
    // M18：内置「待办」是最前一个阶段（不派活），任务要显式落 `执行` 才会入队
    const workflowView = store.query('workflows.all').find((row) => row.id === workflow.id)
    const execStage = workflowView?.stages.find((stage) => stage.name === '执行')
    if (execStage === undefined) throw new Error('审批种子缺少执行阶段')

    // M10：任务必须挂在项目下（项目文件夹就是本轮工作目录）。
    const projectFacts = store.dispatch({
      type: 'project.create',
      commandId: 'e2e-approval-project',
      input: { name: '审批项目', path: dbPath },
    }).facts
    const project = payloadOf<{ project: Project }>(projectFacts, 'project.created', '项目').project

    const taskFacts = store.dispatch({
      type: 'task.create',
      commandId: 'e2e-approval-task',
      input: {
        title: '审批任务',
        workflowId: workflow.id,
        projectId: project.id,
        stageId: execStage.id,
      },
    }).facts
    const task = payloadOf<{ task: Task }>(taskFacts, 'task.created', '任务').task

    // 进入效果已经产了 run.queued；这里把它领成 running，拿到本轮 leaseId / turn。
    const claimedFacts = store.dispatch({
      type: 'run.claim',
      runtimeId: runtime.id,
      capacity: 1,
    }).facts
    const claimed = payloadOf<{ run: RunRow }>(claimedFacts, 'run.claimed', '领取').run

    // 回执带 ask：run 进入 waiting，内核按 ask 开卡（delivery='pending'）。
    const receiptFacts = store.dispatch({
      type: 'run.receipt',
      runId: claimed.id,
      receipt: {
        status: 'succeeded',
        leaseId: claimed.leaseId,
        turn: claimed.turn,
        sessionId: APPROVAL_SESSION_ID,
        ask: [
          {
            title: '审批：是否继续？',
            text: '这是等待期零进程用例的卡片',
            options: ['继续', '停止'],
            key: 'approval-e2e',
          },
        ],
      },
    }).facts
    const waiting = payloadOf<{ run: RunRow; cardIds: string[] }>(
      receiptFacts,
      'run.waiting',
      '等待',
    )
    const card = payloadOf<{ card: Card }>(receiptFacts, 'card.opened', '卡片').card
    if (waiting.run.status !== 'waiting') throw new Error('审批种子：run 未进入 waiting')
    if (card.delivery !== 'pending') throw new Error('审批种子：卡片初始投递状态不是 pending')

    // 停用运行时：回答续接的 run.queued 留在队列里（不被调度器领取），断言可稳定复现。
    // `run.claim` 只要求领取时启用；停用不影响既有 waiting run 与 `card.answer`。
    store.dispatch({
      type: 'runtime.update',
      commandId: 'e2e-approval-disable-runtime',
      id: runtime.id,
      patch: { enabled: false },
    })

    const runEvents = (
      db.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?').get(claimed.id) as {
        n: number
      }
    ).n

    return {
      dbPath,
      runtimeId: runtime.id,
      taskId: task.id,
      runId: waiting.run.id,
      cardId: card.id,
      runEvents,
    }
  } finally {
    db.close()
  }
}

/** 只读复查（应用运行中也可读）：run / card / 进程登记 / 帧 / 事实计数。 */
export function readApprovalState(dbPath: string, runId: string, cardId: string): ApprovalState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const run = db
      .prepare(
        `SELECT status, lease_id, lease_until, deadline_at, usage_json, turn, session_id,
                resume_session_id
         FROM runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          status: string
          lease_id: string | null
          lease_until: string | null
          deadline_at: string | null
          usage_json: string | null
          turn: number
          session_id: string | null
          resume_session_id: string | null
        }
      | undefined
    const card = db
      .prepare(
        `SELECT status, delivery, delivery_ref, option_index, answered_by
         FROM cards WHERE id = ?`,
      )
      .get(cardId) as
      | {
          status: string
          delivery: string
          delivery_ref: string | null
          option_index: number | null
          answered_by: string | null
        }
      | undefined
    const registry = db.prepare('SELECT COUNT(*) AS n FROM process_registry').get() as {
      n: number
    }
    const events = db
      .prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
      .get(runId) as {
      n: number
    }
    const facts = db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }
    const answeredFacts = db
      .prepare("SELECT COUNT(*) AS n FROM facts WHERE type = 'card.answered'")
      .get() as { n: number }
    const queuedFacts = db
      .prepare("SELECT COUNT(*) AS n FROM facts WHERE type = 'run.queued'")
      .get() as { n: number }
    return {
      runStatus: run?.status ?? null,
      leaseId: run?.lease_id ?? null,
      leaseUntil: run?.lease_until ?? null,
      deadlineAt: run?.deadline_at ?? null,
      usageJson: run?.usage_json ?? null,
      turn: run?.turn ?? null,
      sessionId: run?.session_id ?? null,
      resumeSessionId: run?.resume_session_id ?? null,
      cardStatus: card?.status ?? null,
      cardDelivery: card?.delivery ?? null,
      cardDeliveryRef: card?.delivery_ref ?? null,
      cardOptionIndex: card?.option_index ?? null,
      cardAnsweredBy: card?.answered_by ?? null,
      processRegistryRows: registry.n,
      runEvents: events.n,
      facts: facts.n,
      answeredFacts: answeredFacts.n,
      queuedFacts: queuedFacts.n,
    }
  } finally {
    db.close()
  }
}
