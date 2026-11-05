/**
 * 启动对账（M2 T13）：崩溃后把「上一次运行留下的子进程与 run 状态」收干净。
 *
 * 顺序（先杀后记账）：
 * 1. 读 `process_registry`（宿主私有表，崩溃时会残留行）；
 * 2. 对**仍在执行中**的 run 的 pid 逐个 `killPidTree`（进程树整棵终止）；
 * 3. 清表——已终态 / run 已删的残留行只清理、不按 pid 杀（进程早就退了，pid 可能被
 *    系统复用，误杀比漏杀更糟；D11）；
 * 4. `dispatch({type:'clock.tick'})`：超租约的 running → `run.abandoned`（退避重排或
 *    达到 `maxAttempts` 落 `run.failed{executor_lost}`），超过 `deadlineAt` → `run.failed{timeout}`；
 * 5. 「waiting 且无 open 卡」的 run 兜底 `run.host_settled{cancelled}`（M4 D13）：重建后
 *    历史的 waiting run 没有对应 `card.*` 事实，无卡可答，补取消避免永久「执行中」；
 *    有 open 卡的 waiting 保持等待，不动。
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

/** 启动对账要检查的 waiting run：`hasOpenCard` 由读路径按 `cards` join 得出。 */
export interface WaitingRunState {
  id: string
  leaseId: string | null
  turn: number
  /** 该 run 是否还有 `status='open'` 的卡片（有卡说明有人可答，不能兜底取消） */
  hasOpenCard: boolean
}

export interface ReconcileDeps {
  /** 宿主私有进程登记表（与 scheduler 共用同一实例） */
  registry: Pick<ProcessRegistry, 'list' | 'clear'>
  /** 统一写入口（装配根传 `effects.dispatch`）；启动阶段没有 UI 订阅者也无妨 */
  dispatch: (input: unknown) => DispatchResult
  /** 读 run 当前状态（投影里没有该 run 时返回 null） */
  runStatus: (runId: string) => RunStatus | null
  /**
   * 崩溃时正在跑的聊天 run（`purpose='chat'` + `running`）：宿主兜底写
   * `run.host_settled{failed, executor_lost}`，内核据此产一条错误 assistant 消息（T14b）。
   * 阶段 run 不走这里——它们按租约/超时走 `clock.tick` 的 abandoned 退避（D3）。
   */
  staleChatRuns?: () => ReadonlyArray<{ id: string; leaseId: string | null; turn: number }>
  /**
   * 启动时仍在 `waiting` 的 run 及其卡片状态（M4 D13）：没有 open 卡的一律兜底取消。
   * 过滤（`waiting` + 按 `run_id` join `cards`）由调用方的读路径完成，reconcile 不查库；
   * 未注入时不做这项兜底（装配根接线前保持原有对账语义）。
   */
  waitingRuns?: () => ReadonlyArray<WaitingRunState>
  /** 进程树终止；默认 `killPidTree`（Windows taskkill /T /F、POSIX 进程组 SIGKILL） */
  killPid?: (pid: number) => boolean
}

export interface ReconcileSummary {
  /** 实际发起终止的进程树数量 */
  killed: number
  /** 清掉的残留登记行数量（含只清理不杀的） */
  cleared: number
  /** 兜底落终态的中断聊天 run 数量 */
  settledChats: number
  /** 兜底取消的「无 open 卡」waiting run 数量（M4 D13） */
  settledWaitings: number
  /** `clock.tick` 产出的事实数量（回收的 run 数） */
  facts: number
}

/** 无卡 waiting run 的取消文案：写明卡片缺失，便于用户与 why 链理解。 */
const MISSING_CARD_ERROR = '等待中的卡片缺失，已取消（重建后无对应卡片）'

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

  // 中断的聊天轮次：先落失败终态（内核会补一条错误 assistant 消息），
  // 再让 clock.tick 只处理阶段 run 的租约/超时回收
  let settledChats = 0
  for (const run of deps.staleChatRuns?.() ?? []) {
    const facts = deps.dispatch({
      type: 'run.host_settled',
      runId: run.id,
      leaseId: run.leaseId ?? undefined,
      turn: run.turn,
      status: 'failed',
      errorCode: 'executor_lost',
      error: '应用中断，本轮已结束',
    }).facts
    if (facts.length > 0) settledChats += 1
  }

  // 无卡可答的 waiting run：重建后的历史挂起态没有对应 card.* 事实，
  // 由宿主兜底取消（D13），否则看板会永久显示「执行中」；有 open 卡的保持等待。
  let settledWaitings = 0
  for (const run of deps.waitingRuns?.() ?? []) {
    if (run.hasOpenCard) continue
    const settled = deps.dispatch({
      type: 'run.host_settled',
      runId: run.id,
      leaseId: run.leaseId ?? undefined,
      turn: run.turn,
      status: 'cancelled',
      errorCode: 'cancelled',
      error: MISSING_CARD_ERROR,
    }).facts
    if (settled.length > 0) settledWaitings += 1
  }

  const facts = deps.dispatch({ type: 'clock.tick' }).facts
  return { killed, cleared: rows.length, settledChats, settledWaitings, facts: facts.length }
}
