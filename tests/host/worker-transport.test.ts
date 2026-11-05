// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../src/protocol/executor'
import { createMemoryRemoteTransport } from '../../src/host/worker-transport'

/**
 * 远端 Worker 的内存传输（M7 架构位）：验证端口形状与时序，不监听端口、不 spawn 进程。
 * 用例只驱动 `onTurn` / `cancel` / `AbortSignal`，断言记录与回执。
 */
const turnOf = (over: Partial<Turn> = {}): Turn => ({
  runId: 'run-1',
  leaseId: 'lease-1',
  turn: 2,
  purpose: 'stage',
  prompt: '做点什么',
  cwd: 'C:/work',
  access: 'edit',
  timeoutMs: 60_000,
  signal: new AbortController().signal,
  ...over,
})

const eventOf = (seq: number): RunEvent => ({ seq, type: 'text', text: `片段${seq}` })

const receiptOf = (over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: 'lease-1',
  turn: 2,
  output: '完成',
  ...over,
})

/** 可手动结算的 promise：用来模拟「执行中」的远端一轮 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 记录 io.emit 的事件 */
function ioRecorder(): { io: ExecutorIO; events: RunEvent[] } {
  const events: RunEvent[] = []
  return { events, io: { emit: (event) => events.push(event) } }
}

describe('createMemoryRemoteTransport：正常一轮', () => {
  it('execute：记录调用、事件经 io 转发、回执原样返回', async () => {
    const turn = turnOf()
    const expected = receiptOf()
    const memory = createMemoryRemoteTransport({
      onTurn: ({ turn: seenTurn, emit }) => {
        expect(seenTurn).toBe(turn)
        expect(emit(eventOf(1))).toBe(true)
        expect(emit(eventOf(2))).toBe(true)
        return expected
      },
    })
    const { io, events } = ioRecorder()

    const receipt = await memory.transport.execute(turn, io, turn.signal)

    expect(receipt).toBe(expected)
    expect(events).toEqual([eventOf(1), eventOf(2)])
    expect(memory.calls).toHaveLength(1)
    expect(memory.calls[0]).toMatchObject({
      turn,
      events: [eventOf(1), eventOf(2)],
      receipt: expected,
      cancelled: false,
    })
    expect(memory.cancels).toEqual([])
  })

  it('多轮 execute 按调用顺序各记一条', async () => {
    const memory = createMemoryRemoteTransport({
      onTurn: ({ turn }) => receiptOf({ leaseId: turn.leaseId }),
    })
    const { io } = ioRecorder()

    await memory.transport.execute(turnOf({ runId: 'run-1' }), io, turnOf().signal)
    await memory.transport.execute(
      turnOf({ runId: 'run-2', leaseId: 'lease-2' }),
      io,
      turnOf().signal,
    )

    expect(memory.calls.map((call) => call.turn.runId)).toEqual(['run-1', 'run-2'])
    expect(memory.calls.map((call) => call.receipt?.leaseId)).toEqual(['lease-1', 'lease-2'])
  })
})

describe('createMemoryRemoteTransport：取消与 abort', () => {
  it('cancel：挂起的 execute 立刻回 cancelled，记录 runId，晚到回执与事件都被丢弃', async () => {
    const pending = deferred<Receipt>()
    const captured: { emit: ((event: RunEvent) => boolean) | null } = { emit: null }
    const memory = createMemoryRemoteTransport({
      onTurn: ({ emit }) => {
        captured.emit = emit
        emit(eventOf(1))
        return pending.promise
      },
    })
    const turn = turnOf()
    const { io, events } = ioRecorder()

    const running = memory.transport.execute(turn, io, turn.signal)
    await memory.transport.cancel(turn.runId)
    const receipt = await running

    expect(receipt).toMatchObject({
      status: 'cancelled',
      leaseId: 'lease-1',
      turn: 2,
      error: '已取消',
      errorCode: 'cancelled',
    })
    expect(memory.cancels).toEqual(['run-1'])
    expect(memory.calls[0]?.cancelled).toBe(true)
    expect(memory.calls[0]?.receipt).toBe(receipt)

    // 取消之后：emit 被拒、晚到回执不覆盖
    expect(captured.emit?.(eventOf(2))).toBe(false)
    pending.resolve(receiptOf({ output: '迟到的回执' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(memory.calls[0]?.receipt).toBe(receipt)
    expect(events).toEqual([eventOf(1)])
  })

  it('cancel：不存在的 run 只记录，不抛错', async () => {
    const memory = createMemoryRemoteTransport({ onTurn: () => receiptOf() })

    await memory.transport.cancel('missing-run')

    expect(memory.cancels).toEqual(['missing-run'])
    expect(memory.calls).toEqual([])
  })

  it('signal abort：cancelled 回执，abort 后 emit 被丢弃', async () => {
    const pending = deferred<Receipt>()
    const captured: { emit: ((event: RunEvent) => boolean) | null } = { emit: null }
    const memory = createMemoryRemoteTransport({
      onTurn: (context) => {
        captured.emit = context.emit
        context.emit(eventOf(1))
        return pending.promise
      },
    })
    const controller = new AbortController()
    const turn = turnOf({ signal: controller.signal })
    const { io, events } = ioRecorder()

    const running = memory.transport.execute(turn, io, controller.signal)
    controller.abort()
    const receipt = await running

    expect(receipt.status).toBe('cancelled')
    expect(receipt.errorCode).toBe('cancelled')
    expect(captured.emit?.(eventOf(2))).toBe(false)
    expect(events).toEqual([eventOf(1)])
    pending.resolve(receiptOf())
    await Promise.resolve()
    expect(memory.calls[0]?.receipt).toBe(receipt)
  })

  it('起跑前已 abort：直接 cancelled，不驱动 onTurn', async () => {
    let called = 0
    const memory = createMemoryRemoteTransport({
      onTurn: () => {
        called += 1
        return receiptOf()
      },
    })
    const controller = new AbortController()
    controller.abort()
    const turn = turnOf({ signal: controller.signal })

    const receipt = await memory.transport.execute(turn, ioRecorder().io, controller.signal)

    expect(called).toBe(0)
    expect(receipt).toMatchObject({ status: 'cancelled', leaseId: 'lease-1', turn: 2 })
    expect(memory.calls[0]).toMatchObject({ cancelled: true, receipt })
  })

  it('取消后同一 runId 再执行：重新记录一轮，不受上一次影响', async () => {
    const memory = createMemoryRemoteTransport({ onTurn: () => receiptOf() })
    const turn = turnOf()
    const { io } = ioRecorder()

    const first = memory.transport.execute(turn, io, turn.signal)
    await memory.transport.cancel(turn.runId)
    await first
    const second = await memory.transport.execute(turn, io, turn.signal)

    expect(second.status).toBe('succeeded')
    expect(memory.calls).toHaveLength(2)
    expect(memory.calls[1]?.cancelled).toBe(false)
  })
})

describe('createMemoryRemoteTransport：异常归一', () => {
  it('onTurn 抛错：execute 以原错误拒绝（由执行器插件归一）', async () => {
    const memory = createMemoryRemoteTransport({
      onTurn: () => {
        throw new Error('worker 掉线')
      },
    })
    const turn = turnOf()

    await expect(memory.transport.execute(turn, ioRecorder().io, turn.signal)).rejects.toThrow(
      'worker 掉线',
    )
    expect(memory.calls[0]?.receipt).toBeNull()
    expect(memory.calls[0]?.cancelled).toBe(false)
  })

  it('取消后 onTurn 抛错：不覆盖 cancelled 回执', async () => {
    const pending = deferred<Receipt>()
    const memory = createMemoryRemoteTransport({ onTurn: () => pending.promise })
    const turn = turnOf()

    const running = memory.transport.execute(turn, ioRecorder().io, turn.signal)
    await memory.transport.cancel(turn.runId)
    const receipt = await running

    pending.reject(new Error('迟到的崩溃'))
    await Promise.resolve()
    await Promise.resolve()

    expect(receipt.status).toBe('cancelled')
    expect(memory.calls[0]?.receipt).toBe(receipt)
  })
})
