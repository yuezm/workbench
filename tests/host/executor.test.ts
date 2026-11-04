// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, RunUsage } from '../../src/protocol/entities'
import type { ExecutorIO, Turn } from '../../src/protocol/executor'
import {
  createExecutorPort,
  type ExecutorBackend,
  type ExecutorBackendOutcome,
  type ExecutorBackendRequest,
} from '../../src/host/executor'

const usage: RunUsage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
}

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

const outcome = (patch: Partial<ExecutorBackendOutcome> = {}): ExecutorBackendOutcome => ({
  status: 'succeeded',
  output: '完成',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: 'sess-1',
  resumeRejected: false,
  usage,
  durationMs: 12,
  ...patch,
})

/** 记录请求的假后端：每次调用按序返回 responses 里的一项。 */
function fakeBackend(
  responses: Array<ExecutorBackendOutcome | Error>,
  onRequest?: (request: ExecutorBackendRequest) => void,
): ExecutorBackend & { requests: ExecutorBackendRequest[] } {
  const requests: ExecutorBackendRequest[] = []
  return {
    requests,
    execute: async (request) => {
      requests.push(request)
      onRequest?.(request)
      const next = responses[requests.length - 1] ?? responses[responses.length - 1]
      if (!next) throw new Error('测试没有准备好响应')
      if (next instanceof Error) throw next
      return next
    },
  }
}

/** 记录 io 调用的夹具。 */
function ioRecorder(): {
  io: ExecutorIO
  events: RunEvent[]
  sessions: string[]
} {
  const events: RunEvent[] = []
  const sessions: string[] = []
  return {
    events,
    sessions,
    io: {
      emit: (event) => events.push(event),
      session: (id) => sessions.push(id),
    },
  }
}

describe('createExecutorPort：结果归一', () => {
  it('成功：回执带回 leaseId/turn，帧与会话经 io 转发', async () => {
    const backend = fakeBackend([outcome()], (request) => {
      request.onEvent({ seq: 1, type: 'text', text: 'hi' })
      request.onEvent({ seq: 2, type: 'status', status: 'running' })
    })
    const { io, events, sessions } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn(), io)

    expect(receipt).toEqual({
      status: 'succeeded',
      leaseId: 'run-1:1',
      turn: 1,
      output: '完成',
      usage,
      durationMs: 12,
      sessionId: 'sess-1',
      exitCode: 0,
    })
    expect(events).toEqual([
      { seq: 1, type: 'text', text: 'hi' },
      { seq: 2, type: 'status', status: 'running' },
    ])
    expect(sessions).toEqual(['sess-1'])
  })

  it('失败：status/errorCode/exitCode 原样带回', async () => {
    const backend = fakeBackend([
      outcome({
        status: 'failed',
        output: '',
        error: '退出码 1',
        errorCode: 'exit_nonzero',
        exitCode: 1,
        sessionId: null,
      }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn(), io)

    expect(receipt).toMatchObject({ status: 'failed', errorCode: 'exit_nonzero', exitCode: 1 })
    expect(receipt.sessionId).toBeUndefined()
  })

  it('timeout：归为 failed，errorCode 缺省补 timeout', async () => {
    const backend = fakeBackend([
      outcome({ status: 'timeout', output: '半截', error: '运行超时', errorCode: null }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn(), io)

    expect(receipt).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
      output: '半截',
      error: '运行超时',
    })
  })

  it('失败但后端没给 errorCode：缺省归 run_failed', async () => {
    const backend = fakeBackend([
      outcome({
        status: 'failed',
        output: '',
        error: '进程退出',
        errorCode: null,
        exitCode: 1,
        sessionId: null,
      }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn(), io)

    expect(receipt).toMatchObject({
      status: 'failed',
      errorCode: 'run_failed',
      error: '进程退出',
      exitCode: 1,
    })
  })

  it('取消：归为 cancelled，errorCode 缺省补 cancelled', async () => {
    const backend = fakeBackend([
      outcome({ status: 'cancelled', output: '', error: '已取消', errorCode: null }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn(), io)

    expect(receipt).toMatchObject({
      status: 'cancelled',
      errorCode: 'cancelled',
      error: '已取消',
    })
  })

  it('成功但后端给了 errorCode：回执不写（成功没有失败归类）', async () => {
    const backend = fakeBackend([outcome({ errorCode: 'run_failed' })])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn(), io)

    expect(receipt.status).toBe('succeeded')
    expect(receipt.errorCode).toBeUndefined()
    // 后端给 null error（成功）：回执不带失败文案
    expect(receipt.error).toBeUndefined()
  })
})

describe('createExecutorPort：续接重试', () => {
  it('resume_rejected：清掉续接会话重试一次，第二次成功', async () => {
    const backend = fakeBackend([
      outcome({
        status: 'failed',
        output: '',
        error: '会话已失效',
        errorCode: 'run_failed',
        resumeRejected: true,
      }),
      outcome({ output: '重跑成功', sessionId: 'sess-new' }),
    ])
    const { io, sessions } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn({ resumeSessionId: 'sess-old' }), io)

    expect(backend.requests).toHaveLength(2)
    expect(backend.requests[0]?.turn.resumeSessionId).toBe('sess-old')
    expect(backend.requests[1]?.turn.resumeSessionId).toBeNull()
    expect(backend.requests.map((request) => request.requestId)).toEqual(['run-1:1:1', 'run-1:1:2'])
    expect(receipt).toMatchObject({
      status: 'succeeded',
      output: '重跑成功',
      sessionId: 'sess-new',
    })
    expect(receipt.errorCode).toBeUndefined()
    // 两次尝试的会话都经旁路回报；宿主取最后一次（续接会话已失效，新会话接管下一轮）
    expect(sessions).toEqual(['sess-1', 'sess-new'])
  })

  it('重试仍被拒：按 failed 收口并带 resumeRejected，不再重试', async () => {
    const backend = fakeBackend([
      outcome({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
      outcome({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn({ resumeSessionId: 'sess-old' }), io)

    expect(backend.requests).toHaveLength(2)
    expect(receipt).toMatchObject({
      status: 'failed',
      errorCode: 'run_failed',
      resumeRejected: true,
    })
  })

  it('重试期间被取消：保留 cancelled，不把已取消的轮次改写成 failed', async () => {
    const backend = fakeBackend([
      outcome({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
      outcome({
        status: 'cancelled',
        output: '',
        error: '已取消',
        errorCode: 'cancelled',
        resumeRejected: true,
      }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn({ resumeSessionId: 'sess-old' }), io)

    expect(receipt).toMatchObject({
      status: 'cancelled',
      errorCode: 'cancelled',
      resumeRejected: true,
    })
  })

  it('首轮没有续接会话：resumeRejected 也不重试', async () => {
    const backend = fakeBackend([
      outcome({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(turn(), io)

    expect(backend.requests).toHaveLength(1)
    expect(receipt).toMatchObject({ status: 'failed', resumeRejected: true })
  })

  it('信号已取消：不发起重试', async () => {
    const controller = new AbortController()
    controller.abort()
    const backend = fakeBackend([
      outcome({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend).run(
      turn({ resumeSessionId: 'sess-old', signal: controller.signal }),
      io,
    )

    expect(backend.requests).toHaveLength(1)
    expect(receipt).toMatchObject({ status: 'failed', resumeRejected: true })
  })

  it('retryOnResumeRejected=false：不发起重试', async () => {
    const backend = fakeBackend([
      outcome({ status: 'failed', errorCode: 'run_failed', resumeRejected: true }),
    ])
    const { io } = ioRecorder()

    const receipt = await createExecutorPort(backend, { retryOnResumeRejected: false }).run(
      turn({ resumeSessionId: 'sess-old' }),
      io,
    )

    expect(backend.requests).toHaveLength(1)
    expect(receipt).toMatchObject({ status: 'failed', resumeRejected: true })
  })
})

describe('createExecutorPort：请求与 io', () => {
  it('请求带 requestId / timeoutMs / signal，prompt 来自 Turn', async () => {
    const backend = fakeBackend([outcome()])
    const { io } = ioRecorder()
    const current = turn({ timeoutMs: 1234 })

    await createExecutorPort(backend).run(current, io)

    const request = backend.requests[0]
    expect(request?.requestId).toBe('run-1:1:1')
    expect(request?.timeoutMs).toBe(1234)
    expect(request?.signal).toBe(current.signal)
    expect(request?.turn.prompt).toBe('做点什么')
  })

  it('requestId 可覆盖（每次尝试的序号透出给调用方）', async () => {
    const backend = fakeBackend([outcome()])
    const { io } = ioRecorder()

    await createExecutorPort(backend, { requestId: (t, attempt) => `${t.runId}#${attempt}` }).run(
      turn(),
      io,
    )

    expect(backend.requests[0]?.requestId).toBe('run-1#1')
  })

  it('io.session 可缺省：只给 emit 也能跑完', async () => {
    const backend = fakeBackend([outcome()])
    const events: RunEvent[] = []

    const receipt = await createExecutorPort(backend).run(turn(), {
      emit: (event) => events.push(event),
    })

    expect(receipt.sessionId).toBe('sess-1')
    expect(events).toEqual([])
  })

  it('后端抛错：原样透出（兜底终态由宿主负责）', async () => {
    const backend = fakeBackend([new Error('执行器不可达')])
    const { io } = ioRecorder()

    await expect(createExecutorPort(backend).run(turn(), io)).rejects.toThrow('执行器不可达')
  })

  it('后端帧回调抛错也照常转发（适配器不吞帧）', async () => {
    const backend = fakeBackend([outcome()], (request) => {
      request.onEvent({ seq: 1, type: 'text', text: 'a' })
    })
    const emit = vi.fn()
    const { io } = ioRecorder()
    io.emit = emit

    await createExecutorPort(backend).run(turn(), io)

    expect(emit).toHaveBeenCalledWith({ seq: 1, type: 'text', text: 'a' })
  })
})
