import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AiWorkflowApi,
  Run,
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../shared/ai-workflow-api'
import { KanbanBoard } from './KanbanBoard'

function setApi(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

function stage(
  id: string,
  name: string,
  position: number,
  entryMode: WorkflowStage['entryMode'],
): WorkflowStage {
  return {
    id,
    workflowId: 'w',
    name,
    position,
    entryMode,
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
  }
}

const wf: WorkflowWithStages = {
  id: 'w',
  name: '研发',
  description: '',
  createdAt: 't',
  stages: [stage('s0', '待办', 0, 'none'), stage('s1', '审核', 1, 'user')],
}

/** agent 阶段的工作流：覆盖「执行中 / 上次执行未完成」两种卡片状态 */
const agentWf: WorkflowWithStages = {
  ...wf,
  stages: [stage('s0', '待办', 0, 'none'), stage('s1', '执行', 1, 'agent')],
}

const task: Task = {
  id: 't1',
  title: '卡片任务',
  description: '',
  workflowId: 'w',
  currentStageId: 's1',
  status: 'active',
  createdAt: 't',
  updatedAt: 't',
}

const doneTask: Task = {
  ...task,
  id: 't0',
  title: '已完成的活',
  currentStageId: 's1',
  status: 'completed',
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
    startedAt: 't',
    endedAt: 't',
    createdAt: 't',
    ...over,
  }
}

interface Harness {
  listByTask: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  setRuns: (taskId: string, runs: Run[]) => void
  emitChanged: () => void
}

/** 安装 runs.listByTask + onChanged 测试桩；可按任务预设 run 列表 */
function makeApi(runsByTask: Record<string, Run[]> = {}): Harness {
  let cb: (() => void) | undefined
  const off = vi.fn()
  const listByTask = vi.fn(async (taskId: string) => runsByTask[taskId] ?? [])
  const onChanged = vi.fn((next: () => void) => {
    cb = next
    return off
  })
  setApi({ runs: { listByTask }, onChanged } as unknown as Partial<AiWorkflowApi>)
  return {
    listByTask,
    onChanged,
    off,
    setRuns: (taskId, runs) => {
      runsByTask[taskId] = runs
    },
    emitChanged: () => cb?.(),
  }
}

function setup(
  tasks: Task[] = [task],
  board: WorkflowWithStages = wf,
): {
  onMoveToStage: ReturnType<typeof vi.fn>
  onCompleteTask: ReturnType<typeof vi.fn>
  onNewTask: ReturnType<typeof vi.fn>
} {
  const onMoveToStage = vi.fn()
  const onCompleteTask = vi.fn()
  const onNewTask = vi.fn()
  render(
    <KanbanBoard
      workflow={board}
      tasks={tasks}
      onMoveToStage={onMoveToStage}
      onCompleteTask={onCompleteTask}
      onNewTask={onNewTask}
    />,
  )
  return { onMoveToStage, onCompleteTask, onNewTask }
}

describe('KanbanBoard', () => {
  it('按阶段分列、渲染卡片与已完成计数，支持新建', async () => {
    makeApi()
    const onNewTask = vi.fn()
    const user = userEvent.setup()
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[task, doneTask]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={onNewTask}
      />,
    )
    expect(screen.getByText('工作流「研发」')).toBeInTheDocument()
    expect(screen.getByText('拖拽卡片切换阶段')).toBeInTheDocument()
    expect(screen.getByText('待办')).toBeInTheDocument()
    expect(screen.getByText('审核')).toBeInTheDocument()
    expect(screen.getByText('卡片任务')).toBeInTheDocument()
    expect(screen.queryByText('已完成的活')).not.toBeInTheDocument()

    const done = screen.getByRole('group', { name: '已完成区' })
    expect(within(done).getByText('1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    expect(onNewTask).toHaveBeenCalled()
  })

  it('拖到其它阶段列触发 moveToStage，拖拽中空列提示落点', () => {
    makeApi()
    const { onMoveToStage, onCompleteTask } = setup()
    fireEvent.dragStart(screen.getByLabelText('任务：卡片任务'))
    expect(screen.getByText('拖到这里')).toBeInTheDocument()

    const target = screen.getByRole('group', { name: '阶段：待办' })
    fireEvent.dragOver(target)
    fireEvent.dragLeave(target)
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    expect(onMoveToStage).toHaveBeenCalledWith('t1', 's0')
    // 拖拽结束后空列恢复原提示
    expect(screen.getByText('空')).toBeInTheDocument()
    expect(onCompleteTask).not.toHaveBeenCalled()
  })

  it('落回当前阶段不触发 moveToStage', () => {
    makeApi()
    const { onMoveToStage } = setup()
    fireEvent.dragStart(screen.getByLabelText('任务：卡片任务'))
    fireEvent.drop(screen.getByRole('group', { name: '阶段：审核' }))
    expect(onMoveToStage).not.toHaveBeenCalled()
  })

  it('拖到「已完成」区触发 completeTask', () => {
    makeApi()
    const { onCompleteTask } = setup()
    const done = screen.getByRole('group', { name: '已完成区' })
    fireEvent.dragStart(screen.getByLabelText('任务：卡片任务'))
    fireEvent.dragOver(done)
    fireEvent.dragLeave(done)
    fireEvent.dragOver(done)
    fireEvent.drop(done)
    expect(onCompleteTask).toHaveBeenCalledWith('t1')
  })

  it('没有拖拽来源时，悬停与落下都不触发任何回调', () => {
    makeApi()
    const { onMoveToStage, onCompleteTask } = setup()
    const target = screen.getByRole('group', { name: '阶段：待办' })
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    fireEvent.dragOver(screen.getByRole('group', { name: '已完成区' }))
    fireEvent.drop(screen.getByRole('group', { name: '已完成区' }))
    expect(onMoveToStage).not.toHaveBeenCalled()
    expect(onCompleteTask).not.toHaveBeenCalled()
  })

  it('有 queued/running 的 run 时卡片执行中且不可拖', async () => {
    const api = makeApi({
      t1: [makeRun({ status: 'running' }), makeRun({ id: 'run0', status: 'succeeded' })],
    })
    setup([task], agentWf)

    expect(await screen.findByText('执行中…')).toBeInTheDocument()
    const card = screen.getByLabelText('任务：卡片任务')
    expect(card).toHaveAttribute('draggable', 'false')
    expect(card.className).toContain('cursor-default')
    expect(api.listByTask).toHaveBeenCalledWith('t1')
  })

  it('queued 也算执行中；失败/取消/成功都不锁卡片', async () => {
    const second: Task = { ...task, id: 't2', title: '待办任务', currentStageId: 's0' }
    makeApi({
      t1: [makeRun({ status: 'queued' })],
      t2: [
        makeRun({ id: 'run2', taskId: 't2', status: 'failed' }),
        makeRun({ id: 'run3', taskId: 't2', status: 'cancelled' }),
      ],
    })
    setup([task, second], agentWf)

    expect(await screen.findByText('执行中…')).toBeInTheDocument()
    expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'false')
    // t2 无活跃 run：可拖，且文案按进入方式提示
    expect(screen.getByLabelText('任务：待办任务')).toHaveAttribute('draggable', 'true')
    expect(screen.getByText('拖到其它阶段推进')).toBeInTheDocument()
  })

  it('agent 阶段失败后无活跃 run：显示可拖走重试文案', async () => {
    makeApi({ t1: [makeRun({ status: 'failed' })] })
    setup([task], agentWf)

    expect(await screen.findByText('上次执行未完成，可拖走重试')).toBeInTheDocument()
    const card = screen.getByLabelText('任务：卡片任务')
    expect(card).toHaveAttribute('draggable', 'true')
    expect(card.className).toContain('cursor-grab')
  })

  it('tasks 变化后重新查询执行状态，已完成任务不查询', async () => {
    const api = makeApi()
    const onMoveToStage = vi.fn()
    const onCompleteTask = vi.fn()
    const onNewTask = vi.fn()
    const { rerender } = render(
      <KanbanBoard
        workflow={wf}
        tasks={[doneTask]}
        onMoveToStage={onMoveToStage}
        onCompleteTask={onCompleteTask}
        onNewTask={onNewTask}
      />,
    )
    await waitFor(() => expect(api.listByTask).not.toHaveBeenCalled())

    const next: Task = { ...task, id: 't2', title: '新任务' }
    rerender(
      <KanbanBoard
        workflow={wf}
        tasks={[next]}
        onMoveToStage={onMoveToStage}
        onCompleteTask={onCompleteTask}
        onNewTask={onNewTask}
      />,
    )
    await waitFor(() => expect(api.listByTask).toHaveBeenCalledWith('t2'))
  })

  it('onChanged 时刷新执行状态；卸载后忽略迟到事件并退订', async () => {
    const api = makeApi({ t1: [] })
    const { unmount } = render(
      <KanbanBoard
        workflow={agentWf}
        tasks={[task]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    await waitFor(() => expect(api.listByTask).toHaveBeenCalledWith('t1'))
    expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'true')

    api.setRuns('t1', [makeRun({ status: 'running' })])
    await act(async () => {
      api.emitChanged()
    })
    await waitFor(() =>
      expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'false'),
    )

    unmount()
    expect(api.off).toHaveBeenCalledTimes(1)
    const calls = api.listByTask.mock.calls.length
    act(() => api.emitChanged())
    await waitFor(() => expect(api.listByTask).toHaveBeenCalledTimes(calls))
  })

  it('执行状态查询在卸载后返回/失败都不写状态', async () => {
    const resolveLater: { promise: Promise<Run[]>; resolve: (runs: Run[]) => void } = (() => {
      let resolve!: (runs: Run[]) => void
      const promise = new Promise<Run[]>((res) => {
        resolve = res
      })
      return { promise, resolve }
    })()
    const listByTask = vi.fn(() => resolveLater.promise)
    setApi({ runs: { listByTask } } as unknown as Partial<AiWorkflowApi>)

    const onMoveToStage = vi.fn()
    const onCompleteTask = vi.fn()
    const onNewTask = vi.fn()
    const first = render(
      <KanbanBoard
        workflow={agentWf}
        tasks={[task]}
        onMoveToStage={onMoveToStage}
        onCompleteTask={onCompleteTask}
        onNewTask={onNewTask}
      />,
    )
    first.unmount()
    resolveLater.resolve([makeRun({ status: 'running' })])
    await act(async () => {
      await Promise.resolve()
    })

    let rejectLater!: (e: unknown) => void
    const rejectPromise = new Promise<Run[]>((_res, rej) => {
      rejectLater = rej
    })
    listByTask.mockReturnValueOnce(rejectPromise)
    const second = render(
      <KanbanBoard
        workflow={agentWf}
        tasks={[task]}
        onMoveToStage={onMoveToStage}
        onCompleteTask={onCompleteTask}
        onNewTask={onNewTask}
      />,
    )
    second.unmount()
    rejectLater(new Error('late'))
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('执行状态查询失败时不锁卡片（拖动由主进程兜底拒绝）', async () => {
    const listByTask = vi.fn(() => Promise.reject(new Error('runs-down')))
    setApi({ runs: { listByTask } } as unknown as Partial<AiWorkflowApi>)
    setup([task], agentWf)

    await waitFor(() => expect(listByTask).toHaveBeenCalledWith('t1'))
    expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'true')
  })
})
