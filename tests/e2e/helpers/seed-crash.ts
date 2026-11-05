/**
 * 崩溃恢复 E2E 的种子夹具（纯 Node，不碰 Electron）：
 *
 * 1. 用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里建库；
 * 2. 种运行时 / 智能体 / 两阶段工作流 / 任务，`task.create` 的进入效果产 `run.queued`，
 *    `run.claim` 把它领成 `running`（拿固定 leaseId）；
 * 3. 起一个可控 node 长睡子进程，pid 写进 `process_registry`（模拟上次崩溃残留）；
 * 4. 把 run 的 `lease_until` 改到过去、`attempts` 提到上限（模拟「崩溃很久之后重启」），
 *    启动对账的 `clock.tick` 会把它落成 `failed{executor_lost}`，任务不再被判执行中。
 *
 * 返回的 pid / runId / taskId / 目标阶段 id 供 spec 断言与拖动；`cleanup` 保证失败时
 * 不留下孤儿进程。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../../src/host/db'
import { createProcessRegistry } from '../../../src/host/process-registry'
import { createStore } from '../../../src/host/store/index'
import { decide } from '../../../src/kernel/decide'
import { nextWakeAt } from '../../../src/kernel/next-wake'
import { project } from '../../../src/kernel/project'
import type { KernelPort } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import type {
  Agent,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../../src/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

export interface CrashSeed {
  /** 种子库路径（供启动后的投影断言） */
  dbPath: string
  taskId: string
  /** 任务当前阶段（agent 入口）与该阶段 id */
  stageId: string
  /** 拖动目标阶段（entryMode='none'，拖过去不会再产 run） */
  targetStageId: string
  runId: string
  /** 上次崩溃残留的子进程 pid（启动对账应把它杀掉） */
  pid: number
  /** 失败兜底：进程还活着就直接 kill，避免污染后续用例 */
  cleanup: () => void
}

/** 上一次启动留下的 running / waiting run 与残留登记行（启动对账应清干净）。 */
export interface RecoveryState {
  runStatus: string | null
  runningRuns: number
  registryRows: number
}

const pastIso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()

/** 长睡子进程：不占 CPU，等对账按 pid 强杀。 */
async function spawnSleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  return child
}

/** 建库 → 种配置/任务 → 领取 run → 写进程登记 → 造「过期租约、已达重试上限」。 */
export async function seedCrashState(dbPath: string): Promise<CrashSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const runtimeFacts = store.dispatch({
      type: 'runtime.create',
      commandId: 'e2e-seed-runtime',
      input: {
        name: 'e2e 运行时',
        executorKey: 'dsh',
        command: process.execPath,
        profile: 'multica',
        permissionMode: 'workspace-write',
        maxConcurrent: 1,
        enabled: true,
      },
    }).facts
    const runtime = (
      runtimeFacts.find((fact) => fact.type === 'runtime.created')?.payload as {
        runtime: Runtime
      }
    ).runtime

    const agentFacts = store.dispatch({
      type: 'agent.create',
      commandId: 'e2e-seed-agent',
      input: { name: 'e2e 智能体', runtimeId: runtime.id },
    }).facts
    const agent = (
      agentFacts.find((fact) => fact.type === 'agent.created')?.payload as {
        agent: Agent
      }
    ).agent

    const workflowFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-seed-workflow',
      input: {
        name: '崩溃恢复流程',
        stages: [
          { name: '执行', entryMode: 'agent', agentId: agent.id },
          { name: '待办', entryMode: 'none' },
        ],
      },
    }).facts
    const workflow = (
      workflowFacts.find((fact) => fact.type === 'workflow.created')?.payload as {
        workflow: Workflow
      }
    ).workflow
    const stages = workflowFacts
      .filter((fact) => fact.type === 'stage.created')
      .map((fact) => (fact.payload as { stage: WorkflowStage }).stage)
      .sort((left, right) => left.position - right.position)

    const taskFacts = store.dispatch({
      type: 'task.create',
      commandId: 'e2e-seed-task',
      input: { title: '崩溃恢复任务', workflowId: workflow.id },
    }).facts
    const task = (
      taskFacts.find((fact) => fact.type === 'task.created')?.payload as {
        task: Task
      }
    ).task

    // 进入效果已经产了 run.queued；这里把它领成 running，并留下有效 leaseId
    const claimedFacts = store.dispatch({
      type: 'run.claim',
      runtimeId: runtime.id,
      capacity: 1,
    }).facts
    const run = (
      claimedFacts.find((fact) => fact.type === 'run.claimed')?.payload as {
        run: RunRow
      }
    ).run

    const child = await spawnSleeper()
    if (child.pid === undefined) throw new Error('崩溃恢复种子：子进程没有 pid')
    const registry = createProcessRegistry(db)
    registry.begin(run.id, new Date().toISOString())
    registry.attachPid(run.id, child.pid)

    // 模拟「崩溃很久之后重启」：租约已过期，且重试次数已到上限 → clock.tick 落 failed，
    // 不再回 queued（否则任务仍被判「执行中」，拖动会被内核拒绝）。
    db.prepare('UPDATE runs SET attempt = 3, attempts = 3, lease_until = ? WHERE id = ?').run(
      pastIso(60_000),
      run.id,
    )

    const pid = child.pid
    return {
      dbPath,
      taskId: task.id,
      stageId: stages[0].id,
      targetStageId: stages[1].id,
      runId: run.id,
      pid,
      cleanup: () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // 已经退出：无需再杀
          }
        }
      },
    }
  } finally {
    db.close()
  }
}

/** 只读复查：run 状态、残留 running 数、process_registry 行数（应用运行中也可读）。 */
export function readRecoveryState(dbPath: string, runId: string): RecoveryState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as
      { status: string } | undefined
    const running = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get() as {
      n: number
    }
    const registry = db.prepare('SELECT COUNT(*) AS n FROM process_registry').get() as {
      n: number
    }
    return {
      runStatus: run?.status ?? null,
      runningRuns: running.n,
      registryRows: registry.n,
    }
  } finally {
    db.close()
  }
}

/** pid 是否还活着（进程已退出时返回 false）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
