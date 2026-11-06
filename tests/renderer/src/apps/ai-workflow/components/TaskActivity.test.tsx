import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Run, RunEvent } from '../../../../../../src/protocol/entities'
import type { TaskComment } from '../../../../../../src/protocol/task-comment'
import { TaskActivity } from '../../../../../../src/renderer/src/apps/ai-workflow/components/TaskActivity'
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

function makeComment(over: Partial<TaskComment> = {}): TaskComment {
  return {
    id: 'c1',
    taskId: 't1',
    author: 'owner',
    text: '按钮改成粉色',
    createdAt: '2026-11-03T00:05:00Z',
    ...over,
  }
}

const text = (seq: number, value: string): RunEvent => ({ seq, type: 'text', text: value })

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

describe('TaskActivity', () => {
  it('既没有运行也没有反馈时提示，且不订阅事件流视图', () => {
    render(<TaskActivity runs={[]} comments={[]} />)
    expect(screen.getByText('还没有运行记录或反馈')).toBeInTheDocument()
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
    render(<TaskActivity runs={[run]} comments={[]} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('最终输出')).toBeInTheDocument()
    expect(list).toHaveTextContent('成功')
    expect(list).toHaveTextContent('2026-11-03T00:00:00Z')
    expect(list).toHaveTextContent('耗时 1.5s')
    expect(list).toHaveTextContent('退出码 0')
    expect(list).toHaveTextContent('输入 12 / 输出 34 tokens')
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
    render(<TaskActivity runs={[run]} comments={[]} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('失败')).toBeInTheDocument()
    expect(list).toHaveTextContent('非零退出')
    expect(list).toHaveTextContent('进程非零退出')
    expect(list).toHaveTextContent('耗时 350ms')
    expect(list).toHaveTextContent('退出码 3')
    expect(list).not.toHaveTextContent('tokens')
    expect(list).not.toHaveTextContent('成功')
  })

  it('协议 result 帧失败归类为「执行失败」', async () => {
    const run = makeRun({ id: 'run2', status: 'failed', errorCode: 'run_failed' })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<TaskActivity runs={[run]} comments={[]} />)
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
    render(<TaskActivity runs={[makeRun({ output: '不应出现的 output' })]} comments={[]} />)

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
    const first = render(<TaskActivity runs={[makeRun()]} comments={[]} />)
    first.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    kernel.failView('run.events', { runId: 'run1' }, 'late')
    const second = render(<TaskActivity runs={[makeRun()]} comments={[]} />)
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
    render(<TaskActivity runs={[run]} comments={[]} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('2026-01-01')).toBeInTheDocument()
    expect(list).not.toHaveTextContent('还没有运行记录或反馈')
    expect(list).not.toHaveTextContent('退出码')
    expect(list).not.toHaveTextContent('耗时')
  })

  it('事件流加载失败展示错误（非 Error 也字符串化）', async () => {
    kernel.failView('run.events', { runId: 'run1' }, 'events-down')
    render(<TaskActivity runs={[makeRun()]} comments={[]} />)
    expect(await screen.findByText(/事件流加载失败：events-down/)).toBeInTheDocument()
  })

  it('运行中的事件随 run.* 事实失效重取，不轮询', async () => {
    vi.useFakeTimers()
    try {
      kernel.setView('run.events', { runId: 'run1' }, [text(1, '第一段')])
      render(<TaskActivity runs={[makeRun({ status: 'running' })]} comments={[]} />)
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
      const { rerender } = render(
        <TaskActivity runs={[makeRun({ status: 'running' })]} comments={[]} />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('完成前')).toBeInTheDocument()

      kernel.setView('run.events', { runId: 'run1' }, [text(1, '完成前'), text(2, '完成后')])
      rerender(<TaskActivity runs={[makeRun({ status: 'succeeded' })]} comments={[]} />)
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

  it('反馈渲染作者与正文：owner 显示「我」，agent 显示「智能体」', () => {
    render(
      <TaskActivity
        runs={[]}
        comments={[makeComment(), makeComment({ id: 'c2', author: 'agent', text: '我改好了' })]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('我')
    expect(items[0]).toHaveTextContent('按钮改成粉色')
    expect(items[1]).toHaveTextContent('智能体')
    expect(items[1]).toHaveTextContent('我改好了')
  })

  it('运行与反馈按 createdAt 混排（同毫秒按 id），空的日期字段不参与排序', () => {
    const early = makeRun({ id: 'r1', createdAt: '2026-11-03T00:00:00Z' })
    const late = makeRun({ id: 'r2', createdAt: '2026-11-03T00:20:00Z', status: 'failed' })
    render(
      <TaskActivity
        runs={[late, early]}
        comments={[makeComment({ id: 'c1', createdAt: '2026-11-03T00:10:00Z' })]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('成功')
    expect(items[1]).toHaveTextContent('按钮改成粉色')
    expect(items[2]).toHaveTextContent('失败')
  })
})
