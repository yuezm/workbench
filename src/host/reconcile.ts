/**
 * 启动对账（M2 T13）：崩溃后把「上一次运行留下的子进程与 run 状态」收干净。
 *
 * 顺序（先杀后记账）：
 * 1. 读 `process_registry`（宿主私有表，崩溃时会残留行）；
 * 2. 对**仍在执行中**的 run 的 pid 逐个 `killPidTree`（进程树整棵终止）；
 * 3. 清表——已终态 / run 已删的残留行只清理、不按 pid 杀（进程早就退了，pid 可能被
 *    系统复用，误杀比漏杀更糟；D11）；
 * 4. `dispatch({type:'clock.tick'})`：超租约的 running → `run.abandoned`（退避重排或
 *    达到 `maxAttempts` 落 `run.failed{executor_lost}`），超过 `deadlineAt` → `run.failed{timeout}`。
 *
 * 启动阶段在 `scheduler.wake()` 之前调用：此刻本机没有在跑的 run，所以「registry 里的
 * 行」只可能是上次崩溃的残留。聊天中断的消息由 T14 接管（本任务不做）。
 *
 * 不做定时对账的调度：周期回收由 `host/clock.ts` 的 `nextWakeAt` + `clock.tick` 处理
 * （`deadlineAt` / `leaseUntil` 是投影里的时刻，定时器自己会醒）。
 */
import type { RunStatus } from '../protocol/entities'
import { killPidTree } from './process'
import type { ProcessRegistry } from './process-registry'
import type { DispatchResult } from './store/index'

/** 有子进程的 run 状态：只有这两种才需要按 pid 终止进程树。 */
const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['running', 'waiting']

export interface ReconcileDeps {
  /** 宿主私有进程登记表（与 scheduler 共用同一实例） */
  registry: Pick<ProcessRegistry, 'list' | 'clear'>
  /** 统一写入口（装配根传 `effects.dispatch`）；启动阶段没有 UI 订阅者也无妨 */
  dispatch: (input: unknown) => DispatchResult
  /** 读 run 当前状态（投影里没有该 run 时返回 null） */
  runStatus: (runId: string) => RunStatus | null
  /** 进程树终止；默认 `killPidTree`（Windows taskkill /T /F、POSIX 进程组 SIGKILL） */
  killPid?: (pid: number) => boolean
}

export interface ReconcileSummary {
  /** 实际发起终止的进程树数量 */
  killed: number
  /** 清掉的残留登记行数量（含只清理不杀的） */
  cleared: number
  /** `clock.tick` 产出的事实数量（回收的 run 数） */
  facts: number
}

export function reconcile(deps: ReconcileDeps): ReconcileSummary {
  const killPid = deps.killPid ?? killPidTree
  const rows = deps.registry.list()

  let killed = 0
  for (const row of rows) {
    if (row.pid === null) continue
    const status = deps.runStatus(row.runId)
    // 已终态 / run 已删：只清行。不能按 pid 杀——pid 可能已被系统复用给无关进程。
    if (status === null || !ACTIVE_RUN_STATUSES.includes(status)) continue
    if (killPid(row.pid)) killed += 1
  }
  deps.registry.clear()

  const facts = deps.dispatch({ type: 'clock.tick' }).facts
  return { killed, cleared: rows.length, facts: facts.length }
}
