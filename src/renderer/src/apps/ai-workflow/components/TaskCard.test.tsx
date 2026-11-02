import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  it('user 阶段显示通过/打回并回调', async () => {
    const onMove = vi.fn()
    const user = userEvent.setup()
    render(<TaskCard task={task} stage={stage('user')} onMove={onMove} />)
    expect(screen.getByText('写代码')).toBeInTheDocument()
    expect(screen.getByText('细节')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '通过' }))
    expect(onMove).toHaveBeenCalledWith('t1', 'approve')
    await user.click(screen.getByRole('button', { name: '打回' }))
    expect(onMove).toHaveBeenCalledWith('t1', 'reject')
  })

  it('none 阶段显示推进', async () => {
    const onMove = vi.fn()
    const user = userEvent.setup()
    render(<TaskCard task={{ ...task, description: '' }} stage={stage('none')} onMove={onMove} />)
    await user.click(screen.getByRole('button', { name: '推进' }))
    expect(onMove).toHaveBeenCalledWith('t1', 'next')
  })

  it('agent 阶段显示执行中', () => {
    render(<TaskCard task={task} stage={stage('agent')} onMove={vi.fn()} />)
    expect(screen.getByText(/执行中/)).toBeInTheDocument()
  })
})
