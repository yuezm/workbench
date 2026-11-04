import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Run, RunEvent } from '../../../../../../src/shared/ai-workflow-api'
import { RunLog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RunLog'

function setApi(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

function setEvents(events: (runId: string) => Promise<RunEvent[]>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(events)
  setApi({ runs: { events: fn } })
  return fn
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'run1',
    taskId: 't1',
    stageId: 's1',
    agentId: 'a1',
    runtimeId: 'r1',
    status: 'succeeded',
    prompt: 'p',
    output: '',
    error: null,
    errorCode: null,
    exitCode: 0,
    sessionId: null,
    usage: null,
    durationMs: null,
    startedAt: '2026-11-03T00:00:00Z',
    endedAt: '2026-11-03T00:01:00Z',
    createdAt: '2026-11-03T00:00:00Z',
    ...over,
  }
}

const text = (seq: number, value: string): RunEvent => ({ seq, type: 'text', text: value })

describe('RunLog', () => {
  it('无运行记录时提示，且不请求事件流', () => {
    const events = setEvents(async () => [])
    render(<RunLog runs={[]} />)
    expect(screen.getByText('暂无运行记录')).toBeInTheDocument()
    expect(events).not.toHaveBeenCalled()
  })

  it('完成态 run 展示中文状态/时间/耗时/退出码/用量；事件为空回落 output', async () => {
    setEvents(async () => [])
    const run = makeRun({
      output: '最终输出',
      durationMs: 1500,
      exitCode: 0,
      usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    render(<RunLog runs={[run]} />)

    expect(await screen.findByText('最终输出')).toBeInTheDocument()
    expect(screen.getByText('成功')).toBeInTheDocument()
    expect(screen.getByText('2026-11-03T00:00:00Z')).toBeInTheDocument()
    expect(screen.getByText('耗时 1.5s')).toBeInTheDocument()
    expect(screen.getByText('退出码 0')).toBeInTheDocument()
    expect(screen.getByText('输入 12 / 输出 34 tokens')).toBeInTheDocument()
  })

  it('失败 run 展示 errorCode 中文文案、失败原因与毫秒耗时', async () => {
    setEvents(async () => [])
    const run = makeRun({
      status: 'failed',
      errorCode: 'exit_nonzero',
      error: '进程非零退出',
      exitCode: 3,
      durationMs: 350,
      usage: null,
    })
    render(<RunLog runs={[run]} />)

    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(screen.getByText('非零退出')).toBeInTheDocument()
    expect(screen.getByText('进程非零退出')).toBeInTheDocument()
    expect(screen.getByText('耗时 350ms')).toBeInTheDocument()
    expect(screen.getByText('退出码 3')).toBeInTheDocument()
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument()
  })

  it('协议 result 帧失败归类为「执行失败」', async () => {
    setEvents(async () => [])
    render(<RunLog runs={[makeRun({ status: 'failed', errorCode: 'run_failed' })]} />)
    expect(await screen.findByText('执行失败')).toBeInTheDocument()
  })

  it('事件流按类型渲染：正文 / 思考 / 工具调用与结果（含截断与错误态）', async () => {
    const longInput = `{"path":"${'a'.repeat(200)}"}`
    setEvents(async () => [
      text(1, '正文内容'),
      { seq: 2, type: 'thinking', text: '思考内容' },
      { seq: 3, type: 'tool_call', tool: 'read', input: longInput },
      { seq: 4, type: 'tool_call' },
      { seq: 5, type: 'tool_result', tool: 'read', output: '读取结果' },
      { seq: 6, type: 'tool_result', tool: 'write', isError: true },
      { seq: 7, type: 'tool_result' },
      { seq: 8, type: 'status', status: 'running' },
    ])
    render(<RunLog runs={[makeRun({ output: '不应出现的 output' })]} />)

    expect(await screen.findByText('正文内容')).toBeInTheDocument()
    expect(screen.getByText('思考内容').className).toContain('italic')
    expect(screen.queryByText('不应出现的 output')).not.toBeInTheDocument()
    expect(screen.getByText(/工具调用：read · \{"path":"a+…$/)).toBeInTheDocument()
    expect(screen.getByText('工具调用：未知工具')).toBeInTheDocument()
    expect(screen.getByText('工具结果：read · 读取结果')).toBeInTheDocument()
    expect(screen.getByText('工具结果：write').className).toContain('text-red-300')
    expect(screen.getByText('工具结果：未知工具')).toBeInTheDocument()
    // status 事件不进事件流
    expect(screen.queryByText('running')).not.toBeInTheDocument()
  })

  it('未完成的事件请求在卸载后返回/失败都不写状态', async () => {
    const pending = deferred<RunEvent[]>()
    const events = setEvents(() => pending.promise)
    const first = render(<RunLog runs={[makeRun()]} />)
    first.unmount()

    pending.resolve([text(1, '迟到正文')])
    await act(async () => {
      await Promise.resolve()
    })
    expect(events).toHaveBeenCalledTimes(1)

    const failing = deferred<RunEvent[]>()
    events.mockReturnValueOnce(failing.promise)
    const second = render(<RunLog runs={[makeRun()]} />)
    second.unmount()
    failing.reject(new Error('late'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText(/事件流加载失败/)).not.toBeInTheDocument()
  })

  it('缺字段的 run 用 createdAt 兜底；无事件且无输出时不渲染正文', async () => {
    setEvents(async () => [])
    const run = makeRun({
      startedAt: null,
      createdAt: '2026-01-01',
      exitCode: null,
      output: '',
    })
    render(<RunLog runs={[run]} />)

    expect(await screen.findByText('2026-01-01')).toBeInTheDocument()
    expect(screen.queryByText(/退出码/)).not.toBeInTheDocument()
    expect(screen.queryByText(/耗时/)).not.toBeInTheDocument()
  })

  it('非 Error 的加载失败也字符串化展示', async () => {
    setEvents(() => Promise.reject('events-down'))
    render(<RunLog runs={[makeRun()]} />)
    expect(await screen.findByText(/事件流加载失败：events-down/)).toBeInTheDocument()
  })

  it('事件流加载失败展示错误', async () => {
    setEvents(() => Promise.reject(new Error('events-boom')))
    render(<RunLog runs={[makeRun()]} />)
    expect(await screen.findByText(/事件流加载失败：events-boom/)).toBeInTheDocument()
  })

  it('运行中每 1s 轮询增量、按 seq 去重，卸载后停止', async () => {
    vi.useFakeTimers()
    try {
      const events = setEvents(async () => [])
      events
        .mockResolvedValueOnce([text(1, '第一段')])
        .mockResolvedValue([text(1, '第一段'), text(2, '第二段')])

      const { unmount } = render(<RunLog runs={[makeRun({ status: 'running' })]} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(events).toHaveBeenCalledTimes(1)
      expect(events).toHaveBeenCalledWith('run1')
      expect(screen.getByText('第一段')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(events).toHaveBeenCalledTimes(2)
      expect(screen.getByText('第二段')).toBeInTheDocument()
      expect(screen.getAllByText('第一段')).toHaveLength(1)

      // 重复事件不重复渲染
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(events).toHaveBeenCalledTimes(3)
      expect(screen.getAllByText('第二段')).toHaveLength(1)

      const before = events.mock.calls.length
      unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(events).toHaveBeenCalledTimes(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('run 结束后停止轮询', async () => {
    vi.useFakeTimers()
    try {
      const events = setEvents(async () => [])
      const { rerender } = render(<RunLog runs={[makeRun({ status: 'running' })]} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(events).toHaveBeenCalledTimes(1)

      rerender(<RunLog runs={[makeRun({ status: 'succeeded' })]} />)
      await act(async () => {
        await Promise.resolve()
      })
      // 新状态只拉一次（不是运行中）
      expect(events).toHaveBeenCalledTimes(2)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(events).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
