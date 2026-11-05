// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../src/protocol/executor'
import type { RemoteTransport } from '../../../src/protocol/worker'
import type { ExecutorContext } from '../../../src/sdk/types'
import { createRemoteExecutor } from '../../../src/plugins/executors/remote'
import { remoteManifest } from '../../../src/plugins/executors/remote/manifest'

/**
 * `remote` 执行器插件（M7 架构位）：只测「无传输的明确失败」与「有传输时的转发」。
 * 传输用本文件里的假实现（插件测试不得 import 宿主模块），不起端口、不 spawn 进程。
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

/** 插件不使用上下文（传输由工厂注入）：给空对象即可 */
const ctx = {} as ExecutorContext

function ioRecorder(): { io: ExecutorIO; events: RunEvent[] } {
  const events: RunEvent[] = []
  return { events, io: { emit: (event) => events.push(event) } }
}

/** 记录调用参数的假传输；`cancel` 只记录，不参与本插件的用例 */
function fakeTransport(
  execute: RemoteTransport['execute'],
): RemoteTransport & { calls: Array<{ turn: Turn; io: ExecutorIO; signal: AbortSignal }> } {
  const calls: Array<{ turn: Turn; io: ExecutorIO; signal: AbortSignal }> = []
  return {
    calls,
    async execute(turn, io, signal) {
      calls.push({ turn, io, signal })
      return await execute(turn, io, signal)
    },
    async cancel() {
      return undefined
    },
  }
}

describe('remote manifest 与插件装配', () => {
  it('manifest：id/kind/name/version/capabilities/config 与架构位文案', () => {
    expect(remoteManifest.id).toBe('remote')
    expect(remoteManifest.kind).toBe('executor')
    expect(remoteManifest.name).toBe('远端 Worker')
    expect(remoteManifest.version).toBe('1.0.0')
    // 架构位：不声明能力、没有可填的运行时表单字段
    expect(remoteManifest.capabilities).toEqual([])
    expect(remoteManifest.config).toEqual([])
    expect(remoteManifest.description).toContain('需宿主注入传输')
    expect(remoteManifest.description).toContain('M7')
  })

  it('插件只实现 run（无 probe/models/detect，UI 不能建该运行时）', () => {
    const plugin = createRemoteExecutor(null)

    expect(plugin.run).toBeTypeOf('function')
    expect(plugin.probe).toBeUndefined()
    expect(plugin.models).toBeUndefined()
    expect(plugin.detect).toBeUndefined()
  })
})

describe('createRemoteExecutor：未配置传输', () => {
  it('回执 failed{runtime_missing}，leaseId/turn 原样带回，不抛错', async () => {
    const receipt = await createRemoteExecutor(null).run(
      ctx,
      turnOf({ leaseId: 'run-1:3', turn: 4 }),
      ioRecorder().io,
    )

    expect(receipt).toEqual({
      status: 'failed',
      leaseId: 'run-1:3',
      turn: 4,
      errorCode: 'runtime_missing',
      error: '远端 Worker 传输未配置',
    })
  })
})

describe('createRemoteExecutor：已注入传输', () => {
  it('turn/io/signal 原样交给 execute，事件透传，回执原样返回', async () => {
    const transport = fakeTransport(async (turn, io, signal) => {
      expect(signal).toBe(turn.signal)
      io.emit(eventOf(1))
      return {
        status: 'succeeded',
        leaseId: turn.leaseId,
        turn: turn.turn,
        output: '远端完成',
        sessionId: 'sess-9',
      }
    })
    const turn = turnOf()
    const { io, events } = ioRecorder()

    const receipt = await createRemoteExecutor(transport).run(ctx, turn, io)

    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.turn).toBe(turn)
    expect(transport.calls[0]?.io).toBe(io)
    expect(transport.calls[0]?.signal).toBe(turn.signal)
    expect(events).toEqual([eventOf(1)])
    expect(receipt).toEqual({
      status: 'succeeded',
      leaseId: 'lease-1',
      turn: 2,
      output: '远端完成',
      sessionId: 'sess-9',
    })
  })

  it('传输漏回 leaseId/turn：用本轮 Turn 补齐（与宿主包装层同口径）', async () => {
    const transport = fakeTransport(async () => ({
      status: 'succeeded',
      leaseId: undefined as unknown as string,
      turn: undefined as unknown as number,
      output: 'ok',
    }))

    const receipt = await createRemoteExecutor(transport).run(
      ctx,
      turnOf({ leaseId: 'run-1:3', turn: 4 }),
      ioRecorder().io,
    )

    expect(receipt).toMatchObject({
      status: 'succeeded',
      leaseId: 'run-1:3',
      turn: 4,
      output: 'ok',
    })
  })

  it('回执 leaseId/turn 与本轮不一致：原样带回，交内核拒绝迟到尝试', async () => {
    const transport = fakeTransport(async () => ({
      status: 'succeeded',
      leaseId: 'run-1:0',
      turn: 1,
      output: '旧轮',
    }))

    const receipt = await createRemoteExecutor(transport).run(
      ctx,
      turnOf({ leaseId: 'run-1:3', turn: 4 }),
      ioRecorder().io,
    )

    expect(receipt).toMatchObject({ leaseId: 'run-1:0', turn: 1 })
  })

  it('传输抛 Error：failed{executor_lost}，文案取异常 message', async () => {
    const transport = fakeTransport(async () => {
      throw new Error('worker 掉线')
    })

    const receipt = await createRemoteExecutor(transport).run(ctx, turnOf(), ioRecorder().io)

    expect(receipt).toEqual({
      status: 'failed',
      leaseId: 'lease-1',
      turn: 2,
      errorCode: 'executor_lost',
      error: 'worker 掉线',
    })
  })

  it('传输抛非 Error：文案按 String 归一', async () => {
    const transport = fakeTransport(async () => {
      throw 'socket closed'
    })

    const receipt = await createRemoteExecutor(transport).run(ctx, turnOf(), ioRecorder().io)

    expect(receipt).toMatchObject({ status: 'failed', errorCode: 'executor_lost' })
    expect(receipt.error).toBe('socket closed')
  })

  it('abort：cancelled 回执由传输提供，插件原样返回且不额外 emit', async () => {
    const controller = new AbortController()
    const transport = fakeTransport(async (turn, _io, signal) => {
      // 传输负责 abort 后不再写帧：这里只等 abort，然后回 cancelled
      return await new Promise<Receipt>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve({
              status: 'cancelled',
              leaseId: turn.leaseId,
              turn: turn.turn,
              error: '已取消',
              errorCode: 'cancelled',
            })
          },
          { once: true },
        )
      })
    })
    const turn = turnOf({ signal: controller.signal })
    const { io, events } = ioRecorder()

    const running = createRemoteExecutor(transport).run(ctx, turn, io)
    controller.abort()
    const receipt = await running

    expect(receipt).toMatchObject({
      status: 'cancelled',
      leaseId: 'lease-1',
      turn: 2,
      error: '已取消',
      errorCode: 'cancelled',
    })
    expect(events).toEqual([])
  })
})
