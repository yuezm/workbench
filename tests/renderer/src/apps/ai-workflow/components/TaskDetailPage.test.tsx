import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
import {
  rerunStageLabel,
  TaskDetailPage,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/TaskDetailPage'
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
    exits: {},
    judge: null,
    handoffs: [],
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
  handoffFromRunId: null,
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
  access: 'edit',
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
): {
  onBack: ReturnType<typeof vi.fn>
  onOpenThread: ReturnType<typeof vi.fn>
  onRemoved: ReturnType<typeof vi.fn>
} {
  const onBack = vi.fn()
  const onOpenThread = vi.fn()
  const onRemoved = vi.fn()
  kernel.setView('task.byId', { taskId: 't1' }, detail)
  kernel.setView('runs.byTask', { taskId: 't1' }, runs)
  kernel.setView('comments.byTask', { taskId: 't1' }, comments)
  render(
    <TaskDetailPage
      taskId="t1"
      workflows={[workflow]}
      onBack={onBack}
      onOpenThread={onOpenThread}
      onRemoved={onRemoved}
    />,
  )
  return { onBack, onOpenThread, onRemoved }
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

  it('本任务的 open 卡：正文与选项在任务详情里，选中后提交才 dispatch card.answer', async () => {
    setup()
    kernel.setView('cards.open', undefined, [
      {
        id: 'card-1',
        runId: 'run1',
        taskId: 't1',
        conversationId: null,
        title: '包名怎么定',
        text: '事实：裸名已被他人发布过 0.2.0；选哪个？',
        kind: 'ask',
        options: ['裸名', '带前缀'],
        key: 'k',
        version: 1,
        status: 'open',
        delivery: 'delivered',
        deliveryRef: 'in-app',
        deliveryAttempts: 0,
        nextDeliveryAt: null,
        deliveryGivenUp: false,
        optionIndex: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: 't',
        updatedAt: 't',
      },
    ])
    const user = userEvent.setup()

    const cards = await screen.findByRole('region', { name: '待处理卡' })
    expect(within(cards).getByText('包名怎么定')).toBeInTheDocument()
    expect(within(cards).getByText(/裸名已被他人发布过/)).toBeInTheDocument()

    await user.click(within(cards).getByRole('radio', { name: '带前缀' }))
    await user.click(within(cards).getByRole('button', { name: '提交所选' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({
          type: 'card.answer',
          cardId: 'card-1',
          optionIndex: 1,
          via: 'ui',
        }),
      ),
    )
  })

  it('从通知进来：focusCardId 交给卡片区，那张卡被标成定位态', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [run])
    kernel.setView('comments.byTask', { taskId: 't1' }, [comment])
    kernel.setView('cards.open', undefined, [
      {
        id: 'card-1',
        runId: 'run1',
        taskId: 't1',
        conversationId: null,
        title: '包名怎么定',
        text: '选一个',
        kind: 'ask',
        options: ['裸名', '带前缀'],
        key: 'k',
        version: 1,
        status: 'open',
        delivery: 'delivered',
        deliveryRef: 'in-app',
        deliveryAttempts: 0,
        nextDeliveryAt: null,
        deliveryGivenUp: false,
        optionIndex: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: 't',
        updatedAt: 't',
      },
    ])
    render(
      <TaskDetailPage
        taskId="t1"
        workflows={[workflow]}
        onBack={vi.fn()}
        onOpenThread={vi.fn()}
        focusCardId="card-1"
      />,
    )

    const anchor = await screen.findByText('包名怎么定')
    const cardNode = anchor.closest('[data-card-id]')
    expect(cardNode).toHaveAttribute('data-card-id', 'card-1')
    expect(cardNode).toHaveAttribute('data-focused', 'true')
  })

  it('别的任务的卡不进本任务详情', async () => {
    setup()
    kernel.setView('cards.open', undefined, [
      {
        id: 'card-2',
        runId: 'run-9',
        taskId: 't9',
        conversationId: null,
        title: '别人的问题',
        text: '',
        kind: 'ask',
        options: ['好'],
        key: null,
        version: 1,
        status: 'open',
        delivery: 'delivered',
        deliveryRef: 'in-app',
        deliveryAttempts: 0,
        nextDeliveryAt: null,
        deliveryGivenUp: false,
        optionIndex: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: 't',
        updatedAt: 't',
      },
    ])

    expect(await screen.findByRole('heading', { name: '任务A' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '待处理卡' })).toBeNull()
    expect(screen.queryByText('别人的问题')).toBeNull()
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

  it('活动流的运行卡片带上当前工作流的阶段名与「第 N 轮」', async () => {
    const secondRun: Run = {
      ...run,
      id: 'run2',
      stageId: 's0',
      createdAt: '2026-11-06T09:30:00.000Z',
      output: '第二轮产出',
    }
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [run, secondRun])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )

    const context = await screen.findByRole('region', { name: '上下文' })
    const items = within(context).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('执行')
    expect(items[0]).toHaveTextContent('第 1 轮')
    expect(items[1]).toHaveTextContent('待办')
    expect(items[1]).toHaveTextContent('第 2 轮')
  })

  it('工作流阶段表缺失时，活动流里的运行卡片显示「未知阶段」', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, { ...task, workflowId: 'gone' })
    kernel.setView('runs.byTask', { taskId: 't1' }, [run])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )

    const context = await screen.findByRole('region', { name: '上下文' })
    expect(within(context).getAllByRole('listitem')[0]).toHaveTextContent('未知阶段')
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

  it('空反馈就地提示并聚焦输入，不发命令', async () => {
    const user = userEvent.setup()
    setup()
    await screen.findByRole('region', { name: '上下文' })

    // 按钮可点：点了必须有反馈，不能靠「灰着不响」表达空值
    const button = screen.getByRole('button', { name: '发送反馈' })
    expect(button).toBeEnabled()
    await user.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('写点内容再发送')
    expect(screen.getByLabelText('反馈内容')).toHaveFocus()

    // 纯空格同样按空处理，仍然不发命令
    await user.type(screen.getByLabelText('反馈内容'), '   ')
    await user.click(button)
    expect(screen.getByRole('alert')).toHaveTextContent('写点内容再发送')
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

  it('审批卡视图读取失败：就地展示原因，任务正文照常渲染', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.failView('cards.open', undefined, 'cards-down')
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )

    // 卡片读不到时 run 可能停在 waiting：原因是必须看到的，不能只让卡片凭空消失
    expect(await screen.findByRole('alert')).toHaveTextContent('cards-down')
    expect(screen.getByRole('heading', { name: '任务A' })).toBeInTheDocument()
  })

  it('子任务视图读取失败：就地展示原因，不把失败当成「没有子任务」', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.failView('tasks.byParent', { taskId: 't1' }, 'kids-down')
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )

    expect(await screen.findByText('kids-down')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '子任务' })).toBeNull()
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

  it('子任务的阶段不在工作流阶段表里时，阶段名退化为「未知阶段」', async () => {
    const staleChild: Task = {
      ...task,
      id: 't4',
      title: '子任务C',
      parentTaskId: 't1',
      // 阶段被删掉 / 子任务属于别的工作流的遗留数据：查不到阶段也不能抛错
      currentStageId: 'gone',
    }
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.setView('tasks.byParent', { taskId: 't1' }, [staleChild])
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )

    const section = await screen.findByRole('region', { name: '子任务' })
    expect(within(section).getByRole('button', { name: /子任务C/ })).toHaveTextContent('未知阶段')
    // 当前任务的阶段仍按工作流解析：退化只影响那一个子任务
    expect(screen.getByText('研发 · 执行')).toBeInTheDocument()
  })

  it('任务说明单独成卡：带「初始输入」徽标，位置在上下文之前', async () => {
    setup()

    const brief = await screen.findByRole('region', { name: '任务说明' })
    expect(brief).toHaveTextContent('把接口改完')
    expect(within(brief).getByText('初始输入')).toBeInTheDocument()

    const context = screen.getByRole('region', { name: '上下文' })
    // 先读要求（任务说明）再看过程（上下文）
    expect(brief.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('任务说明空描述：卡片仍在，给占位文案', async () => {
    setup({ ...task, description: '' })

    const brief = await screen.findByRole('region', { name: '任务说明' })
    expect(within(brief).getByText('没有描述')).toBeInTheDocument()
  })

  it('失败后给出「重新执行」：点击 dispatch task.rerun（原地重排当前阶段）', async () => {
    const user = userEvent.setup()
    setup(task, [
      { ...run, status: 'failed', error: '执行器失联', errorCode: 'executor_lost', output: '' },
    ])

    await screen.findByRole('heading', { name: '任务A' })
    const retry = screen.getByRole('button', { name: '重新执行' })
    expect(retry).toHaveAttribute('title', expect.stringContaining('这一轮'))

    await user.click(retry)
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'task.rerun', id: 't1' }),
      ),
    )
  })

  it('没有历史运行 / 正在执行 / 已完成：都不给「重新执行」', async () => {
    setup(task, [])
    await screen.findByRole('heading', { name: '任务A' })
    expect(screen.queryByRole('button', { name: '重新执行' })).toBeNull()
    cleanup()

    kernel.setView('tasks.executing', undefined, ['t1'])
    setup()
    await screen.findByRole('heading', { name: '任务A' })
    expect(screen.queryByRole('button', { name: '重新执行' })).toBeNull()
    cleanup()

    setup({ ...task, status: 'completed' })
    await screen.findByRole('heading', { name: '任务A' })
    expect(screen.queryByRole('button', { name: '重新执行' })).toBeNull()
  })

  it('重新执行失败：亮后端文案，页面不崩', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.rerun'
        ? Promise.reject(new Error('当前阶段正在执行，先停止执行再重排'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup(task, [
      { ...run, status: 'failed', error: '执行器失联', errorCode: 'executor_lost', output: '' },
    ])

    await screen.findByRole('heading', { name: '任务A' })
    await user.click(screen.getByRole('button', { name: '重新执行' }))
    // 失败 run 的错误文案也占一个 alert，这里按文案找重排那条
    expect(await screen.findByText('当前阶段正在执行，先停止执行再重排')).toBeInTheDocument()
  })

  it('执行中：出现「停止执行」，点击 dispatch task.stop；「完成任务」禁用', async () => {
    kernel.setView('tasks.executing', undefined, ['t1'])
    const user = userEvent.setup()
    setup()

    await screen.findByRole('heading', { name: '任务A' })
    const complete = screen.getByRole('button', { name: '完成任务' })
    expect(complete).toBeDisabled()
    expect(complete).toHaveAttribute('title', '执行中：先停止执行')

    await user.click(screen.getByRole('button', { name: '停止执行' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'task.stop', id: 't1' }),
      ),
    )
  })

  it('不在执行中：没有「停止执行」，「完成任务」可点并 dispatch task.complete', async () => {
    const user = userEvent.setup()
    setup()

    await screen.findByRole('heading', { name: '任务A' })
    expect(screen.queryByRole('button', { name: '停止执行' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '完成任务' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'task.complete', id: 't1' }),
      ),
    )
  })

  it('已完成的任务：右上角只写「已完成」，不再给结束动作', async () => {
    setup({ ...task, status: 'completed' })

    await screen.findByRole('heading', { name: '任务A' })
    // 信息面板的状态字段与右上角的收尾标记都会写「已完成」
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '完成任务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '停止执行' })).toBeNull()
  })

  it('停止执行失败：亮后端文案，页面不崩', async () => {
    kernel.setView('tasks.executing', undefined, ['t1'])
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.stop'
        ? Promise.reject(new Error('运行已结束，无法取消'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup()

    await screen.findByRole('heading', { name: '任务A' })
    await user.click(screen.getByRole('button', { name: '停止执行' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('运行已结束，无法取消')
  })

  it('结束动作失败：亮后端文案，页面不崩', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.complete'
        ? Promise.reject(new Error('执行中的阶段不能完成'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup()

    await screen.findByRole('heading', { name: '任务A' })
    await user.click(screen.getByRole('button', { name: '完成任务' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('执行中的阶段不能完成')
  })

  it('删除任务：确认弹窗说明连带执行记录与线程，确认后 dispatch 并出栈', async () => {
    const user = userEvent.setup()
    const { onRemoved } = setup()
    await screen.findByRole('heading', { name: '任务A' })

    // 位置与线程详情页一致：内容区底部的「页面动作」组里，左侧说明右侧按钮；页头不留删除
    const bar = screen.getByRole('group', { name: '页面动作' })
    expect(bar).toHaveTextContent('线程也一并删除')
    expect(
      within(screen.getByRole('banner')).queryByRole('button', { name: '删除任务' }),
    ).toBeNull()

    await user.click(within(bar).getByRole('button', { name: '删除任务' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('任务「任务A」')
    expect(dialog).toHaveTextContent('执行记录')
    // 线程可能随最后一个任务一起消失：弹窗里先讲清楚
    expect(dialog).toHaveTextContent('线程也会一并删除')

    await user.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'task.remove', id: 't1' }),
      ),
    )
    expect(onRemoved).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('删除任务：Esc 与「取消」都只关弹窗，不发命令、不出栈', async () => {
    const user = userEvent.setup()
    const { onRemoved } = setup()
    await screen.findByRole('heading', { name: '任务A' })

    await user.click(screen.getByRole('button', { name: '删除任务' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '删除任务' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(kernel.dispatched).toEqual([])
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('删除失败：弹窗收起、原因贴在页面顶部，不出栈', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.remove'
        ? Promise.reject(new Error('任务读取失败，先刷新'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    const { onRemoved } = setup()
    await screen.findByRole('heading', { name: '任务A' })

    await user.click(screen.getByRole('button', { name: '删除任务' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('任务读取失败，先刷新')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('删除中点不动：两个按钮都禁用并写「正在删除…」', async () => {
    dispatchWith(
      <C extends Command>(): Promise<CommandDispatchResult<C>> =>
        new Promise<CommandDispatchResult<C>>(() => {}),
    )
    const user = userEvent.setup()
    setup()
    await screen.findByRole('heading', { name: '任务A' })

    await user.click(screen.getByRole('button', { name: '删除任务' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }),
    )

    await waitFor(() => expect(screen.getByRole('button', { name: '正在删除…' })).toBeDisabled())
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    // 弹窗把页面内容从无障碍树里摘掉了：用 hidden 查询确认页头按钮也一起锁住
    expect(screen.getByRole('button', { name: '删除任务', hidden: true })).toBeDisabled()
  })

  it('没有 onRemoved 回调时：删除照常 dispatch，不抛错（页面可独立复用）', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    const user = userEvent.setup()
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )
    await screen.findByRole('heading', { name: '任务A' })

    await user.click(screen.getByRole('button', { name: '删除任务' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }),
    )

    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'task.remove', id: 't1' }),
      ),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
describe('TaskDetailPage 评审结论（M14）', () => {
  const reviewReport = {
    id: 'run-r:1',
    taskId: 't1',
    stageId: 's1',
    runId: 'run-r',
    threadId: null,
    rev: 1,
    verdict: 'fail' as const,
    checks: [{ cmd: 'pnpm check', exitCode: 1 }],
    findings: [
      {
        id: 'run-r:1#R1',
        key: 'R1',
        severity: 'blocker' as const,
        location: 'src/a.ts:64',
        claim: 'BOM 文件被判非法 JSON',
        evidence: null,
        requiredAction: '改成 utf-8-sig 后复跑',
        status: 'open' as const,
        note: null,
        addressedByRunId: null,
        updatedAt: '2026-11-10T00:00:00.000Z',
      },
    ],
    artifact: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  }

  it('展示清单，点「提升为文档」发 review.export 并回显路径', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.setView('reviews.byTask', { taskId: 't1' }, [reviewReport])
    // 泛型 handler 的返回类型按 `C['type']` 收窄，这里按 fake kernel 的契约断言返回值
    kernel.onDispatch(
      () =>
        ({
          facts: [],
          value: { path: '/repo/docs/reviews/任务A-t1-r1.md' },
        }) as never,
    )
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )
    expect(await screen.findByText('BOM 文件被判非法 JSON')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '提升为文档' }))
    const exported = kernel.dispatched.find((command) => command.type === 'review.export')
    expect(exported).toMatchObject({ taskId: 't1', reportId: 'run-r:1' })
    expect(await screen.findByText(/已写入/)).toBeTruthy()
  })

  it('没有评审报告：面板给空态（不显示按钮）', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.setView('reviews.byTask', { taskId: 't1' }, [])
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )
    expect(await screen.findByText(/还没有评审结论/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提升为文档' })).toBeNull()
  })

  it('导出成功但结果里没有 path（脏结果兜底）：不显示 undefined，也不报错', async () => {
    kernel.setView('task.byId', { taskId: 't1' }, task)
    kernel.setView('runs.byTask', { taskId: 't1' }, [])
    kernel.setView('comments.byTask', { taskId: 't1' }, [])
    kernel.setView('reviews.byTask', { taskId: 't1' }, [reviewReport])
    // 宿主只回 value 不回 path（旧版本 / 脏结果）：路径按空串处理
    kernel.onDispatch(() => ({ facts: [], value: {} }) as never)
    render(
      <TaskDetailPage taskId="t1" workflows={[workflow]} onBack={vi.fn()} onOpenThread={vi.fn()} />,
    )

    expect(await screen.findByText('BOM 文件被判非法 JSON')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '提升为文档' }))

    const line = await screen.findByText(/已写入/)
    expect(line.textContent?.trim()).toBe('已写入')
    expect(screen.queryByText(/undefined|null/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('rerunStageLabel', () => {
  it('阶段名在就原样用；缺失（脏投影）时退化「当前阶段」', () => {
    expect(rerunStageLabel('执行')).toBe('执行')
    expect(rerunStageLabel(undefined)).toBe('当前阶段')
    expect(rerunStageLabel(null)).toBe('当前阶段')
  })
})
