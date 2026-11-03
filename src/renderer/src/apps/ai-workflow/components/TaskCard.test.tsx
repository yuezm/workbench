import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Task, WorkflowStage } from '../../../../../shared/ai-workflow-api'
import { TaskCard } from './TaskCard'

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
  }
}
const task: Task = {
  id: 't1',
  title: '写代码',
  description: '细节',
  workflowId: 'w',
  currentStageId: 's',
  status: 'active',
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
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />,
    )
    expect(screen.getByText('写代码')).toBeInTheDocument()
    expect(screen.getByText('细节')).toBeInTheDocument()
    expect(screen.getByText('拖到其它阶段推进')).toBeInTheDocument()

    const card = screen.getByLabelText('任务：写代码')
    expect(card).toHaveAttribute('draggable', 'true')
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
        dragging
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('任务：写代码').className).toContain('opacity-40')
  })

  it('user 阶段提示等待你处理，不再有通过/打回按钮', () => {
    render(<TaskCard task={task} stage={stage('user')} onDragStart={vi.fn()} onDragEnd={vi.fn()} />)
    expect(screen.getByText('等待你处理')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '通过' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打回' })).not.toBeInTheDocument()
  })

  it('agent 阶段显示执行中且不可拖拽', () => {
    render(
      <TaskCard task={task} stage={stage('agent')} onDragStart={vi.fn()} onDragEnd={vi.fn()} />,
    )
    expect(screen.getByText(/执行中/)).toBeInTheDocument()
    expect(screen.getByLabelText('任务：写代码')).toHaveAttribute('draggable', 'false')
  })
})
