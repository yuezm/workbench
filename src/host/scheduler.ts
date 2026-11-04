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
 * - `io.emit` 的帧先进缓冲，**终态前**按 `≤ maxFramesPerBatch` 分包写 `run.frames`
 *   （帧 `seq` 由宿主按 run 全局单调分配，D6/D7）；
 * - 心跳定时 `run.heartbeat` 续租；取消走 `run.cancel_requested` → abort `signal`；
 * - 结束写 `run.receipt`；执行器抛错 / 无回执写 `run.host_settled`（`executor_lost`，
 *   取消时 `cancelled`），保证 run 不悬空（D14）。
 *
 * 本模块只依赖 `protocol` 与宿主内部类型，不 import `main`（ESLint 强制）：
 * 执行器实现与装配在 `main/ai-workflow/executor-port.ts`。
 */
import type { RunErrorCode, RunEvent, RunEventRow, RunRow, Runtime } from '../protocol/entities'
import type { ExecutorIO, ExecutorPort, Receipt, Turn } from '../protocol/executor'
import type { Fact, Id, Iso } from '../kernel/types'
import type { ProcessRegistry } from './process-registry'
import type { DispatchResult } from './store/index'

/** 调度器只需要的 store 能力：统一写入口（effects.dispatch）+ 读运行时配置。 */
export interface SchedulerStore {
  dispatch(input: unknown): DispatchResult
}

/** 执行器工厂：按运行时配置取端口（main 的 `RuntimeExecutors` 结构上满足）。 */
export interface SchedulerExecutors {
  forRuntime(runtime: Runtime): ExecutorPort
}

/** 调度相关限制：与 `kernel/types` 的 `Limits` 同值，装配根传 `DEFAULT_LIMITS`。 */
export interface SchedulerLimits {
  heartbeatMs: number
  runTimeoutMs: number
  maxFramesPerBatch: number
}

/** 定时器抽象：默认系统实现，测试注入假实现（心跳与退出收尾）。 */
export interface SchedulerTimer {
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
}

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
  /**
   * 该 run 已有的最大帧 seq（重启后重跑同一 run 时保证 `(run_id,seq)` 全局单调）；
   * 缺省视为 0。装配根用仓储读 `run_events` 传入。
   */
  lastFrameSeq?: (runId: Id) => number
  /**
   * 运行进程登记表（M2 T13）：执行开始写占位、pid 到达回填、结束删除；
   * 崩溃重启时由 `host/reconcile` 读取并清理。缺省不登记（测试 / 关闭对账的宿主）。
   */
  registry?: Pick<ProcessRegistry, 'begin' | 'attachPid' | 'remove'>
  /** 当前时刻（写 `process_registry.started_at`）；默认系统时钟 */
  now?: () => Iso
}

export interface Scheduler {
  /** 领取并启动：`run.queued` 之后、执行结束、`clock.tick` 到点时调用（可重入） */
  wake(): void
  /** 接管一条已领取的 run（wake 内部用；对账 / 测试也可直接调，重复调用零效果） */
  start(run: RunRow): void
  /** 取消执行中的 run（abort 信号；终止时序由执行器负责） */
  cancel(runId: Id): void
  /** 正在执行的 run（诊断 / 测试） */
  active(): Id[]
  /** 等所有执行结束（测试与退出前收尾） */
  idle(): Promise<void>
}

const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  heartbeatMs: 30_000,
  runTimeoutMs: 1_800_000,
  maxFramesPerBatch: 500,
}

const systemTimer: SchedulerTimer = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** 缺省登记表：宿主没接对账时执行链照常跑，只少了崩溃恢复线索。 */
const noopRegistry: Pick<ProcessRegistry, 'begin' | 'attachPid' | 'remove'> = {
  begin: () => undefined,
  attachPid: () => undefined,
  remove: () => undefined,
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
  const limits = deps.limits ?? DEFAULT_SCHEDULER_LIMITS
  const lastFrameSeq = deps.lastFrameSeq ?? (() => 0)
  const registry = deps.registry ?? noopRegistry
  const now = deps.now ?? (() => new Date().toISOString())
  /** 执行中的 run → 取消信号。 */
  const controllers = new Map<Id, AbortController>()
  /** 每个 run 已分配到的最大帧 seq（跨 batch / 跨轮持续递增）。 */
  const frameSeq = new Map<Id, number>()
  const idleWaiters: Array<() => void> = []
  let pumping = false
  let wakeAgain = false

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
  ): Promise<void> => {
    const frames: RunEvent[] = []
    let observedSession: string | null = null
    const io: ExecutorIO = {
      emit: (event) => frames.push(event),
      session: (id) => {
        observedSession = id
      },
      // 子进程 pid 到达：回填登记行，崩溃重启时按它终止残留进程树
      process: (pid) => registry.attachPid(run.id, pid),
    }
    // 执行开始即登记（spawn 之前）：进程还没起来也不能丢线索（pid 留空，对账只清理）
    const heartbeat = startHeartbeat(run)
    try {
      registry.begin(run.id, now())
      const receipt = await deps.executors
        .forRuntime(runtime)
        .run(turnOf(run, runtime, controller.signal), io)
      flushFrames(run, frames)
      // 执行器只经旁路报过 sessionId 时补进回执（终态行据此可续接）
      const finalReceipt: Receipt =
        receipt.sessionId === undefined && observedSession !== null
          ? { ...receipt, sessionId: observedSession }
          : receipt
      dispatch({ type: 'run.receipt', runId: run.id, receipt: finalReceipt })
    } catch (error) {
      flushFrames(run, frames)
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
      if (heartbeat !== null) timer.clearInterval(heartbeat)
      // 终态事实已写：登记行没有保留价值（残留行只留给崩溃场景给对账用）
      registry.remove(run.id)
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
    const controller = new AbortController()
    controllers.set(run.id, controller)
    void execute(run, runtime, controller).finally(() => {
      controllers.delete(run.id)
      frameSeq.delete(run.id)
      // 释放了并发位：先领取下一条（链式阶段靠这里接上），再判断空闲；
      // 顺序反了会让 idle() 在下一轮启动前就提前返回。
      wake()
      releaseIdle()
    })
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
      controllers.get(runId)?.abort()
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
