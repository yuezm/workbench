import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import { KanbanBoard } from '../../../../../../src/renderer/src/apps/ai-workflow/components/KanbanBoard'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

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
    exits: {},
    judge: null,
    handoffs: [],
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
  projectId: 'p1',
  currentStageId: 's1',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
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

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

describe('KanbanBoard', () => {
  it('按阶段分列、渲染卡片与已完成计数，支持新建', async () => {
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
    expect(screen.getByText('拖拽换阶段')).toBeInTheDocument()
    expect(screen.getByText('待办')).toBeInTheDocument()
    expect(screen.getByText('审核')).toBeInTheDocument()
    expect(screen.getByText('卡片任务')).toBeInTheDocument()
    expect(screen.queryByText('已完成的活')).not.toBeInTheDocument()

    const done = screen.getByRole('group', { name: '归档区' })
    expect(within(done).getByText('1')).toBeInTheDocument()
    expect(screen.queryByText('执行中…')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    expect(onNewTask).toHaveBeenCalled()
  })

  it('混入其它工作流的任务时不显示（tasks 是项目下全部任务）', () => {
    // M10：视图给的是项目下全部任务，看板只认本工作流的
    const foreign: Task = {
      ...task,
      id: 't9',
      title: '别家的任务',
      workflowId: 'w-other',
      currentStageId: 's1',
      status: 'completed',
    }
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[task, foreign]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    expect(screen.getByText('卡片任务')).toBeInTheDocument()
    expect(screen.queryByText('别家的任务')).not.toBeInTheDocument()
    // 已完成数也只算本工作流的：别家那条 completed 不计入
    expect(within(screen.getByRole('group', { name: '归档区' })).getByText('0')).toBeInTheDocument()
  })

  it('拖到其它阶段列触发 moveToStage，拖拽中空列提示落点', () => {
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
    const { onMoveToStage } = setup()
    fireEvent.dragStart(screen.getByLabelText('任务：卡片任务'))
    fireEvent.drop(screen.getByRole('group', { name: '阶段：审核' }))
    expect(onMoveToStage).not.toHaveBeenCalled()
  })

  it('拖到「归档」区触发 completeTask', () => {
    const { onCompleteTask } = setup()
    const done = screen.getByRole('group', { name: '归档区' })
    fireEvent.dragStart(screen.getByLabelText('任务：卡片任务'))
    fireEvent.dragOver(done)
    fireEvent.dragLeave(done)
    fireEvent.dragOver(done)
    fireEvent.drop(done)
    expect(onCompleteTask).toHaveBeenCalledWith('t1')
  })

  it('没有拖拽来源时，悬停与落下都不触发任何回调', () => {
    const { onMoveToStage, onCompleteTask } = setup()
    const target = screen.getByRole('group', { name: '阶段：待办' })
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    fireEvent.dragOver(screen.getByRole('group', { name: '归档区' }))
    fireEvent.drop(screen.getByRole('group', { name: '归档区' }))
    expect(onMoveToStage).not.toHaveBeenCalled()
    expect(onCompleteTask).not.toHaveBeenCalled()
  })

  it('tasks.executing 含该任务时卡片执行中且不可拖', async () => {
    kernel.setView('tasks.executing', undefined, [task.id])
    setup([task], agentWf)

    expect(await screen.findByText('执行中…')).toBeInTheDocument()
    const card = screen.getByLabelText('任务：卡片任务')
    expect(card).toHaveAttribute('draggable', 'false')
    expect(card.className).toContain('cursor-default')
    expect(screen.queryByText('可拖走重试')).not.toBeInTheDocument()
  })

  it('queued/waiting 也算执行中；失败/取消/成功都不锁卡片', async () => {
    const second: Task = { ...task, id: 't2', title: '待办任务', currentStageId: 's0' }
    // t1 在执行中集合里（queued/waiting 由内核归入同一集合），t2 不在
    kernel.setView('tasks.executing', undefined, ['t1'])
    setup([task, second], agentWf)

    expect(await screen.findByText('执行中…')).toBeInTheDocument()
    expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'false')
    // t2 无活跃 run：可拖，且文案按进入方式提示
    expect(screen.getByLabelText('任务：待办任务')).toHaveAttribute('draggable', 'true')
    expect(screen.getByLabelText('任务：待办任务').className).toContain('cursor-grab')
    expect(screen.getByText('拖动推进')).toBeInTheDocument()
  })

  it('agent 阶段失败后无活跃 run：显示可拖走重试文案', async () => {
    kernel.setView('tasks.executing', undefined, [])
    setup([task], agentWf)

    expect(await screen.findByText('可拖走重试')).toBeInTheDocument()
    const card = screen.getByLabelText('任务：卡片任务')
    expect(card).toHaveAttribute('draggable', 'true')
    expect(card.className).toContain('cursor-grab')
  })

  it('执行中集合变化后卡片随之解锁，无需逐任务查询', async () => {
    kernel.setView('tasks.executing', undefined, ['t1'])
    setup([task], agentWf)
    expect(await screen.findByText('执行中…')).toBeInTheDocument()
    expect(kernel.store.peek('tasks.executing')).toEqual(['t1'])

    // 任务/运行事实到达 → tasks.executing 失效重取；看板不再自己拉 runs.listByTask
    kernel.setView('tasks.executing', undefined, [])
    kernel.pushFacts(['task.created'])
    await waitFor(() =>
      expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'true'),
    )
    expect(screen.queryByText('执行中…')).not.toBeInTheDocument()
  })

  it('卸载后的事实批次不更新已卸载组件；重新挂载按新视图渲染', async () => {
    kernel.setView('tasks.executing', undefined, ['t1'])
    const first = render(
      <KanbanBoard
        workflow={agentWf}
        tasks={[task]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    expect(await screen.findByText('执行中…')).toBeInTheDocument()
    first.unmount()

    // 卸载后仍推送事实：不应抛错、不应更新已卸载组件
    kernel.pushFacts(['run.queued'])

    render(
      <KanbanBoard
        workflow={agentWf}
        tasks={[task]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    expect(await screen.findByText('执行中…')).toBeInTheDocument()
  })

  it('执行状态视图查询失败时不锁卡片（拖动由主进程兜底拒绝）', async () => {
    kernel.failView('tasks.executing', undefined, 'runs-down')
    setup([task], agentWf)

    await waitFor(() =>
      expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'true'),
    )
  })

  it('执行中的任务不给落点：拖动途中进入执行中后阶段列与归档区都不高亮、不触发回调', async () => {
    kernel.setView('tasks.executing', undefined, [])
    const { onMoveToStage, onCompleteTask } = setup([task], agentWf)
    // 先把规则写在归档区上，别让用户拖过去才吃内核的「执行中的阶段不能完成」
    expect(screen.getByText('执行中的任务不能归档')).toBeInTheDocument()

    fireEvent.dragStart(screen.getByLabelText('任务：卡片任务'))
    expect(screen.getByText('拖到这里')).toBeInTheDocument()

    // 拖动途中任务进入执行中（run 开跑 / tasks.executing 刷新）
    kernel.setView('tasks.executing', undefined, ['t1'])
    await waitFor(() =>
      expect(screen.getByLabelText('任务：卡片任务')).toHaveAttribute('draggable', 'false'),
    )

    const stageCol = screen.getByRole('group', { name: '阶段：待办' })
    fireEvent.dragOver(stageCol)
    expect(stageCol.className).not.toContain('border-ring')
    fireEvent.drop(stageCol)
    expect(onMoveToStage).not.toHaveBeenCalled()

    // 再模拟一次拖动来源（draggable=false 只是浏览器侧不发起，落点侧仍必须兜住）
    fireEvent.dragStart(screen.getByLabelText('任务：卡片任务'))
    const done = screen.getByRole('group', { name: '归档区' })
    fireEvent.dragOver(done)
    expect(done.className).not.toContain('border-success')
    fireEvent.drop(done)
    expect(onCompleteTask).not.toHaveBeenCalled()
  })

  it('任务有 threadId 时卡片带线程入口，点击把任务交给上层', async () => {
    const onOpenThread = vi.fn()
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[{ ...task, threadId: 'th1' }]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
        onOpenThread={onOpenThread}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打开线程：卡片任务' }))
    expect(onOpenThread).toHaveBeenCalledWith('th1')
  })

  it('单击任务卡把任务交给上层进入详情页', async () => {
    const onOpenTask = vi.fn()
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[task]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
        onOpenTask={onOpenTask}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('任务：卡片任务'))
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
  })

  it('派生任务按当前看板任务列表找到父任务标题', async () => {
    const parent: Task = { ...task, id: 'p1', title: '父任务', currentStageId: 's0' }
    const child: Task = { ...task, id: 'c1', title: '子任务卡', parentTaskId: 'p1' }
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[parent, child]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    expect(await screen.findByText('子任务 · 父任务')).toBeInTheDocument()
    // 父任务自己不是派生任务
    expect(screen.getAllByText(/子任务 ·/)).toHaveLength(1)
  })

  it('归档区能翻出已完成任务：点行把任务交给上层进详情', async () => {
    const onOpenTask = vi.fn()
    const user = userEvent.setup()
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[task, doneTask]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
        onOpenTask={onOpenTask}
      />,
    )
    await user.click(screen.getByRole('button', { name: '查看归档任务' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('已完成的活')

    await user.click(within(dialog).getByRole('button', { name: '打开归档任务：已完成的活' }))
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't0' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('没有已完成任务时「查看归档」禁用并说明原因', () => {
    setup([task])
    const view = screen.getByRole('button', { name: '查看归档任务' })
    expect(view).toBeDisabled()
    expect(view).toHaveAttribute('title', '还没有归档任务')
  })

  it('父任务卡显示子任务完成进度（M8）', () => {
    const childOpen: Task = {
      ...task,
      id: 't2',
      title: '子任务一',
      parentTaskId: 't1',
      currentStageId: 's0',
    }
    const childDone: Task = {
      ...task,
      id: 't3',
      title: '子任务二',
      parentTaskId: 't1',
      status: 'completed',
    }
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[task, childOpen, childDone]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    expect(screen.getByText('子任务 1/2')).toBeInTheDocument()
  })
})

describe('KanbanBoard 列内顺序', () => {
  /** 某一列里从上到下的卡片标题（卡片可访问名是「任务：<标题>」） */
  const cardTitles = (columnName: string): string[] =>
    within(screen.getByRole('group', { name: `阶段：${columnName}` }))
      .getAllByLabelText(/^任务：/)
      .map((card) => card.getAttribute('aria-label')?.replace('任务：', '') ?? '')

  it('最近活动的排最上面：后进入的卡片压过老卡', () => {
    const inTodo: Task = { ...task, currentStageId: 's0' }
    const older: Task = {
      ...inTodo,
      id: 't-old',
      title: '老卡',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const newer: Task = {
      ...inTodo,
      id: 't-new',
      title: '新卡',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    // 视图给的是创建升序（老卡在前），看板要翻过来
    setup([older, newer])
    expect(cardTitles('待办')).toEqual(['新卡', '老卡'])
  })

  it('排序键是最近活动而不是创建时间：刚推进到本列的老卡排最上、中间层按各自的活动时间', () => {
    const inTodo: Task = { ...task, currentStageId: 's0' }
    // 视图按创建升序给：老卡 → 中间卡 → 新卡
    const oldest: Task = {
      ...inTodo,
      id: 't-oldest',
      title: '刚推进的老卡',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-05T00:00:00.000Z',
    }
    const middle: Task = {
      ...inTodo,
      id: 't-middle',
      title: '没动过的中间卡',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    const newest: Task = {
      ...inTodo,
      id: 't-newest',
      title: '后建的新卡',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }
    setup([oldest, middle, newest])
    // 按活动时间（不是创建时间）倒序：01-05 → 01-03 → 01-02
    expect(cardTitles('待办')).toEqual(['刚推进的老卡', '后建的新卡', '没动过的中间卡'])
  })
})

describe('KanbanBoard 列头类别', () => {
  /** 四件套内置阶段 + 一个自己添加的阶段（M18 的规范顺序） */
  const withBuiltins = (): WorkflowWithStages => ({
    ...wf,
    stages: [
      { ...stage('s0', '待办', 0, 'none'), builtin: 'todo' },
      { ...stage('s1', '审核', 1, 'user'), builtin: null },
      { ...stage('s2', '已阻塞', 2, 'none'), builtin: 'blocked' },
      { ...stage('s3', '已完成', 3, 'none'), builtin: 'done' },
      { ...stage('s4', '已取消', 4, 'none'), builtin: 'cancelled' },
    ],
  })

  /** 列头圆点（`aria-hidden` 的圆点，不带可访问文案） */
  const dotOf = (columnName: string): Element | null =>
    screen.getByRole('group', { name: `阶段：${columnName}` }).querySelector('span.rounded-full')

  it('列头圆点按阶段类别取色：未开始 / 进行中 / 已完成 / 已关闭', () => {
    render(
      <KanbanBoard
        workflow={withBuiltins()}
        tasks={[]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )

    expect(dotOf('待办')?.className).toContain('bg-muted-foreground')
    // 自己添加的阶段一律「进行中」
    expect(dotOf('审核')?.className).toContain('bg-brand')
    expect(dotOf('已阻塞')?.className).toContain('bg-brand')
    expect(dotOf('已完成')?.className).toContain('bg-success')
    expect(dotOf('已取消')?.className).toContain('bg-destructive')
  })

  it('列头只显示阶段名，不挂类别文案', () => {
    render(
      <KanbanBoard
        workflow={withBuiltins()}
        tasks={[]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )

    const todo = screen.getByRole('group', { name: '阶段：待办' })
    expect(within(todo).getByText('待办')).toBeInTheDocument()
    expect(within(todo).queryByText('未开始')).not.toBeInTheDocument()
    const blocked = screen.getByRole('group', { name: '阶段：已阻塞' })
    expect(within(blocked).queryByText('进行中')).not.toBeInTheDocument()
    // 自己添加的阶段同样不带类别文案
    const review = screen.getByRole('group', { name: '阶段：审核' })
    expect(within(review).queryByText('进行中')).not.toBeInTheDocument()
  })
})

describe('KanbanBoard 列内快速新建', () => {
  function renderQuick(
    onQuickCreateTask = vi.fn<
      (stageId: string, title: string, description: string) => Promise<void>
    >(async () => undefined),
  ): { onQuickCreateTask: ReturnType<typeof vi.fn> } {
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
        onQuickCreateTask={onQuickCreateTask}
      />,
    )
    return { onQuickCreateTask }
  }

  it('每个阶段列底部都有「+ 新建任务」入口；未传回调时不渲染', () => {
    renderQuick()
    expect(screen.getByRole('button', { name: '在「待办」阶段添加任务' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '在「审核」阶段添加任务' })).toBeInTheDocument()
    cleanup()
    render(
      <KanbanBoard
        workflow={wf}
        tasks={[]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /^在「/ })).not.toBeInTheDocument()
  })

  it('点开后就地输入，回车以该阶段建任务；成功后清空并保持展开（可连着建）', async () => {
    const user = userEvent.setup()
    const onQuickCreateTask = vi.fn<
      (stageId: string, title: string, description: string) => Promise<void>
    >(async () => undefined)
    renderQuick(onQuickCreateTask)

    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    const input = screen.getByLabelText('阶段「待办」的新任务标题')
    expect(input).toHaveFocus()
    await user.type(input, '  新卡片  {Enter}')

    await waitFor(() => expect(onQuickCreateTask).toHaveBeenCalledWith('s0', '新卡片', ''))
    expect(input).toHaveValue('')
    // 保持展开：输入框还在，接着敲下一张不用再点一次
    expect(screen.getByLabelText('阶段「待办」的新任务标题')).toBeInTheDocument()
  })

  it('描述随任务一起提交：Ctrl+Enter 创建，描述里的 Enter 只换行', async () => {
    const user = userEvent.setup()
    const onQuickCreateTask = vi.fn<
      (stageId: string, title: string, description: string) => Promise<void>
    >(async () => undefined)
    renderQuick(onQuickCreateTask)

    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '带要求的任务')
    const desc = screen.getByLabelText('阶段「待办」的新任务要求')
    await user.type(desc, '第一行{Enter}第二行')

    // 描述里的 Enter 是换行，不提交
    expect(onQuickCreateTask).not.toHaveBeenCalled()
    expect(desc).toHaveValue('第一行\n第二行')

    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() =>
      expect(onQuickCreateTask).toHaveBeenCalledWith('s0', '带要求的任务', '第一行\n第二行'),
    )
  })

  it('agent 阶段的列展开时提示「会立即交给智能体执行」', async () => {
    const user = userEvent.setup()
    render(
      <KanbanBoard
        workflow={agentWf}
        tasks={[]}
        onMoveToStage={vi.fn()}
        onCompleteTask={vi.fn()}
        onNewTask={vi.fn()}
        onQuickCreateTask={async () => undefined}
      />,
    )
    // 非 agent 列（待办）不提示
    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    expect(screen.queryByText(/立即交给智能体执行/)).not.toBeInTheDocument()
    // agent 列（执行）提示
    await user.click(screen.getByRole('button', { name: '在「执行」阶段添加任务' }))
    expect(screen.getByText(/立即交给智能体执行/)).toBeInTheDocument()
  })

  it('空标题回车提示必填、不发命令', async () => {
    const user = userEvent.setup()
    const { onQuickCreateTask } = renderQuick()
    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '   {Enter}')

    expect(await screen.findByText('任务标题必填')).toBeInTheDocument()
    expect(onQuickCreateTask).not.toHaveBeenCalled()
  })

  it('Esc 收起输入框且不发命令', async () => {
    const user = userEvent.setup()
    const { onQuickCreateTask } = renderQuick()
    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '半截{Escape}')

    expect(screen.queryByLabelText('阶段「待办」的新任务标题')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '在「待办」阶段添加任务' })).toBeInTheDocument()
    expect(onQuickCreateTask).not.toHaveBeenCalled()
  })

  it('描述里按 Esc 也收起表单（不发命令）', async () => {
    const user = userEvent.setup()
    const { onQuickCreateTask } = renderQuick()
    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '半截标题')
    await user.click(screen.getByLabelText('阶段「待办」的新任务要求'))
    await user.keyboard('{Escape}')

    expect(screen.queryByLabelText('阶段「待办」的新任务标题')).not.toBeInTheDocument()
    expect(onQuickCreateTask).not.toHaveBeenCalled()
  })

  it('创建失败就地展示错误并保留输入', async () => {
    const user = userEvent.setup()
    const onQuickCreateTask = vi
      .fn<(stageId: string, title: string, description: string) => Promise<void>>()
      .mockRejectedValue(new Error('任务标题重复'))
    renderQuick(onQuickCreateTask)

    await user.click(screen.getByRole('button', { name: '在「审核」阶段添加任务' }))
    const input = screen.getByLabelText('阶段「审核」的新任务标题')
    await user.type(input, '重复卡片{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent('任务标题重复')
    expect(input).toHaveValue('重复卡片')
  })

  it('提交中按 Esc 不收起表单（正在落库，半途关掉会让人以为没建成）', async () => {
    const user = userEvent.setup()
    let resolve!: () => void
    const onQuickCreateTask = vi.fn<
      (stageId: string, title: string, description: string) => Promise<void>
    >(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    renderQuick(onQuickCreateTask)

    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '慢任务{Enter}')
    await waitFor(() => expect(onQuickCreateTask).toHaveBeenCalled())

    await user.keyboard('{Escape}')
    expect(screen.getByLabelText('阶段「待办」的新任务标题')).toBeInTheDocument()

    resolve()
    await waitFor(() => expect(screen.getByLabelText('阶段「待办」的新任务标题')).toHaveValue(''))
  })

  it('失败原因不是 Error 时也转成可展示文案', async () => {
    const user = userEvent.setup()
    const onQuickCreateTask = vi
      .fn<(stageId: string, title: string, description: string) => Promise<void>>()
      .mockRejectedValue('工作流已被删除')
    renderQuick(onQuickCreateTask)

    await user.click(screen.getByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '卡片{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent('工作流已被删除')
  })
})
