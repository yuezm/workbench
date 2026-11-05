/**
 * 远端 Worker 传输端口的内存实现（M7「架构位」）。
 *
 * 分层：`protocol/worker.ts` 定义帧形状与 `RemoteTransport` 端口；本模块只提供**进程内**
 * 的假传输，供宿主/执行器测试与将来的宿主实现对齐形状。**不监听端口、不建 socket、
 * 不 spawn 进程**——生产传输（连 worker 进程或网络、复用 `protocol/worker` 的帧）由后续
 * 里程碑实现，这里只落端口与可测的内存替身。
 *
 * 时序与真实传输同口径：
 * - `execute` 记录调用，把一轮的驱动权交给 `options.onTurn`（测试在回调里 emit 事件、给回执）；
 * - `cancel` / `signal` abort 后立刻回 `status='cancelled'` 的回执，并丢弃之后的 emit
 *   （对应真实传输「abort 后不写帧」）；
 * - 回执原样返回；`leaseId` / `turn` 的兜底由执行器插件负责，与真实传输一致。
 */
import type { RunEvent } from '../protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../protocol/executor'
import type { RemoteTransport } from '../protocol/worker'

/** 一轮内存执行的驱动上下文：测试据此 emit 事件、给出回执。 */
export interface MemoryTurnContext {
  turn: Turn
  signal: AbortSignal
  /** 发一条事件；取消 / 结束后返回 false 且事件被丢弃（真实传输此时也不写帧） */
  emit(event: RunEvent): boolean
}

export interface MemoryRemoteTransportOptions {
  /** 驱动一轮：测试在回调里 emit 事件并返回回执；抛错会原样拒绝 `execute` */
  onTurn(context: MemoryTurnContext): Promise<Receipt> | Receipt
}

/** 一次 `execute` 的调用记录（断言用）。 */
export interface MemoryTransportCall {
  turn: Turn
  /** 本轮被接受的事件（顺序即发出顺序；取消后的事件不计入） */
  events: RunEvent[]
  /** 结束时的回执；仍在执行中为 null */
  receipt: Receipt | null
  /** 是否因 `cancel` / signal abort 提前结束 */
  cancelled: boolean
}

export interface MemoryRemoteTransport {
  transport: RemoteTransport
  /** 按调用顺序记录每轮 `execute` */
  calls: MemoryTransportCall[]
  /** 按调用顺序记录 `cancel(runId)` 的入参（幂等：重复取消只记录） */
  cancels: string[]
}

/** 取消 / abort 的归一终态：与本地执行器同形状（`leaseId` / `turn` 原样带回）。 */
const cancelledReceipt = (turn: Turn): Receipt => ({
  status: 'cancelled',
  leaseId: turn.leaseId,
  turn: turn.turn,
  output: '',
  error: '已取消',
  errorCode: 'cancelled',
})

/**
 * 创建进程内假传输：`options.onTurn` 决定每轮怎么跑，`calls` / `cancels` 供断言。
 *
 * 不碰网络与子进程；同一 run 同时只允许一轮（后一轮覆盖取消入口，与真实租约语义一致）。
 */
export function createMemoryRemoteTransport(
  options: MemoryRemoteTransportOptions,
): MemoryRemoteTransport {
  const calls: MemoryTransportCall[] = []
  const cancels: string[] = []
  /** 正在执行的 run → 取消入口；`cancel` 与 signal abort 共用它 */
  const pending = new Map<string, () => void>()

  const execute = async (turn: Turn, io: ExecutorIO, signal: AbortSignal): Promise<Receipt> => {
    const call: MemoryTransportCall = { turn, events: [], receipt: null, cancelled: false }
    calls.push(call)

    // 起跑前已取消：与本地执行器同口径，不驱动 onTurn
    if (signal.aborted) {
      call.cancelled = true
      call.receipt = cancelledReceipt(turn)
      return call.receipt
    }

    return await new Promise<Receipt>((resolve, reject) => {
      let settled = false

      const settle = (outcome: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', cancel)
        pending.delete(turn.runId)
        outcome()
      }

      const finish = (receipt: Receipt): void => {
        settle(() => {
          call.receipt = receipt
          resolve(receipt)
        })
      }

      const fail = (error: unknown): void => settle(() => reject(error))

      /** 取消 / abort 的唯一出口：先落 cancelled 回执，后续 emit 与回执都被丢弃 */
      const cancel = (): void => {
        call.cancelled = true
        finish(cancelledReceipt(turn))
      }

      const emit = (event: RunEvent): boolean => {
        if (settled) return false
        call.events.push(event)
        io.emit(event)
        return true
      }

      pending.set(turn.runId, cancel)
      signal.addEventListener('abort', cancel, { once: true })

      // 驱动一轮：测试在 onTurn 里 emit 并返回回执；异常原样抛给执行器插件归一
      void (async () => {
        try {
          finish(await options.onTurn({ turn, signal, emit }))
        } catch (error) {
          fail(error)
        }
      })()
    })
  }

  return {
    transport: {
      execute,
      async cancel(runId: string): Promise<void> {
        cancels.push(runId)
        pending.get(runId)?.()
      },
    },
    calls,
    cancels,
  }
}
