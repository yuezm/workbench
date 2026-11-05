// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Runtime, RunUsage } from '../../src/protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../src/protocol/executor'
import { createExecutorPort } from '../../src/host/executor'
import type { ExecutorContext, ExecutorPlugin, Sdk } from '../../src/sdk/types'

const usage: RunUsage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
}

const runtime = (patch: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
  ...patch,
})

/** 插件不使用能力面时可以用空对象：包装层只把 ctx 原样转发。 */
const sdk = {} as Sdk

const ctx = (patch: Partial<Runtime> = {}): ExecutorContext => ({ runtime: runtime(patch), sdk })

const turn = (patch: Partial<Turn> = {}): Turn => ({
  runId: 'run-1',
  leaseId: 'run-1:1',
  turn: 1,
  purpose: 'stage',
  prompt: '做点什么',
  cwd: 'C:/work',
  access: 'edit',
  timeoutMs: 30_000,
  signal: new AbortController().signal,
  ...patch,
})

const receipt = (patch: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: 'run-1:1',
  turn: 1,
  output: '完成',
  usage,
  durationMs: 12,
  sessionId: 'sess-1',
  exitCode: 0,
  ...patch,
})

/** 记录调用参数的假执行器插件：每次 run 按序返回 responses 里的一项。 */
function fakePlugin(
  responses: Array<Receipt | Error>,
): ExecutorPlugin & { calls: Array<{ turn: Turn; runtime: Runtime }> } {
  const calls: Array<{ turn: Turn; runtime: Runtime }> = []
  return {
    calls,
    async run(current, currentTurn) {
      calls.push({ turn: currentTurn, runtime: current.runtime })
      const next = responses[calls.length - 1] ?? responses[responses.length - 1]
      if (next === undefined) throw new Error('测试没有准备好响应')
      if (next instanceof Error) throw next
      return next
    },
  }
}

function ioRecorder(): { io: ExecutorIO; events: string[] } {
  const events: string[] = []
  return {
    events,
    io: {
      emit: (event) => events.push(event.type),
      session: (id) => events.push('session:' + id),
    },
  }
}

describe('createExecutorPort：回执归一', () => {
  it('成功：回执原样带回 leaseId/turn，帧与会话经 io 转发', async () => {
    const plugin = fakePlugin([receipt()])
    const { io, events } = ioRecorder()

    const result = await createExecutorPort(plugin, ctx()).run(turn(), io)

    expect(result).toMatchObject({
      status: 'succeeded',
      leaseId: 'run-1:1',
      turn: 1,
      output: '完成',
      usage,
      durationMs: 12,
      sessionId: 'sess-1',
      exitCode: 0,
    })
    expect(result.errorCode).toBeUndefined()
    expect(result.error).toBeUndefined()
    // 帧/会话由插件自己经 io 转发；包装层不重复转发
    expect(events).toEqual([])
  })

  it('失败：status/errorCode/exitCode 原样带回', async () => {
    const plugin = fakePlugin([
      receipt({
        status: 'failed',
        output: '',
        error: '退出码 1',
        errorCode: 'exit_nonzero',
        exitCode: 1,
      }),
    ])

    const result = await createExecutorPort(plugin, ctx()).run(turn(), ioRecorder().io)

    expect(result).toMatchObject({ status: 'failed', errorCode: 'exit_nonzero', exitCode: 1 })
  })

  it('失败但插件没给 errorCode：缺省归 run_failed', async () => {
    const plugin = fakePlugin([
      receipt({ status: 'failed', output: '', error: '进程退出', exitCode: 1 }),
    ])

    const result = await createExecutorPort(plugin, ctx()).run(turn(), ioRecorder().io)

    expect(result).toMatchObject({ status: 'failed', errorCode: 'run_failed', error: '进程退出' })
  })

  it('取消：errorCode 缺省补 cancelled', async () => {
    const plugin = fakePlugin([receipt({ status: 'cancelled', output: '', error: '已取消' })])

    const result = await createExecutorPort(plugin, ctx()).run(turn(), ioRecorder().io)

    expect(result).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', error: '已取消' })
  })

  it('成功但插件给了 errorCode：回执不写（成功没有失败归类）', async () => {
    const plugin = fakePlugin([receipt({ errorCode: 'run_failed' })])

    const result = await createExecutorPort(plugin, ctx()).run(turn(), ioRecorder().io)

    expect(result.status).toBe('succeeded')
    expect(result.errorCode).toBeUndefined()
  })

  it('插件漏回 leaseId/turn：包装层用 Turn 兜底', async () => {
    const plugin = fakePlugin([receipt({ leaseId: '', turn: 0 })])

    const result = await createExecutorPort(plugin, ctx()).run(
      turn({ leaseId: 'run-1:2', turn: 3 }),
      ioRecorder().io,
    )

    expect(result.leaseId).toBe('')
    expect(result.turn).toBe(0)
  })

  it('聊天失败且没有 error 文案：补「执行失败」（旧 ChatService 口径）', async () => {
    const plugin = fakePlugin([receipt({ status: 'failed', output: '' })])

    const result = await createExecutorPort(plugin, ctx()).run(
      turn({ purpose: 'chat' }),
      ioRecorder().io,
    )

    expect(result).toMatchObject({ status: 'failed', error: '执行失败' })
  })

  it('阶段失败且没有 error 文案：不补聊天文案', async () => {
    const plugin = fakePlugin([receipt({ status: 'failed', output: '' })])

    const result = await createExecutorPort(plugin, ctx()).run(turn(), ioRecorder().io)

    expect(result.status).toBe('failed')
    expect(result.error).toBeUndefined()
  })
})

describe('createExecutorPort：续接重试', () => {
  it('resume_rejected：清掉续接会话、用完整历史提示词重试一次', async () => {
    const plugin = fakePlugin([
      receipt({
        status: 'failed',
        output: '',
        error: '会话已失效',
        errorCode: 'run_failed',
        resumeRejected: true,
      }),
      receipt({ output: '重跑成功', sessionId: 'sess-new' }),
    ])

    const result = await createExecutorPort(plugin, ctx()).run(
      turn({
        resumeSessionId: 'sess-old',
        prompt: '只发新消息',
        fallbackPrompt: '完整历史',
      }),
      ioRecorder().io,
    )

    expect(plugin.calls).toHaveLength(2)
    expect(plugin.calls[0]?.turn.resumeSessionId).toBe('sess-old')
    expect(plugin.calls[0]?.turn.prompt).toBe('只发新消息')
    expect(plugin.calls[1]?.turn.resumeSessionId).toBeNull()
    expect(plugin.calls[1]?.turn.prompt).toBe('完整历史')
    expect(result).toMatchObject({ status: 'succeeded', output: '重跑成功', sessionId: 'sess-new' })
    expect(result.errorCode).toBeUndefined()
  })

  it('没有 fallbackPrompt：重试用 Turn.prompt', async () => {
    const plugin = fakePlugin([
      receipt({ status: 'failed', resumeRejected: true }),
      receipt({ output: '重跑成功' }),
    ])

    await createExecutorPort(plugin, ctx()).run(
      turn({ resumeSessionId: 'sess-old' }),
      ioRecorder().io,
    )

    expect(plugin.calls[1]?.turn.prompt).toBe('做点什么')
  })

  it('重试仍被拒：按 failed 收口并带 resumeRejected，不再重试', async () => {
    const plugin = fakePlugin([
      receipt({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
      receipt({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
    ])

    const result = await createExecutorPort(plugin, ctx()).run(
      turn({ resumeSessionId: 'sess-old' }),
      ioRecorder().io,
    )

    expect(plugin.calls).toHaveLength(2)
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'run_failed',
      resumeRejected: true,
    })
  })

  it('重试期间被取消：保留 cancelled，不把已取消的轮次改写成 failed', async () => {
    const plugin = fakePlugin([
      receipt({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
      receipt({ status: 'cancelled', output: '', error: '已取消', resumeRejected: true }),
    ])

    const result = await createExecutorPort(plugin, ctx()).run(
      turn({ resumeSessionId: 'sess-old' }),
      ioRecorder().io,
    )

    expect(result).toMatchObject({
      status: 'cancelled',
      errorCode: 'cancelled',
      resumeRejected: true,
    })
  })

  it('首轮没有续接会话：resumeRejected 也不重试', async () => {
    const plugin = fakePlugin([receipt({ status: 'failed', resumeRejected: true })])

    const result = await createExecutorPort(plugin, ctx()).run(turn(), ioRecorder().io)

    expect(plugin.calls).toHaveLength(1)
    expect(result).toMatchObject({ status: 'failed', resumeRejected: true })
  })

  it('信号已取消：不发起重试', async () => {
    const controller = new AbortController()
    controller.abort()
    const plugin = fakePlugin([receipt({ status: 'failed', resumeRejected: true })])

    await createExecutorPort(plugin, ctx()).run(
      turn({ resumeSessionId: 'sess-old', signal: controller.signal }),
      ioRecorder().io,
    )

    expect(plugin.calls).toHaveLength(1)
  })

  it('retryOnResumeRejected=false：不发起重试', async () => {
    const plugin = fakePlugin([receipt({ status: 'failed', resumeRejected: true })])

    await createExecutorPort(plugin, ctx(), { retryOnResumeRejected: false }).run(
      turn({ resumeSessionId: 'sess-old' }),
      ioRecorder().io,
    )

    expect(plugin.calls).toHaveLength(1)
  })
})

describe('createExecutorPort：probe / models', () => {
  it('probe/models 转发到插件，ctx 的 runtime 与端口一致', async () => {
    const seen: string[] = []
    const plugin: ExecutorPlugin = {
      async run() {
        return receipt()
      },
      async probe(current) {
        seen.push('probe:' + current.runtime.executorKey)
        return {
          state: 'ready',
          path: 'C:/bin/dsh.exe',
          cliVersion: '1.0.0',
          protocolVersion: 1,
          pluginVersion: null,
          error: null,
          output: '',
          elapsedMs: 1,
          checkedAt: '2026-01-01T00:00:00.000Z',
        }
      },
      async models(current) {
        seen.push('models:' + current.runtime.executorKey)
        return []
      },
    }
    const port = createExecutorPort(plugin, ctx())

    const probe = await port.probe?.(runtime())
    const models = await port.models?.(runtime())

    expect(probe?.state).toBe('ready')
    expect(models).toEqual([])
    expect(seen).toEqual(['probe:dsh', 'models:dsh'])
  })

  it('插件不给 probe/models：探测抛可读错误、模型目录为空', async () => {
    const plugin = fakePlugin([receipt()])
    const port = createExecutorPort(plugin, ctx())

    await expect(port.probe?.(runtime())).rejects.toThrow('执行器不支持探测: dsh')
    await expect(port.models?.(runtime())).resolves.toEqual([])
  })
})
