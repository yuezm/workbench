import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Run, RunEvent } from '../../../../../../src/protocol/entities'
import { RunLog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RunLog'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

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

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

describe('RunLog', () => {
  it('无运行记录时提示，且不订阅事件流视图', () => {
    render(<RunLog runs={[]} />)
    expect(screen.getByText('暂无运行记录')).toBeInTheDocument()
    expect(kernel.store.peek('run.events', { runId: 'run1' })).toBeUndefined()
    expect(kernel.store.peekState('run.events', { runId: 'run1' })).toBeUndefined()
  })

  it('完成态 run 展示中文状态/时间/耗时/退出码/用量；事件为空回落 output', async () => {
    const run = makeRun({
      output: '最终输出',
      durationMs: 1500,
      exitCode: 0,
      usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<RunLog runs={[run]} />)

    expect(await screen.findByText('最终输出')).toBeInTheDocument()
    expect(screen.getByText('成功')).toBeInTheDocument()
    expect(screen.getByText('2026-11-03T00:00:00Z')).toBeInTheDocument()
    expect(screen.getByText('耗时 1.5s')).toBeInTheDocument()
    expect(screen.getByText('退出码 0')).toBeInTheDocument()
    expect(screen.getByText('输入 12 / 输出 34 tokens')).toBeInTheDocument()
    expect(screen.queryByText(/事件流加载失败/)).not.toBeInTheDocument()
  })

  it('失败 run 展示 errorCode 中文文案、失败原因与毫秒耗时', async () => {
    const run = makeRun({
      status: 'failed',
      errorCode: 'exit_nonzero',
      error: '进程非零退出',
      exitCode: 3,
      durationMs: 350,
      usage: null,
    })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<RunLog runs={[run]} />)

    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(screen.getByText('非零退出')).toBeInTheDocument()
    expect(screen.getByText('进程非零退出')).toBeInTheDocument()
    expect(screen.getByText('耗时 350ms')).toBeInTheDocument()
    expect(screen.getByText('退出码 3')).toBeInTheDocument()
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument()
    expect(screen.queryByText('成功')).not.toBeInTheDocument()
  })

  it('协议 result 帧失败归类为「执行失败」', async () => {
    const run = makeRun({ id: 'run2', status: 'failed', errorCode: 'run_failed' })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<RunLog runs={[run]} />)
    expect(await screen.findByText('执行失败')).toBeInTheDocument()
  })

  it('事件流按类型渲染：正文 / 思考 / 工具调用与结果（含截断与错误态）', async () => {
    const longInput = `{"path":"${'a'.repeat(200)}"}`
    kernel.setView('run.events', { runId: 'run1' }, [
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
    expect(screen.getAllByText('正文内容')).toHaveLength(1)
  })

  it('未完成的事件请求在卸载后返回/失败都不写状态', async () => {
    const first = render(<RunLog runs={[makeRun()]} />)
    first.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    kernel.failView('run.events', { runId: 'run1' }, 'late')
    const second = render(<RunLog runs={[makeRun()]} />)
    second.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText(/事件流加载失败/)).not.toBeInTheDocument()
  })

  it('缺字段的 run 用 createdAt 兜底；无事件且无输出时不渲染正文', async () => {
    const run = makeRun({
      startedAt: null,
      createdAt: '2026-01-01',
      exitCode: null,
      output: '',
    })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<RunLog runs={[run]} />)

    expect(await screen.findByText('2026-01-01')).toBeInTheDocument()
    expect(screen.queryByText('暂无运行记录')).not.toBeInTheDocument()
    expect(screen.queryByText(/退出码/)).not.toBeInTheDocument()
    expect(screen.queryByText(/耗时/)).not.toBeInTheDocument()
  })

  it('非 Error 的加载失败也字符串化展示', async () => {
    kernel.failView('run.events', { runId: 'run1' }, 'events-down')
    render(<RunLog runs={[makeRun()]} />)
    expect(await screen.findByText(/事件流加载失败：events-down/)).toBeInTheDocument()
  })

  it('事件流加载失败展示错误', async () => {
    kernel.failView('run.events', { runId: 'run1' }, 'events-boom')
    render(<RunLog runs={[makeRun()]} />)
    expect(await screen.findByText(/事件流加载失败：events-boom/)).toBeInTheDocument()
  })

  it('运行中的事件随 run.* 事实失效重取，不轮询', async () => {
    vi.useFakeTimers()
    try {
      kernel.setView('run.events', { runId: 'run1' }, [text(1, '第一段')])
      render(<RunLog runs={[makeRun({ status: 'running' })]} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText('第一段')).toBeInTheDocument()

      kernel.setView('run.events', { runId: 'run1' }, [text(1, '第一段'), text(2, '第二段')])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('第二段')).toBeInTheDocument()
      expect(screen.getAllByText('第一段')).toHaveLength(1)
      expect(kernel.store.peek('run.events', { runId: 'run1' })).toHaveLength(2)

      // 没有新事实：推进时间不产生新的查询/渲染（不轮询）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(screen.getAllByText('第二段')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('run 结束后不再追加事件（终态按最新视图渲染）', async () => {
    vi.useFakeTimers()
    try {
      kernel.setView('run.events', { runId: 'run1' }, [text(1, '完成前')])
      const { rerender } = render(<RunLog runs={[makeRun({ status: 'running' })]} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('完成前')).toBeInTheDocument()

      kernel.setView('run.events', { runId: 'run1' }, [text(1, '完成前'), text(2, '完成后')])
      rerender(<RunLog runs={[makeRun({ status: 'succeeded' })]} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('完成后')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(screen.getAllByText('完成前')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
