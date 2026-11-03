import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Task, WorkflowStage, WorkflowWithStages } from '../../../../../shared/ai-workflow-api'
import { KanbanBoard } from './KanbanBoard'

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

function setup(tasks: Task[] = [task]): {
  onMoveToStage: ReturnType<typeof vi.fn>
  onCompleteTask: ReturnType<typeof vi.fn>
  onNewTask: ReturnType<typeof vi.fn>
} {
  const onMoveToStage = vi.fn()
  const onCompleteTask = vi.fn()
  const onNewTask = vi.fn()
  render(
    <KanbanBoard
      workflow={wf}
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

  it('拖到「已完成」区触发 completeTask', () => {
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
    const { onMoveToStage, onCompleteTask } = setup()
    const target = screen.getByRole('group', { name: '阶段：待办' })
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    fireEvent.dragOver(screen.getByRole('group', { name: '已完成区' }))
    fireEvent.drop(screen.getByRole('group', { name: '已完成区' }))
    expect(onMoveToStage).not.toHaveBeenCalled()
    expect(onCompleteTask).not.toHaveBeenCalled()
  })
})
