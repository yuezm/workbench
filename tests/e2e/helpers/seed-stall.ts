/**
 * 停机卡 e2e 的种子夹具：造一张「run 已经结束、卡还开着」的卡片。
 *
 * 为什么需要这种卡：`closeCardsOnFinish` 会在 run 落终态时收掉还 open 的卡，唯独
 * `kind='stall'`（停机卡）留着——它问的是「你来不来接手」，与 run 是否结束无关
 * （`scopes/cards.ts`）。于是「删任务 / 删线程」这条路上不会有 `card.resolved`，
 * 卡片行只能随 `run.removed` 的投影级联消失。
 *
 * 造法全走真实内核，不手写事实：
 * 1. 建运行时 / 智能体 / 两阶段工作流（执行 = agent 入口，收尾 = none）；
 * 2. 在建「执行」阶段的任务，`task.create` 的进入效果产 `run.queued`，`run.claim` 领成 running；
 * 3. `run.receipt{status:'failed'}` 让这一轮失败落终态，任务停在「执行」阶段、没有活跃 run；
 * 4. 时钟推进 11 分钟（静默阈值 10 分钟 + 1）后 `clock.tick`：静默哨兵收成阶段错误，
 *    任务进「已阻塞」并开一张 `kind='stall'` 的卡；
 * 5. 运行时停用，应用起来后不会被调度器再领活。
 *
 * 时钟用注入的 `now`：种子自己推进时间，不 sleep、不等真时钟。
 */
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '@workbench/host-store/db'
import { createStore } from '@workbench/host-store/index'
import { decide } from '@workbench/kernel/decide'
import { nextWakeAt } from '@workbench/kernel/core/next-wake'
import { project } from '@workbench/kernel/scopes/project'
import { viewSpec } from '@workbench/kernel/scopes/view-spec'
import type { Fact, KernelPort } from '@workbench/kernel/core/types'
import type {
  Agent,
  Card,
  Project,
  RunRow,
  Runtime,
  Task,
  Workflow,
} from '@workbench/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

/**
 * 静默阈值（`STALL_SILENCE_MS` = 10 分钟）再多给一分钟。
 *
 * 阈值本身是产品常量，这里只负责「越过它」，不复制那个数字的判断逻辑。
 */
const STALL_GAP_MS = 11 * 60_000

export interface StallSeed {
  dbPath: string
  taskId: string
  /** 停机卡挂在的那一轮（已落终态的 run） */
  runId: string
  cardId: string
}

/** 只读复查：卡片行数（删任务后应为 0，用来证明「库里真没了、不是界面没刷新」）。 */
export function countCards(dbPath: string): number {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return (db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n
  } finally {
    db.close()
  }
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`停机种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

/** 建库 → 任务跑一轮失败 → 静默 11 分钟 → 静默哨兵开停机卡。 */
export async function seedStallState(dbPath: string): Promise<StallSeed> {
  const db = openDatabase(dbPath)
  /** 种子自己的时钟：每次 dispatch 读它，推进时间靠 `advance` */
  let clock = new Date().toISOString()
  const advance = (ms: number): void => {
    clock = new Date(Date.parse(clock) + ms).toISOString()
  }
  try {
    const store = createStore({ db, kernel, now: () => clock })

    const runtimeFacts = store.dispatch({
      type: 'runtime.create',
      commandId: 'e2e-stall-runtime',
      input: {
        name: 'e2e 停机运行时',
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
      commandId: 'e2e-stall-agent',
      input: {
        name: 'e2e 停机智能体',
        runtimeId: runtime.id,
        permissionMode: 'workspace-write',
        maxConcurrent: 1,
      },
    }).facts
    const agent = payloadOf<{ agent: Agent }>(agentFacts, 'agent.created', '智能体').agent

    const workflowFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-stall-workflow',
      input: {
        name: '停机流程',
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
    // M18：内置「待办」排在最前且不派活，任务要显式落「执行」才会入队
    const workflowView = store.query('workflows.all').find((row) => row.id === workflow.id)
    const execStage = workflowView?.stages.find((stage) => stage.name === '执行')
    if (execStage === undefined) throw new Error('停机种子缺少执行阶段')

    const projectFacts = store.dispatch({
      type: 'project.create',
      commandId: 'e2e-stall-project',
      input: { name: '停机项目', path: dbPath },
    }).facts
    const project = payloadOf<{ project: Project }>(projectFacts, 'project.created', '项目').project

    const taskFacts = store.dispatch({
      type: 'task.create',
      commandId: 'e2e-stall-task',
      input: {
        title: 'e2e 停机任务',
        workflowId: workflow.id,
        projectId: project.id,
        stageId: execStage.id,
      },
    }).facts
    const task = payloadOf<{ task: Task }>(taskFacts, 'task.created', '任务').task

    advance(60_000)
    const claimedFacts = store.dispatch({
      type: 'run.claim',
      runtimeId: runtime.id,
      capacity: 1,
    }).facts
    const claimed = payloadOf<{ run: RunRow }>(claimedFacts, 'run.claimed', '领取').run

    // 这一轮失败落终态：任务停在「执行」阶段，没有活跃 run —— 静默哨兵的两条前提之一
    store.dispatch({
      type: 'run.receipt',
      runId: claimed.id,
      receipt: {
        status: 'failed',
        leaseId: claimed.leaseId,
        turn: claimed.turn,
        errorCode: 'run_failed',
        error: 'e2e 种子：造一个停住的阶段',
      },
    })
    // 停用运行时：应用起来后调度器不会给这个阶段再领活，断言窗口内状态稳定
    store.dispatch({
      type: 'runtime.update',
      commandId: 'e2e-stall-disable-runtime',
      id: runtime.id,
      patch: { enabled: false },
    })

    advance(STALL_GAP_MS)
    const sweepFacts = store.dispatch({ type: 'clock.tick' }).facts
    const card = payloadOf<{ card: Card }>(sweepFacts, 'card.opened', '停机卡').card
    if (card.kind !== 'stall') throw new Error(`停机种子：卡片类型不是 stall（${card.kind}）`)
    if (card.status !== 'open') throw new Error(`停机种子：卡片不是 open（${card.status}）`)

    return { dbPath, taskId: task.id, runId: claimed.id, cardId: card.id }
  } finally {
    db.close()
  }
}
