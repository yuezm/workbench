import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Task, WorkflowStage } from '../../../../../../src/protocol/entities'
import { TaskCard } from '../../../../../../src/renderer/src/apps/ai-workflow/components/TaskCard'

function stage(entryMode: WorkflowStage['entryMode']): WorkflowStage {
  return {
    id: 's',
    workflowId: 'w',
    name: '阶段',
    position: 0,
    entryMode,
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
    handoffWorkflowId: null,
    handoffStageId: null,
  }
}
const task: Task = {
  id: 't1',
  title: '写代码',
  description: '细节',
  workflowId: 'w',
  currentStageId: 's',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: 'x',
  updatedAt: 'x',
}

describe('TaskCard', () => {
  it('渲染标题/描述；不交接阶段可拖拽并回调拖拽事件', () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    render(
      <TaskCard
        task={task}
        stage={stage('none')}
        executing={false}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />,
    )
    expect(screen.getByText('写代码')).toBeInTheDocument()
    expect(screen.getByText('细节')).toBeInTheDocument()
    expect(screen.getByText('拖动推进')).toBeInTheDocument()

    const card = screen.getByLabelText('任务：写代码')
    expect(card).toHaveAttribute('draggable', 'true')
    expect(card.className).toContain('cursor-grab')
    fireEvent.dragStart(card)
    expect(onDragStart).toHaveBeenCalledWith(task)
    fireEvent.dragEnd(card)
    expect(onDragEnd).toHaveBeenCalled()
  })

  it('拖拽中卡片半透明', () => {
    render(
      <TaskCard
        task={{ ...task, description: '' }}
        stage={stage('none')}
        executing={false}
        dragging
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('任务：写代码').className).toContain('opacity-40')
  })

  it('user 阶段提示等待你处理，不再有通过/打回按钮', () => {
    render(
      <TaskCard
        task={task}
        stage={stage('user')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('等待你处理')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '通过' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打回' })).not.toBeInTheDocument()
  })

  it('有活跃 run：显示执行中且不可拖拽', () => {
    render(
      <TaskCard
        task={task}
        stage={stage('agent')}
        executing
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('执行中…')).toBeInTheDocument()
    const card = screen.getByLabelText('任务：写代码')
    expect(card.querySelector('.animate-pulse')).not.toBeNull()
    expect(card).toHaveAttribute('draggable', 'false')
    expect(card.className).toContain('cursor-default')
  })

  it('agent 阶段失败后没有活跃 run：可拖走重试并给出提示', () => {
    render(
      <TaskCard
        task={task}
        stage={stage('agent')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('可拖走重试')).toBeInTheDocument()
    expect(screen.queryByText('执行中…')).not.toBeInTheDocument()
    expect(screen.getByLabelText('任务：写代码')).toHaveAttribute('draggable', 'true')
  })

  it('执行中优先于阶段进入方式（none/user 阶段有活跃 run 也不可拖）', () => {
    render(
      <TaskCard
        task={task}
        stage={stage('user')}
        executing
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('执行中…')).toBeInTheDocument()
    expect(screen.queryByText('等待你处理')).not.toBeInTheDocument()
    expect(screen.getByLabelText('任务：写代码')).toHaveAttribute('draggable', 'false')
  })

  it('派生任务显示子任务徽标；父任务在看板里时带上父任务标题', () => {
    const { rerender } = render(
      <TaskCard
        task={{ ...task, parentTaskId: 't0' }}
        stage={stage('none')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('子任务')).toBeInTheDocument()

    rerender(
      <TaskCard
        task={{ ...task, parentTaskId: 't0' }}
        stage={stage('none')}
        executing={false}
        parentTitle="父任务"
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('子任务 · 父任务')).toBeInTheDocument()
    expect(screen.queryByText('子任务')).not.toBeInTheDocument()

    // 父任务标题为空串时退化为纯「子任务」徽标
    rerender(
      <TaskCard
        task={{ ...task, parentTaskId: 't0' }}
        stage={stage('none')}
        executing={false}
        parentTitle=""
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('子任务')).toBeInTheDocument()
  })

  it('无父任务时不显示子任务徽标', () => {
    render(
      <TaskCard
        task={task}
        stage={stage('none')}
        executing={false}
        parentTitle="忽略"
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.queryByText(/子任务/)).not.toBeInTheDocument()
  })

  it('单击卡片进入任务详情页；键盘 Enter / Space 同样生效', () => {
    const onOpenTask = vi.fn()
    render(
      <TaskCard
        task={task}
        stage={stage('none')}
        executing={false}
        onOpenTask={onOpenTask}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    const card = screen.getByLabelText('任务：写代码')
    expect(card).toHaveAttribute('role', 'button')

    fireEvent.click(card)
    expect(onOpenTask).toHaveBeenCalledTimes(1)
    expect(onOpenTask).toHaveBeenCalledWith(task)

    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: ' ' })
    expect(onOpenTask).toHaveBeenCalledTimes(3)

    // 其它按键不触发跳转
    fireEvent.keyDown(card, { key: 'a' })
    expect(onOpenTask).toHaveBeenCalledTimes(3)
  })

  it('卡片内的线程入口不触发任务详情跳转', () => {
    const onOpenTask = vi.fn()
    const onOpenThread = vi.fn()
    render(
      <TaskCard
        task={{ ...task, threadId: 'th1' }}
        stage={stage('none')}
        executing={false}
        onOpenTask={onOpenTask}
        onOpenThread={onOpenThread}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    const entry = screen.getByRole('button', { name: '打开线程：写代码' })
    fireEvent.click(entry)
    expect(onOpenThread).toHaveBeenCalledWith('th1')
    expect(onOpenTask).not.toHaveBeenCalled()

    // 线程按钮上的按键会冒泡到卡片，但不应被当成打开任务详情
    fireEvent.keyDown(entry, { key: 'Enter' })
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('没有 onOpenTask 时点击卡片不报错', () => {
    render(
      <TaskCard
        task={task}
        stage={stage('none')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(() => fireEvent.click(screen.getByLabelText('任务：写代码'))).not.toThrow()
  })

  it('有 threadId 且传了回调时提供线程入口，点击把任务交给上层', () => {
    const onOpenThread = vi.fn()
    render(
      <TaskCard
        task={{ ...task, threadId: 'th1' }}
        stage={stage('none')}
        executing={false}
        onOpenThread={onOpenThread}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    const entry = screen.getByRole('button', { name: '打开线程：写代码' })
    expect(entry).toHaveTextContent('线程')
    fireEvent.click(entry)
    expect(onOpenThread).toHaveBeenCalledWith('th1')
  })

  it('没有 threadId 或没有回调时不渲染线程入口', () => {
    const { rerender } = render(
      <TaskCard
        task={task}
        stage={stage('none')}
        executing={false}
        onOpenThread={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: '打开线程：写代码' })).not.toBeInTheDocument()

    rerender(
      <TaskCard
        task={{ ...task, threadId: 'th1' }}
        stage={stage('none')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: '打开线程：写代码' })).not.toBeInTheDocument()
  })

  it('交接任务显示交接徽标并说明由其它工作流的阶段产出', () => {
    const { rerender } = render(
      <TaskCard
        task={{ ...task, origin: 'handoff', handoffFromTaskId: 't0', handoffFromStageId: 's0' }}
        stage={stage('none')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    const badge = screen.getByTitle('由其它工作流的阶段完成时自动创建')
    expect(badge).toHaveTextContent('交接')
    // 交接任务不再显示子任务徽标（parentTaskId 为 null）
    expect(screen.queryByText(/子任务/)).not.toBeInTheDocument()

    // origin 仍是 manual 但带了交接来源列：按交接展示（防御旧数据 / 导入）
    rerender(
      <TaskCard
        task={{ ...task, origin: 'manual', handoffFromTaskId: 't0', handoffFromStageId: 's0' }}
        stage={stage('none')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByTitle('由其它工作流的阶段完成时自动创建')).toHaveTextContent('交接')

    // 普通任务没有徽标
    rerender(
      <TaskCard
        task={task}
        stage={stage('none')}
        executing={false}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.queryByText('交接')).not.toBeInTheDocument()
  })

  it('父任务显示子任务完成进度（M8）', () => {
    const { rerender } = render(
      <TaskCard
        task={task}
        stage={stage('agent')}
        executing={false}
        childProgress={{ done: 2, total: 3 }}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByText('子任务 2/3')).toBeInTheDocument()

    rerender(
      <TaskCard
        task={task}
        stage={stage('agent')}
        executing={false}
        childProgress={{ done: 0, total: 0 }}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.queryByText(/子任务 \d/)).not.toBeInTheDocument()
  })
})
