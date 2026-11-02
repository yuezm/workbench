import { render, screen } from '@testing-library/react'
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

describe('KanbanBoard', () => {
  it('按阶段分列，空列提示，渲染卡片并回调新建', async () => {
    const onNewTask = vi.fn()
    const onMove = vi.fn()
    const user = userEvent.setup()
    render(<KanbanBoard workflow={wf} tasks={[task]} onMove={onMove} onNewTask={onNewTask} />)
    expect(screen.getByText('工作流「研发」')).toBeInTheDocument()
    expect(screen.getByText('待办')).toBeInTheDocument()
    expect(screen.getByText('审核')).toBeInTheDocument()
    expect(screen.getByText('空')).toBeInTheDocument()
    expect(screen.getByText('卡片任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建任务' }))
    expect(onNewTask).toHaveBeenCalled()
  })
})
