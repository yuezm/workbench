import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type {
  Run,
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import type { CommandDispatchResult } from '../../../../../../src/protocol/ipc'
import type { TaskComment } from '../../../../../../src/protocol/task-comment'
import { TaskDetailPage } from '../../../../../../src/renderer/src/apps/ai-workflow/components/TaskDetailPage'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

function stage(
  id: string,
  name: string,
  position: number,
  entryMode: WorkflowStage['entryMode'],
): WorkflowStage {
  return {
    id,
    workflowId: 'w1',
    name,
    position,
    entryMode,
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
    handoffWorkflowId: null,
    handoffStageId: null,
  }
}

const workflow: WorkflowWithStages = {
  id: 'w1',
  name: '研发',
  description: '',
  createdAt: 't',
  stages: [stage('s0', '待办', 0, 'none'), stage('s1', '执行', 1, 'agent')],
}

const task: Task = {
  id: 't1',
  title: '任务A',
  description: '把接口改完',
  workflowId: 'w1',
  projectId: 'p1',
  currentStageId: 's1',
  status: 'active',
  origin: 'rule',
  ruleId: 'r1',
  externalRef: null,
  labels: ['urgent'],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
}

const run: Run = {
  id: 'run1',
  taskId: 't1',
  stageId: 's1',
  agentId: 'a1',
  runtimeId: 'r1',
  status: 'succeeded',
  prompt: 'p',
  output: '改完了',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: 't',
  endedAt: 't',
  createdAt: '2026-11-06T09:10:00.000Z',
}

const comment: TaskComment = {
  id: 'c1',
  taskId: 't1',
  author: 'owner',
  text: '按钮颜色不对，改成粉色',
  createdAt: '2026-11-06T09:20:00.000Z',
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

function setup(
  detail: Task | null = task,
  runs: Run[] = [run],
  comments: TaskComment[] = [comment],
): { onBack: ReturnType<typeof vi.fn>; onOpenThread: ReturnType<typeof vi.fn> } {
  const onBack = vi.fn()
  const onOpenThread = vi.fn()
  kernel.setView('task.byId', { taskId: 't1' }, detail)
  kernel.setView('runs.byTask', { taskId: 't1' }, runs)
  kernel.setView('comments.byTask', { taskId: 't1' }, comments)
  render(
    <TaskDetailPage
      taskId="t1"
      workflows={[workflow]}
      onBack={onBack}
      onOpenThread={onOpenThread}
    />,
  )
  return { onBack, onOpenThread }
}

function dispatchWith(
  handler: <C extends Command>(
    command: C,
  ) => CommandDispatchResult<C> | Promise<CommandDispatchResult<C>>,
): void {
  kernel.onDispatch(handler)
}

describe('TaskDetailPage', () => {
  it('渲染任务标题、工作流/阶段线索、描述、元信息与标签', async () => {
    setup()

    expect(await screen.findByRole('heading', { name: '任务A' })).toBeInTheDocument()
    expect(screen.getByText('研发 · 执行')).toBeInTheDocument()
    expect(screen.getByText('把接口改完')).toBeInTheDocument()

    const info = screen.getByRole('region', { name: '任务信息' })
    expect(info).toHaveTextContent('进行中')
    expect(info).toHaveTextContent('执行')
    expect(info).toHaveTextContent('规则创建')
    expect(info).toHaveTextContent('未挂线程')
    expect(info).toHaveTextContent('2026-11-06T09:00:00.000Z')
    expect(info).toHaveTextContent('t1')

    const labels = screen.getByRole('list', { name: '标签' })
    expect(labels).toHaveTextContent('urgent')
  })

  it('上下文把运行与反馈按时间混排，计数随视图更新', async () => {
    setup()

    const context = await screen.findByRole('region', { name: '上下文' })
    expect(context).toHaveTextContent('运行 1')
    expect(context).toHaveTextContent('反馈 1')
    // 运行输出与评论都在同一条时间线上，且评论排在运行之后
    const items = within(context).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('成功')
    expect(items[0]).toHaveTextContent('改完了')
    expect(items[1]).toHaveTextContent('我')
    expect(items[1]).toHaveTextContent('按钮颜色不对，改成粉色')
  })

  it('既没有运行也没有反馈时展示空态', async () => {
    setup(task, [], [])
    expect(await screen.findByText('还没有运行记录或反馈')).toBeInTheDocument()
  })

  it('运行记录读取失败展示错误', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.failView('runs.byTask', { taskId: 't1' }, 'rboom')
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )
    expect(await screen.findByText('rboom')).toBeInTheDocument()
  })

  it('反馈视图读取失败展示错误', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [run])
    kernel.failView('comments.byTask', { taskId: 't1' }, 'cboom')
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )
    expect(await screen.findByText('cboom')).toBeInTheDocument()
  })

  it('任务没有描述时给占位文案', async () => {
    setup({ ...task, description: '' })
    expect(await screen.findByText('没有描述')).toBeInTheDocument()
  })

  it('任务没有 threadId 时不提供打开线程入口', async () => {
    setup()
    await screen.findByRole('heading', { name: '任务A' })
    expect(screen.queryByRole('button', { name: '打开线程' })).not.toBeInTheDocument()
  })

  it('任务挂在线程上时提供入口，点击把 threadId 交给上层', async () => {
    const user = userEvent.setup()
    const { onOpenThread } = setup({ ...task, threadId: 'th1' })

    await screen.findByRole('heading', { name: '任务A' })
    expect(screen.getByRole('region', { name: '任务信息' })).toHaveTextContent('th1')
    await user.click(screen.getByRole('button', { name: '打开线程' }))
    expect(onOpenThread).toHaveBeenCalledWith('th1')
  })

  it('发送反馈：dispatch task.comment（勾选时带 rerun），成功后清空输入', async () => {
    dispatchWith(<C extends Command>(): CommandDispatchResult<C> => {
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    setup()

    const box = await screen.findByLabelText('反馈内容')
    await user.type(box, '  按钮改成粉色  ')
    await user.click(screen.getByRole('button', { name: '发送反馈' }))

    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({
          type: 'task.comment',
          taskId: 't1',
          text: '按钮改成粉色',
          rerun: true,
        }),
      ),
    )
    await waitFor(() => expect(screen.getByLabelText('反馈内容')).toHaveValue(''))
  })

  it('取消「接着做」后 rerun 为 false', async () => {
    const user = userEvent.setup()
    setup()

    await screen.findByRole('region', { name: '上下文' })
    await user.click(screen.getByRole('checkbox', { name: '同时让智能体接着做' }))
    await user.type(screen.getByLabelText('反馈内容'), '只记一下')
    await user.click(screen.getByRole('button', { name: '发送反馈' }))

    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'task.comment', text: '只记一下', rerun: false }),
      ),
    )
  })

  it('非 agent 阶段：勾选禁用，反馈只作上下文', async () => {
    const user = userEvent.setup()
    const noneTask: Task = { ...task, currentStageId: 's0' }
    setup(noneTask)

    const rerun = await screen.findByRole('checkbox', { name: '同时让智能体接着做' })
    expect(rerun).toBeDisabled()
    expect(rerun).not.toBeChecked()
    expect(screen.getByText(/当前阶段不交给智能体/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('反馈内容'), '补个背景')
    await user.click(screen.getByRole('button', { name: '发送反馈' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'task.comment', text: '补个背景', rerun: false }),
      ),
    )
  })

  it('空反馈就地提示，不发命令', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findByRole('region', { name: '上下文' })

    const button = screen.getByRole('button', { name: '发送反馈' })
    expect(button).toBeDisabled()
    await user.type(screen.getByLabelText('反馈内容'), '   ')
    expect(button).toBeDisabled()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('发送失败展示错误并保留输入', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.comment'
        ? Promise.reject(new Error('反馈写不进去'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup()

    await screen.findByRole('region', { name: '上下文' })
    await user.type(screen.getByLabelText('反馈内容'), '再试一次')
    await user.click(screen.getByRole('button', { name: '发送反馈' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('反馈写不进去')
    expect(screen.getByLabelText('反馈内容')).toHaveValue('再试一次')
  })

  it('发送失败为非 Error 时按字符串展示', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.comment'
        ? Promise.reject('纯文本反馈失败')
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup()

    await screen.findByRole('region', { name: '上下文' })
    await user.type(screen.getByLabelText('反馈内容'), '再试一次')
    await user.click(screen.getByRole('button', { name: '发送反馈' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('纯文本反馈失败')
  })

  it('发送中禁用输入与按钮', async () => {
    dispatchWith(
      <C extends Command>(): Promise<CommandDispatchResult<C>> =>
        new Promise<CommandDispatchResult<C>>(() => {}),
    )
    const user = userEvent.setup()
    setup()

    await screen.findByRole('region', { name: '上下文' })
    await user.type(screen.getByLabelText('反馈内容'), '写很久')
    await user.click(screen.getByRole('button', { name: '发送反馈' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled())
    expect(screen.getByLabelText('反馈内容')).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: '同时让智能体接着做' })).toBeDisabled()
  })

  it('返回按钮调用 onBack', async () => {
    const user = userEvent.setup()
    const { onBack } = setup()

    await screen.findByRole('heading', { name: '任务A' })
    await user.click(screen.getByRole('button', { name: '返回' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('任务不存在时展示空态，仍可返回', async () => {
    setup(null)
    expect(await screen.findByText('任务不存在')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument()
  })

  it('任务视图未就绪时展示读取中', async () => {
    kernel.setView('runs.byTask', { taskId: 't1' }, [run])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )
    expect(await screen.findByText('正在读取任务…')).toBeInTheDocument()
  })

  it('任务视图读取失败展示错误，不渲染空态正文', async () => {
    kernel.failView('task.byId', { taskId: 't1' }, '任务读取失败')
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('任务读取失败')
    expect(screen.queryByText('任务不存在')).not.toBeInTheDocument()
  })

  it('工作流数据缺失时阶段与工作流退化为未知，且不提供接着做', async () => {
    const onBack = vi.fn()
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    render(<TaskDetailPage taskId="t1" workflows={[]} onBack={onBack} onOpenThread={vi.fn()} />)
    expect(await screen.findByText('未知工作流 · 未知阶段')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '同时让智能体接着做' })).toBeDisabled()
  })

  it('有子任务时渲染子任务区（进度 + 点进详情）', async () => {
    const childDone: Task = {
      ...task,
      id: 't2',
      title: '子任务A',
      parentTaskId: 't1',
      status: 'completed',
      currentStageId: 's1',
    }
    const childOpen: Task = {
      ...task,
      id: 't3',
      title: '子任务B',
      parentTaskId: 't1',
      currentStageId: 's0',
    }
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.setView('tasks.byParent', { taskId: 't1' }, [childDone, childOpen])
    const onOpenTask = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDetailPage
        taskId="t1"
        workflows={[workflow]}
        onBack={vi.fn()}
        onOpenThread={vi.fn()}
        onOpenTask={onOpenTask}
      />,
    )
    const section = await screen.findByRole('region', { name: '子任务' })
    expect(section).toHaveTextContent('1/2')
    await user.click(within(section).getByRole('button', { name: /子任务A/ }))
    expect(onOpenTask).toHaveBeenCalledWith('t2')
  })
})
