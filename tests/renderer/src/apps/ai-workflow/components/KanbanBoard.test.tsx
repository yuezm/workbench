import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    onCompleteStageId: null,
    onRejectStageId: null,
    handoffWorkflowId: null,
    handoffStageId: null,
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
