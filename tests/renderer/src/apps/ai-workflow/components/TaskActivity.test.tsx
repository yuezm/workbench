import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Run, RunEvent } from '../../../../../../src/protocol/entities'
import type { TaskComment } from '../../../../../../src/protocol/task-comment'
import {
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_LINES,
  TaskActivity,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/TaskActivity'
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

/** 当前工作流的阶段（阶段名从这里查） */
const stages = [
  { id: 's0', name: '待办' },
  { id: 's1', name: '执行' },
]

const text = (seq: number, value: string): RunEvent => ({ seq, type: 'text', text: value })

/** 正文缩略的前 6 行（多行正文测试用） */
const head6 = Array.from({ length: SUMMARY_MAX_LINES }, (_, i) => `第${i + 1}行正文`).join('\n')

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

describe('TaskActivity', () => {
  it('既没有运行也没有反馈时提示，且不订阅事件流视图', () => {
    render(<TaskActivity runs={[]} comments={[]} stages={stages} />)
    expect(screen.getByText('还没有运行记录或反馈')).toBeInTheDocument()
    expect(kernel.store.peek('run.events', { runId: 'run1' })).toBeUndefined()
    expect(kernel.store.peekState('run.events', { runId: 'run1' })).toBeUndefined()
  })

  it('完成态 run 展示阶段徽标、轮次、中文状态/时间/耗时/退出码/用量；事件为空回落 output', async () => {
    const run = makeRun({
      output: '最终输出',
      durationMs: 1500,
      exitCode: 0,
      usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<TaskActivity runs={[run]} comments={[]} stages={stages} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('最终输出')).toBeInTheDocument()
    expect(list).toHaveTextContent('成功')
    expect(list).toHaveTextContent('执行')
    expect(list).toHaveTextContent('第 1 轮')
    expect(list).toHaveTextContent('2026-11-03T00:00:00Z')
    expect(list).toHaveTextContent('耗时 1.5s')
    expect(list).toHaveTextContent('退出码 0')
    expect(list).toHaveTextContent('输入 12 / 输出 34 tokens')
    expect(screen.queryByText(/事件流加载失败/)).not.toBeInTheDocument()
  })

  it('多阶段任务：每轮 run 卡片标出阶段名与轮次（按时间算序号，查不到阶段退化）', async () => {
    const first = makeRun({
      id: 'run-a',
      stageId: 's0',
      createdAt: '2026-11-03T00:00:00Z',
      output: '第一轮产出',
    })
    const second = makeRun({
      id: 'run-b',
      stageId: 's1',
      createdAt: '2026-11-03T00:10:00Z',
      output: '第二轮产出',
    })
    const stale = makeRun({
      id: 'run-c',
      stageId: 'gone',
      createdAt: '2026-11-03T00:20:00Z',
      output: '阶段被删的产出',
    })
    const orphan = makeRun({
      id: 'run-d',
      stageId: null,
      createdAt: '2026-11-03T00:30:00Z',
      output: '没有阶段的产出',
    })
    for (const run of [first, second, stale, orphan]) {
      kernel.setView('run.events', { runId: run.id }, [])
    }
    // 传入顺序刻意打乱：轮次按 createdAt 算，不看数组顺序
    render(<TaskActivity runs={[orphan, second, first, stale]} comments={[]} stages={stages} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('第一轮产出')).toBeInTheDocument()
    const cards = within(list).getAllByRole('listitem')
    expect(cards).toHaveLength(4)
    expect(cards[0]).toHaveTextContent('待办')
    expect(cards[0]).toHaveTextContent('第 1 轮')
    expect(cards[1]).toHaveTextContent('执行')
    expect(cards[1]).toHaveTextContent('第 2 轮')
    expect(cards[2]).toHaveTextContent('未知阶段')
    expect(cards[2]).toHaveTextContent('第 3 轮')
    expect(cards[3]).toHaveTextContent('未知阶段')
    expect(cards[3]).toHaveTextContent('第 4 轮')
    // 阶段名只出现在对应那一轮卡片里
    expect(cards[0]).not.toHaveTextContent('执行')
  })

  it('阶段表为空时每一轮都显示「未知阶段」', async () => {
    const run = makeRun({ output: '产出' })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<TaskActivity runs={[run]} comments={[]} stages={[]} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('产出')).toBeInTheDocument()
    expect(list).toHaveTextContent('未知阶段')
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
    render(<TaskActivity runs={[run]} comments={[]} stages={stages} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('失败')).toBeInTheDocument()
    expect(list).toHaveTextContent('非零退出')
    // 失败原因是要人读的，用可播报的 alert 而不是又一段灰字
    expect(within(list).getByRole('alert')).toHaveTextContent('进程非零退出')
    expect(list).toHaveTextContent('耗时 350ms')
    expect(list).toHaveTextContent('退出码 3')
    expect(list).not.toHaveTextContent('tokens')
    expect(list).not.toHaveTextContent('成功')
  })

  it('协议 result 帧失败归类为「执行失败」', async () => {
    const run = makeRun({ id: 'run2', status: 'failed', errorCode: 'run_failed' })
    kernel.setView('run.events', { runId: run.id }, [])
    render(<TaskActivity runs={[run]} comments={[]} stages={stages} />)
    expect(await screen.findByText('执行失败')).toBeInTheDocument()
  })

  it('事件流：正文缩略展示，展开后看全文，过程折叠仍可用', async () => {
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
    render(
      <TaskActivity
        runs={[makeRun({ output: '不应出现的 output' })]}
        comments={[]}
        stages={stages}
      />,
    )

    // 默认缩略：正文可见，过程行被「展开全部」挡住
    expect(await screen.findByText('正文内容')).toBeVisible()
    expect(screen.queryByText('不应出现的 output')).not.toBeInTheDocument()
    expect(screen.queryByText(/过程 ·/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开全部（约 4 字）' }))

    // 展开后：正文全文 + 过程行（默认仍收起）
    const summary = screen.getByText(/过程 · 6 条/)
    const fold = summary.closest('details')
    expect(fold).not.toBeNull()
    expect(fold).not.toHaveAttribute('open')
    expect(screen.getByText('思考内容')).not.toBeVisible()
    expect(screen.getByText('工具结果：read · 读取结果')).not.toBeVisible()

    // 展开后才看得到思考 / 调用 / 结果（含截断与错误态）
    fireEvent.click(summary)
    expect(fold).toHaveAttribute('open')
    expect(screen.getByText('思考内容')).toBeVisible()
    expect(screen.getByText('思考内容').className).toContain('italic')
    expect(screen.getByText(/工具调用：read · \{"path":"a+…$/)).toBeVisible()
    expect(screen.getByText('工具调用：未知工具')).toBeVisible()
    expect(screen.getByText('工具结果：read · 读取结果')).toBeVisible()
    expect(screen.getByText('工具结果：write').className).toContain('text-danger')
    expect(screen.getByText('工具结果：未知工具')).toBeVisible()
    // status 事件既不是正文也不是过程
    expect(screen.queryByText('running')).not.toBeInTheDocument()
    expect(screen.getAllByText('正文内容')).toHaveLength(1)
  })

  it('长正文默认只给前 6 行缩略，点「展开全部」出全文，点「收起」回到缩略', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `第${i + 1}行正文`)
    const longText = lines.join('\n')
    kernel.setView('run.events', { runId: 'run1' }, [text(1, longText)])
    render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)

    // 缩略：只有前 6 行，全文与后续行都不在 DOM 里
    const summary = await screen.findByText(/第1行正文\s+第2行正文/)
    expect(summary).toBeVisible()
    expect(summary.textContent).toBe(head6)
    expect(screen.queryByText(longText)).not.toBeInTheDocument()
    expect(screen.queryByText(/第7行正文/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: `展开全部（约 ${longText.length} 字）` }))
    expect(screen.getByText(/第7行正文/).textContent).toBe(longText)
    // 全文只有一份（缩略被替掉，不是叠加）
    expect(screen.getAllByText(/第1行正文/)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByText(/第1行正文\s+第2行正文/).textContent).toBe(head6)
    expect(screen.queryByText(/第7行正文/)).not.toBeInTheDocument()
  })

  it('单行超长正文按字数截到 400，展开后是全文字', async () => {
    const longText = 'x'.repeat(SUMMARY_MAX_CHARS + 120)
    kernel.setView('run.events', { runId: 'run1' }, [text(1, longText)])
    render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)

    expect(await screen.findByText('x'.repeat(SUMMARY_MAX_CHARS))).toBeVisible()
    expect(screen.queryByText(longText)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `展开全部（约 ${longText.length} 字）` }))
    expect(screen.getByText(longText)).toBeVisible()
  })

  it('折叠状态是每个 run 自己的：展开一轮不影响另一轮', async () => {
    const longText = Array.from({ length: 12 }, (_, i) => `行${i + 1}`).join('\n')
    kernel.setView('run.events', { runId: 'run-a' }, [text(1, longText)])
    kernel.setView('run.events', { runId: 'run-b' }, [text(1, longText)])
    render(
      <TaskActivity
        runs={[
          makeRun({ id: 'run-a', createdAt: '2026-11-03T00:00:00Z' }),
          makeRun({ id: 'run-b', createdAt: '2026-11-03T00:10:00Z' }),
        ]}
        comments={[]}
        stages={stages}
      />,
    )

    const list = screen.getByRole('list', { name: '上下文' })
    const cards = await within(list).findAllByRole('listitem')
    // 两轮都还是缩略
    expect(within(cards[0]).getByText(/行1\s+行2\s+行3/)).toBeVisible()
    expect(within(cards[1]).getByText(/行1\s+行2\s+行3/)).toBeVisible()
    expect(within(list).getAllByRole('button', { name: /展开全部/ })).toHaveLength(2)

    fireEvent.click(within(cards[0]).getByRole('button', { name: /展开全部/ }))
    expect(within(cards[0]).getByRole('button', { name: '收起' })).toBeInTheDocument()
    expect(within(cards[1]).getByRole('button', { name: /展开全部/ })).toBeInTheDocument()
    expect(within(cards[1]).queryByRole('button', { name: '收起' })).not.toBeInTheDocument()
  })

  it('只有正文事件且不超阈值：不渲染「过程」折叠行，也不给「展开全部」', async () => {
    kernel.setView('run.events', { runId: 'run1' }, [text(1, '只有正文')])
    render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)

    expect(await screen.findByText('只有正文')).toBeVisible()
    expect(screen.queryByText(/过程 ·/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /展开全部/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '收起' })).not.toBeInTheDocument()
  })

  it('只有过程事件：正文为空，仍给出可展开的「过程」行', async () => {
    kernel.setView('run.events', { runId: 'run1' }, [
      { seq: 1, type: 'thinking', text: '只在思考' },
    ])
    render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)

    expect(await screen.findByText(/过程 · 1 条/)).toBeInTheDocument()
    expect(screen.getByText('只在思考')).not.toBeVisible()
    expect(screen.queryByRole('button', { name: /展开全部/ })).not.toBeInTheDocument()
  })

  it('同毫秒创建的 run 按 id 定轮次（排序稳定）', async () => {
    const later = makeRun({ id: 'run-b', createdAt: '2026-11-03T00:00:00Z', output: 'B 的产出' })
    const earlier = makeRun({ id: 'run-a', createdAt: '2026-11-03T00:00:00Z', output: 'A 的产出' })
    kernel.setView('run.events', { runId: 'run-a' }, [])
    kernel.setView('run.events', { runId: 'run-b' }, [])
    render(<TaskActivity runs={[later, earlier]} comments={[]} stages={stages} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('A 的产出')).toBeInTheDocument()
    const cards = within(list).getAllByRole('listitem')
    expect(cards[0]).toHaveTextContent('A 的产出')
    expect(cards[0]).toHaveTextContent('第 1 轮')
    expect(cards[1]).toHaveTextContent('B 的产出')
    expect(cards[1]).toHaveTextContent('第 2 轮')
  })

  it('只有 status 事件与空 text 事件：没有正文也没有过程，只留卡片头部', async () => {
    kernel.setView('run.events', { runId: 'run1' }, [
      { seq: 1, type: 'status', status: 'running' },
      { seq: 2, type: 'text' },
    ])
    render(
      <TaskActivity
        runs={[makeRun({ output: '不兜底的 output' })]}
        comments={[]}
        stages={stages}
      />,
    )

    const list = await screen.findByRole('list', { name: '上下文' })
    expect(list).toHaveTextContent('执行')
    expect(screen.queryByText('不兜底的 output')).not.toBeInTheDocument()
    expect(screen.queryByText(/过程 ·/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /展开全部/ })).not.toBeInTheDocument()
  })

  it('未完成的事件请求在卸载后返回/失败都不写状态', async () => {
    const first = render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)
    first.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    kernel.failView('run.events', { runId: 'run1' }, 'late')
    const second = render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)
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
    render(<TaskActivity runs={[run]} comments={[]} stages={stages} />)

    const list = screen.getByRole('list', { name: '上下文' })
    expect(await within(list).findByText('2026-01-01')).toBeInTheDocument()
    expect(list).not.toHaveTextContent('还没有运行记录或反馈')
    expect(list).not.toHaveTextContent('退出码')
    expect(list).not.toHaveTextContent('耗时')
  })

  it('事件流加载失败展示错误（非 Error 也字符串化）', async () => {
    kernel.failView('run.events', { runId: 'run1' }, 'events-down')
    render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('事件流加载失败：events-down')
  })

  it('运行中的事件随 run.* 事实失效重取，不轮询', async () => {
    vi.useFakeTimers()
    try {
      kernel.setView('run.events', { runId: 'run1' }, [text(1, '第一段')])
      render(<TaskActivity runs={[makeRun({ status: 'running' })]} comments={[]} stages={stages} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText('第一段')).toBeInTheDocument()

      kernel.setView('run.events', { runId: 'run1' }, [text(1, '第一段'), text(2, '第二段')])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/第一段\s+第二段/)).toBeInTheDocument()
      expect(kernel.store.peek('run.events', { runId: 'run1' })).toHaveLength(2)

      // 没有新事实：推进时间不产生新的查询/渲染（不轮询）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(screen.getByText(/第一段\s+第二段/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('run 结束后不再追加事件（终态按最新视图渲染）', async () => {
    vi.useFakeTimers()
    try {
      kernel.setView('run.events', { runId: 'run1' }, [text(1, '完成前')])
      const { rerender } = render(
        <TaskActivity runs={[makeRun({ status: 'running' })]} comments={[]} stages={stages} />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('完成前')).toBeInTheDocument()

      kernel.setView('run.events', { runId: 'run1' }, [text(1, '完成前'), text(2, '完成后')])
      rerender(
        <TaskActivity runs={[makeRun({ status: 'succeeded' })]} comments={[]} stages={stages} />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/完成前\s+完成后/)).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(screen.getByText(/完成前\s+完成后/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('提权记录：展示工具 / 结果 / 理由，未知结果原样显示', async () => {
    kernel.setView('run.events', { runId: 'run1' }, [])
    kernel.setView('run.approvals', { runId: 'run1' }, [
      {
        id: 'a1',
        at: '2026-11-04T01:29:18.000Z',
        tool: 'pwsh',
        callId: 'c1',
        reason: '修 ACL',
        outcome: 'allowed-once',
      },
      {
        id: 'a2',
        at: '2026-11-04T01:30:00.000Z',
        tool: '',
        callId: null,
        reason: '',
        outcome: null,
      },
      {
        id: 'a3',
        at: '2026-11-04T01:31:00.000Z',
        tool: 'bash',
        callId: null,
        reason: '',
        outcome: 'weird',
      },
    ])
    render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)

    const list = await screen.findByRole('list', { name: '提权记录' })
    expect(within(list).getByText(/提权 · pwsh/)).toBeInTheDocument()
    expect(within(list).getByText('已自动放行')).toBeInTheDocument()
    expect(within(list).getByText('修 ACL')).toBeInTheDocument()
    expect(within(list).getByText(/提权 · 未知工具/)).toBeInTheDocument()
    expect(within(list).getByText('未落定')).toBeInTheDocument()
    expect(within(list).getByText(/提权 · bash/)).toBeInTheDocument()
    expect(within(list).getByText('weird')).toBeInTheDocument()
  })

  it('没有提权记录：不渲染提权列表', async () => {
    kernel.setView('run.events', { runId: 'run1' }, [])
    kernel.setView('run.approvals', { runId: 'run1' }, [])
    render(<TaskActivity runs={[makeRun()]} comments={[]} stages={stages} />)

    expect(await screen.findByRole('list', { name: '上下文' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '提权记录' })).toBeNull()
  })

  it('反馈渲染作者与正文：owner 显示「我」，agent 显示「智能体」', () => {
    render(
      <TaskActivity
        runs={[]}
        comments={[makeComment(), makeComment({ id: 'c2', author: 'agent', text: '我改好了' })]}
        stages={stages}
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
        stages={stages}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('成功')
    expect(items[0]).toHaveTextContent('第 1 轮')
    expect(items[1]).toHaveTextContent('按钮改成粉色')
    expect(items[2]).toHaveTextContent('失败')
    expect(items[2]).toHaveTextContent('第 2 轮')
  })
})
