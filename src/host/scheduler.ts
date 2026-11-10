/**
 * 宿主调度器（M2 T10）：事实驱动的领取与执行。
 *
 * 触发：`effects.afterCommit` 在 `run.queued` 后调 `wake()`；每次执行结束、`clock.tick`
 * 到点也会 `wake()`。`wake()` 按运行时逐个 `dispatch({type:'run.claim'})`，内核决定
 * 谁先跑（`notBefore` + 入队 seq FIFO、运行时并发窗口），宿主不自己排序——并发与顺序
 * 只在 `kernel/run.ts` 里定义一次。
 *
 * 执行一轮：
 * - 执行器端口按运行时配置构造（`executors.forRuntime(runtime)`），`Turn` 取自 run 行；
 * - `io.emit` 的帧先进缓冲，**运行期**按 `frameFlushMs`（默认 16ms）批量或缓冲达到
 *   `maxFramesPerBatch` 时立即 flush；每批按 `≤ maxFramesPerBatch` 分包写 `run.frames`
 *   （帧 `seq` 由宿主按 run 全局单调分配，D6/D7），终态前再 flush 剩余帧；
 * - 心跳定时 `run.heartbeat` 续租；`run.cancel_requested` → abort `signal`，再按
 *   「`cancelGraceMs` 宽限（等执行器自己收尾）→ `killPidTree` → `killAfterMs` →
 *   兜底 `run.host_settled{cancelled}`」收尾（T15）；
 * - 结束写 `run.receipt`；执行器抛错 / 无回执写 `run.host_settled`（`executor_lost`，
 *   取消时 `cancelled`），保证 run 不悬空（D14）。
 *
 * 本模块只依赖 `protocol` 与宿主内部类型，不 import `main`（ESLint 强制）：
 * 执行器实现与装配在 `main/ai-workflow/executor-port.ts`。
 */
import type { RunErrorCode, RunEvent, RunEventRow, RunRow, Runtime } from '../protocol/entities'
import type { ExecutorIO, ExecutorPort, Receipt, Turn } from '../protocol/executor'
import type { Fact, Id, Iso } from '../kernel/types'
import { killPidTree } from './process'
import { withRunArtifacts } from './artifacts'
import type { ProcessRegistry } from './process-registry'
import type { DispatchResult } from './store/index'

/** 调度器只需要的 store 能力：统一写入口（effects.dispatch）+ 读运行时配置。 */
export interface SchedulerStore {
  dispatch(input: unknown): DispatchResult
}

/** 执行器工厂：按运行时配置的执行器键取端口；未注册返回 null（M3） */
export interface SchedulerExecutors {
  forRuntime(runtime: Runtime): ExecutorPort | null
}

/** 调度相关限制：与 `kernel/types` 的 `Limits` 同值，装配根传 `DEFAULT_LIMITS`。 */
export interface SchedulerLimits {
  heartbeatMs: number
  runTimeoutMs: number
  maxFramesPerBatch: number
  /** 取消宽限：abort 后等执行器自己收尾的时长（缺省 3s，见 SPEC-kernel Limits） */
  cancelGraceMs?: number
  /** 宽限到期强杀后再等回执的时长（缺省 2s）；仍无回执由宿主写兜底终态 */
  killAfterMs?: number
}

/** 定时器抽象：默认系统实现，测试注入假实现（心跳 / 帧批量窗口 / 退出收尾）。 */
export interface SchedulerTimer {
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
  /**
   * 帧批量窗口用的单次定时器（每批帧 flush 后重挂）。缺省时回退系统 `setTimeout`，
   * 只关心心跳的旧夹具不必实现这两个方法。
   */
  setTimeout?(callback: () => void, delayMs: number): unknown
  clearTimeout?(handle: unknown): void
}

/** 帧批量入账的默认时间窗（毫秒）：16ms ≈ 一帧，避免每来一条帧都写一次库。 */
export const DEFAULT_FRAME_FLUSH_MS = 16

export interface SchedulerDeps {
  /** 统一写入口（effects.dispatch）：追加事实后自动分发，调度器自己的写入也走它 */
  dispatch: SchedulerStore['dispatch']
  /** 读运行时配置（装配根传 `() => store.query('runtimes.all')`） */
  runtimes: () => Runtime[]
  /** 执行器工厂（装配根注入 main 侧实现） */
  executors: SchedulerExecutors
  /** 心跳定时器；默认系统实现 */
  timer?: SchedulerTimer
  /** 调度限制；默认与 `DEFAULT_LIMITS` 同值 */
  limits?: SchedulerLimits
  /** 帧批量窗口（毫秒）；默认 `DEFAULT_FRAME_FLUSH_MS`（16ms），测试可注入假 timer 手动推进 */
  frameFlushMs?: number
  /**
   * 重排唯一定时器（装配根传 `() => clock.rearm()`）：run 领取 / 收尾 / 取消后调用。
   * 缺省不重排（单测 / 不挂定时器的宿主）；生产环境必须接上，否则运行期才出现的
   * `leaseUntil` / `deadlineAt` 不会被定时器看到（超时与租约回收失效）。
   */
  rearmClock?: () => void
  /**
   * 该 run 已有的最大帧 seq（重启后重跑同一 run 时保证 `(run_id,seq)` 全局单调）；
   * 缺省视为 0。装配根用仓储读 `run_events` 传入。
   */
  lastFrameSeq?: (runId: Id) => number
  /**
   * 运行进程登记表（M2 T13）：执行开始写占位、pid 到达回填、结束删除；
   * 崩溃重启时由 `host/reconcile` 读取并清理。缺省不登记（测试 / 关闭对账的宿主）。
   */
  registry?: Pick<ProcessRegistry, 'begin' | 'attachPid' | 'remove' | 'pidOf'>
  /** 当前时刻（写 `process_registry.started_at`）；默认系统时钟 */
  now?: () => Iso
  /** 进程树终止（取消宽限到期强杀用）；默认 `killPidTree`，测试可注入假实现 */
  killPid?: (pid: number) => boolean
  /**
   * 聊天 run 的实时帧旁路（AI_WORKFLOW_CHAT 的 `event`）：执行器 `io.emit` 的帧在入账前
   * 原样转给 renderer 实时显示；只对 `purpose='chat'` 的 run 触发。
   */
  onChatStream?: (runId: string, conversationId: string, event: RunEvent) => void
  /** 聊天 run 一轮结束（AI_WORKFLOW_CHAT 的 `end`）：终态事实写完后发一次 */
  onChatStreamEnd?: (runId: string, conversationId: string) => void
  /**
   * 评审报告正文的落盘根（装配根传 `<userData>/artifacts`）。缺省不落盘：报告行里
   * `artifact` 为 null，索引段退化成「完整清单：报告 id」。
   */
  artifactsRoot?: string
  /** 聊天续接轮的「完整历史 prompt」：协议会话失效重试时用（`Turn.fallbackPrompt`）。
   * 装配根按投影里的智能体 + 对话消息拼；缺省不提供（重试退回当前 prompt）。
   */
  chatFallbackPrompt?: (run: RunRow) => string | null
}

export interface Scheduler {
  /** 领取并启动：`run.queued` 之后、执行结束、`clock.tick` 到点时调用（可重入） */
  wake(): void
  /** 接管一条已领取的 run（wake 内部用；对账 / 测试也可直接调，重复调用零效果） */
  start(run: RunRow): void
  /**
   * 取消一个 run：执行中就先 abort 再走宽限/强杀/兜底时序；排队中的 run 没有执行器，
   * 直接写兜底终态 `run.host_settled{cancelled}`（看板立即解除「执行中」）。重复调用幂等。
   */
  cancel(runId: Id): void
  /** 退出用：对全部执行中的 run best-effort 取消（立即杀进程树 + 写兜底终态，不阻塞退出） */
  cancelAll(): void
  /** 正在执行的 run（诊断 / 测试） */
  active(): Id[]
  /** 等所有执行结束（测试与退出前收尾） */
  idle(): Promise<void>
}

/**
 * 取消链路的定时器句柄（宽限 / 强杀后等待）；`null` = 没有进行中的取消链。
 *
 * 取消链路的三条判定（是否该写兜底终态、是否该启动链路、是否该排下一步）都收在
 * 下面这几个模块级函数里：它们只吃状态、不碰 IO，**行为与内联写法逐字等价**，
 * 但可以被单测用构造状态直接覆盖——内联写法在产品路径上永远走不到「收口」那一侧。
 */
export interface CancelChain {
  /** 宽限定时器句柄（等执行器自己交回执） */
  grace: unknown
  /** 强杀定时器句柄（宽限到期后再等一轮） */
  kill: unknown
}

/**
 * 兜底取消终态：run 已落终态时不再写（终态事实只追加一次，重复写会脏掉投影）。
 */
export function settleCancelledOnce(finished: boolean, settle: () => void): void {
  if (finished) return
  settle()
}

/**
 * 启动取消链路：run 已落终态、或取消链路已在跑时忽略
 * （迟到取消不重写终态；重复取消不重启链路）。
 */
export function startCancelChain(
  finished: boolean,
  chain: CancelChain | null,
  start: (chain: CancelChain) => void,
): void {
  if (finished || chain !== null) return
  start({ grace: null, kill: null })
}

/**
 * 排下一步（强杀等待）：链路已收口时不再排——run 都落终态了，没必要再杀一次。
 */
export function scheduleKill(
  chain: CancelChain | null,
  schedule: (chain: CancelChain) => void,
): void {
  if (chain === null) return
  schedule(chain)
}

const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  heartbeatMs: 30_000,
  runTimeoutMs: 1_800_000,
  maxFramesPerBatch: 500,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
}

const systemTimer: SchedulerTimer = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** 缺省登记表：宿主没接对账时执行链照常跑，只少了崩溃恢复线索。 */
const noopRegistry: Pick<ProcessRegistry, 'begin' | 'attachPid' | 'remove' | 'pidOf'> = {
  begin: () => undefined,
  attachPid: () => undefined,
  remove: () => undefined,
  pidOf: () => null,
}

/** 运行时配置的 `provider/model` → `Turn.model`；格式不对不传（后端会给出可读错误）。 */
const modelOf = (runtime: Runtime): Turn['model'] => {
  const value = runtime.model?.trim() ?? ''
  const index = value.indexOf('/')
  if (index <= 0 || index === value.length - 1) return null
  return { provider: value.slice(0, index), id: value.slice(index + 1) }
}

/** `run.frames` 的帧：丢掉执行器本地 `seq`/`type`，只留负载（`seq` 由宿主分配）。 */
const framePayload = (event: RunEvent): Omit<RunEventRow, 'runId' | 'seq' | 'type'> => {
  const { seq: _seq, type: _type, ...payload } = event
  return payload
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const timer = deps.timer ?? systemTimer
  /** 单次定时器（帧批量窗口 / 取消宽限与强杀）：注入 timer 缺 `setTimeout` 时回退系统实现。 */
  const injectedSetTimeout = timer.setTimeout?.bind(timer)
  const injectedClearTimeout = timer.clearTimeout?.bind(timer)
  const setOneShot = (callback: () => void, delayMs: number): unknown =>
    injectedSetTimeout === undefined
      ? setTimeout(callback, delayMs)
      : injectedSetTimeout(callback, delayMs)
  const clearOneShot = (handle: unknown): void => {
    if (injectedClearTimeout === undefined) clearTimeout(handle as ReturnType<typeof setTimeout>)
    else injectedClearTimeout(handle)
  }
  const limits = deps.limits ?? DEFAULT_SCHEDULER_LIMITS
  const frameFlushMs = deps.frameFlushMs ?? DEFAULT_FRAME_FLUSH_MS
  const lastFrameSeq = deps.lastFrameSeq ?? (() => 0)
  const registry = deps.registry ?? noopRegistry
  const now = deps.now ?? (() => new Date().toISOString())
  const killPid = deps.killPid ?? killPidTree
  const cancelGraceMs = limits.cancelGraceMs ?? 3_000
  const killAfterMs = limits.killAfterMs ?? 2_000

  /** 聊天旁路：订阅端（窗口）已销毁时丢弃本次推送，不影响执行与落库。 */
  const emitChat = (runId: string, conversationId: string, event: RunEvent): void => {
    try {
      deps.onChatStream?.(runId, conversationId, event)
    } catch {
      // 订阅端异常不能打断执行：旁路只是显示，事实才是数据源
    }
  }
  const emitChatEnd = (runId: string, conversationId: string): void => {
    try {
      deps.onChatStreamEnd?.(runId, conversationId)
    } catch {
      // 同上：结束通知失败不影响终态
    }
  }
  /** 执行中的 run → 取消信号。 */
  const controllers = new Map<Id, AbortController>()
  /** 每个 run 已分配到的最大帧 seq（跨 batch / 跨轮持续递增）。 */
  const frameSeq = new Map<Id, number>()
  const idleWaiters: Array<() => void> = []
  let pumping = false
  let wakeAgain = false
  /** 退出中：不再领取新 run（cancelAll 置位后本实例只收尾，不再起新进程）。 */
  let draining = false

  /** 宿主兜底取消：没有执行器可等的 run（排队中 / 已结束）直接落终态。 */
  const settleCancelled = (runId: Id): void => {
    dispatch({
      type: 'run.host_settled',
      runId,
      status: 'cancelled',
      errorCode: 'cancelled',
      error: '已取消',
    })
  }

  /** 写入口：单次写入失败（领取被拒 / run 已随任务删除）不让调度器中断。 */
  const dispatch = (input: unknown): Fact[] => {
    try {
      return deps.dispatch(input).facts
    } catch {
      return []
    }
  }

  const runtimeOf = (run: RunRow): Runtime | undefined =>
    run.runtimeId === null
      ? undefined
      : deps.runtimes().find((runtime) => runtime.id === run.runtimeId)

  /** 宿主兜底终态（执行器不可达 / 缺失配置）：run 不悬空（D14）。 */
  const settleFailed = (run: RunRow, errorCode: RunErrorCode, error: string): void => {
    dispatch({
      type: 'run.host_settled',
      runId: run.id,
      leaseId: run.leaseId ?? undefined,
      turn: run.turn,
      status: 'failed',
      errorCode,
      error,
    })
    // 终态改变了下一跳（该 run 不再占租约/超时），重排定时器
    deps.rearmClock?.()
  }

  /** 帧缓冲 → `run.frames` 事实：按批分包，seq 从「已有最大 seq」继续全局单调。 */
  const flushFrames = (run: RunRow, frames: readonly RunEvent[]): void => {
    if (frames.length === 0) return
    let seq = Math.max(frameSeq.get(run.id) ?? 0, lastFrameSeq(run.id))
    for (let start = 0; start < frames.length; start += limits.maxFramesPerBatch) {
      const batch: RunEventRow[] = []
      for (const event of frames.slice(start, start + limits.maxFramesPerBatch)) {
        seq += 1
        batch.push({ runId: run.id, seq, type: event.type, ...framePayload(event) })
      }
      dispatch({ type: 'run.frames', runId: run.id, turn: run.turn, frames: batch })
    }
    frameSeq.set(run.id, seq)
  }

  /** 心跳：每个 `heartbeatMs` 续租一次；租约不匹配时内核静默丢弃（D1）。 */
  const startHeartbeat = (run: RunRow): unknown => {
    if (run.leaseId === null) return null
    const leaseId = run.leaseId
    return timer.setInterval(
      () => dispatch({ type: 'run.heartbeat', runId: run.id, leaseId }),
      limits.heartbeatMs,
    )
  }

  const turnOf = (run: RunRow, runtime: Runtime, signal: AbortSignal): Turn => ({
    runId: run.id,
    leaseId: run.leaseId ?? `${run.id}:${Math.max(1, run.attempt)}`,
    turn: run.turn,
    purpose: run.purpose,
    prompt: run.prompt,
    cwd: run.cwd,
    access: run.access,
    model: modelOf(runtime),
    effort: runtime.reasoningEffort,
    resumeSessionId: run.resumeSessionId,
    // 聊天续接轮的重试提示词（完整历史）：协议会话失效时执行器用它重发一次
    fallbackPrompt: run.purpose === 'chat' ? (deps.chatFallbackPrompt?.(run) ?? null) : null,
    timeoutMs: limits.runTimeoutMs,
    contextFile: run.promptRef,
    signal,
  })

  const releaseIdle = (): void => {
    if (controllers.size > 0) return
    for (const waiter of idleWaiters.splice(0)) waiter()
  }

  const execute = async (
    run: RunRow,
    runtime: Runtime,
    controller: AbortController,
    port: ExecutorPort,
  ): Promise<void> => {
    /** 本次执行的帧缓冲；`framesClosed` 之后（终态已定）不再接受新帧。 */
    let frames: RunEvent[] = []
    let flushTimer: unknown = null
    let framesClosed = false
    let observedSession: string | null = null

    /** flush 当前缓冲：先取消挂着的窗口定时器，再按 `≤ maxFramesPerBatch` 分包写事实。 */
    const flushBuffered = (): void => {
      if (flushTimer !== null) {
        clearOneShot(flushTimer)
        flushTimer = null
      }
      // 空缓冲交给 `flushFrames` 自己挡：权威判定只留一处（它直接返回，不写事实、
      // 也不动 frameSeq），与原来在这里早退的行为完全一致。
      const buffered = frames
      frames = []
      flushFrames(run, buffered)
    }

    /** 挂一帧批量窗口：每批只挂一个；窗口到点 flush 缓冲（之后的帧再重新挂）。 */
    const armFlushTimer = (): void => {
      if (framesClosed || flushTimer !== null || frames.length === 0) return
      flushTimer = setOneShot(() => {
        flushTimer = null
        flushBuffered()
      }, frameFlushMs)
    }

    const io: ExecutorIO = {
      emit: (event) => {
        // 终态后执行器即便再回调也不写帧：事实只追加，不补历史（D6）。
        if (framesClosed) return
        // 聊天 run：帧在入账前先走旁路（AI_WORKFLOW_CHAT），renderer 实时显示
        if (run.purpose === 'chat' && run.conversationId !== null) {
          emitChat(run.id, run.conversationId, event)
        }
        frames.push(event)
        // 缓冲达到单批上限：立刻 flush，不等到时间窗（D7 分包由 flushFrames 负责）。
        if (frames.length >= limits.maxFramesPerBatch) {
          flushBuffered()
          return
        }
        armFlushTimer()
      },
      session: (id) => {
        observedSession = id
      },
      // 子进程 pid 到达：回填登记行，崩溃重启时按它终止残留进程树
      process: (pid) => registry.attachPid(run.id, pid),
    }
    // 执行开始即登记（spawn 之前）：进程还没起来也不能丢线索（pid 留空，对账只清理）
    const heartbeat = startHeartbeat(run)
    /** 取消时序的定时器（宽限 / 强杀后等待）；null = 没有进行中的取消链。 */
    let cancelTimers: CancelChain | null = null
    /** 收尾只做一次：flush、清定时器/心跳/登记、释放执行位、唤醒下一条。 */
    let finished = false

    const clearCancelTimers = (): void => {
      if (cancelTimers === null) return
      if (cancelTimers.grace !== null) clearOneShot(cancelTimers.grace)
      if (cancelTimers.kill !== null) clearOneShot(cancelTimers.kill)
      cancelTimers = null
    }

    const finishOnce = (): void => {
      if (finished) return
      finished = true
      framesClosed = true
      flushBuffered()
      clearCancelTimers()
      if (heartbeat !== null) timer.clearInterval(heartbeat)
      // 终态事实已写：登记行没有保留价值（残留行只留给崩溃场景给对账用）
      registry.remove(run.id)
      controllers.delete(run.id)
      frameSeq.delete(run.id)
      // 释放了并发位：先领取下一条（链式阶段靠这里接上），再判断空闲；
      // 顺序反了会让 idle() 在下一轮启动前就提前返回。
      wake()
      releaseIdle()
      // 本轮终态改变了「下一次到期」（可能只剩退避中的 queued），重排唯一定时器
      deps.rearmClock?.()
      // 聊天 run：终态事实已写完，通知 renderer 本轮结束（一轮只发一次；对话已删也发）
      if (run.purpose === 'chat' && run.conversationId !== null)
        emitChatEnd(run.id, run.conversationId)
    }

    /** 宽限与强杀都到期仍无回执：宿主写兜底终态（帧先入账，不丢已产生的输出）。 */
    const settleCancelledRun = (error: string): void => {
      settleCancelledOnce(finished, () => {
        framesClosed = true
        flushBuffered()
        dispatch({
          type: 'run.host_settled',
          runId: run.id,
          leaseId: run.leaseId ?? undefined,
          turn: run.turn,
          status: 'cancelled',
          errorCode: 'cancelled',
          error,
        })
        finishOnce()
      })
    }

    // 取消链路（T15）：abort → cancelGraceMs（等执行器自己交回执）
    // → killPidTree（process_registry 里的 pid）→ killAfterMs → 兜底终态。
    controller.signal.addEventListener(
      'abort',
      () => {
        startCancelChain(finished, cancelTimers, (chain) => {
          cancelTimers = chain
          chain.grace = setOneShot(() => {
            const active = cancelTimers
            if (active === null) return
            active.grace = null
            // 宽限内没等到回执：按登记 pid 终止整棵进程树（Windows taskkill /T /F）
            const pid = registry.pidOf(run.id)
            if (pid !== null) killPid(pid)
            scheduleKill(cancelTimers, (next) => {
              next.kill = setOneShot(() => {
                const current = cancelTimers
                if (current === null) return
                current.kill = null
                settleCancelledRun('已取消')
              }, killAfterMs)
            })
          }, cancelGraceMs)
        })
      },
      { once: true },
    )

    // 领取已入投影（status=running + leaseUntil/deadlineAt）：把本轮到期时刻纳入
    // 唯一定时器。启动之后才出现的 run 只能靠这里排期，否则租约回收/超时永不触发。
    deps.rearmClock?.()

    try {
      registry.begin(run.id, now())
      const receipt = await port.run(turnOf(run, runtime, controller.signal), io)
      // 兜底取消已落终态：迟到的回执不再写事实（清理统一走 finally）
      if (finished) return
      // 终态前先关缓冲再 flush：保证 receipt 之前所有帧都已入账（后续帧被拒绝）。
      framesClosed = true
      flushBuffered()
      // 执行器只经旁路报过 sessionId 时补进回执（终态行据此可续接）
      const finalReceipt: Receipt = withRunArtifacts(
        deps.artifactsRoot,
        run,
        receipt.sessionId === undefined && observedSession !== null
          ? { ...receipt, sessionId: observedSession }
          : receipt,
      )
      dispatch({ type: 'run.receipt', runId: run.id, receipt: finalReceipt })
    } catch (error) {
      // 宿主兜底终态已写过（执行器迟到的抛错只是收尾信号）
      if (finished) return
      framesClosed = true
      flushBuffered()
      const message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) {
        dispatch({
          type: 'run.host_settled',
          runId: run.id,
          leaseId: run.leaseId ?? undefined,
          turn: run.turn,
          status: 'cancelled',
          errorCode: 'cancelled',
          error: message || '已取消',
        })
      } else {
        dispatch({
          type: 'run.host_settled',
          runId: run.id,
          leaseId: run.leaseId ?? undefined,
          turn: run.turn,
          status: 'failed',
          errorCode: 'executor_lost',
          error: message,
        })
      }
    } finally {
      finishOnce()
    }
  }

  const start = (run: RunRow): void => {
    if (controllers.has(run.id)) return
    const runtime = runtimeOf(run)
    if (!runtime) {
      settleFailed(run, 'runtime_missing', '运行时不存在（可能已被删除）')
      return
    }
    if (!runtime.enabled) {
      settleFailed(run, 'runtime_disabled', '运行时已停用')
      return
    }
    // 执行器插件缺失：配置引用了未注册的 executorKey（M3 D7）。用既有 errorCode
    // `runtime_missing` 收口，不新增协议取值；文案带 key 便于定位。
    const port = deps.executors.forRuntime(runtime)
    if (port === null) {
      settleFailed(run, 'runtime_missing', '执行器插件未注册: ' + runtime.executorKey)
      return
    }
    const controller = new AbortController()
    controllers.set(run.id, controller)
    // 收尾（删控制器 / 唤醒 / 置空闲）统一在 execute 的 finally 里做：取消兜底路径
    // 也要能提前释放执行位，不能在两条路径上各写一份。
    void execute(run, runtime, controller, port)
  }

  const pump = (): void => {
    for (const runtime of deps.runtimes()) {
      if (!runtime.enabled) continue
      const facts = dispatch({
        type: 'run.claim',
        runtimeId: runtime.id,
        capacity: runtime.maxConcurrent,
      })
      for (const fact of facts) {
        if (fact.type === 'run.claimed') start((fact.payload as { run: RunRow }).run)
      }
    }
  }

  function wake(): void {
    // 退出中：不领新活，只等活跃 run 收尾（cancelAll 置位 draining）
    if (draining) return
    if (pumping) {
      wakeAgain = true
      return
    }
    pumping = true
    try {
      do {
        wakeAgain = false
        pump()
      } while (wakeAgain)
    } finally {
      pumping = false
    }
  }

  return {
    wake,
    start,
    cancel: (runId) => {
      const controller = controllers.get(runId)
      if (controller === undefined) {
        // 排队中 / 已结束：没有执行器可等，直接写兜底终态（内核侧重复取消幂等）
        settleCancelled(runId)
        // 该 run 退出活跃集合，下一跳可能随之后移
        deps.rearmClock?.()
        return
      }
      controller.abort()
    },
    cancelAll: () => {
      draining = true
      // 直接遍历 entries：controller 就是 Map 里的值，「这轮取不到 controller」在构造上不存在
      for (const [runId, controller] of [...controllers.entries()]) {
        // 退出不等待宽限：直接 abort + 杀进程树 + 写兜底终态（best-effort，不阻塞退出）
        controller.abort()
        const pid = registry.pidOf(runId)
        if (pid !== null) killPid(pid)
        registry.remove(runId)
        controllers.delete(runId)
        frameSeq.delete(runId)
        settleCancelled(runId)
      }
      releaseIdle()
    },
    active: () => [...controllers.keys()],
    idle: () =>
      controllers.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve)
          }),
  }
}
