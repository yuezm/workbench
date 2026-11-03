import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowWithStages } from '../../../../../shared/ai-workflow-api'
import { WorkflowSwitcher } from './WorkflowSwitcher'

function wf(id: string, name: string): WorkflowWithStages {
  return { id, name, description: '', createdAt: 't', stages: [] }
}

describe('WorkflowSwitcher', () => {
  it('切换、新建、编辑', async () => {
    const onSelect = vi.fn()
    const onNew = vi.fn()
    const onEdit = vi.fn()
    const user = userEvent.setup()
    render(
      <WorkflowSwitcher
        workflows={[wf('w1', 'A'), wf('w2', 'B')]}
        activeId="w1"
        onSelect={onSelect}
        onNew={onNew}
        onEdit={onEdit}
      />,
    )
    await user.click(screen.getByRole('combobox', { name: '选择工作流' }))
    expect(screen.getAllByRole('option')).toHaveLength(3)
    await user.click(screen.getByRole('option', { name: 'B' }))
    expect(onSelect).toHaveBeenCalledWith('w2')
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    expect(onNew).toHaveBeenCalled()
    const editBtn = screen.getByRole('button', { name: '编辑' })
    expect(editBtn).toBeEnabled()
    await user.click(editBtn)
    expect(onEdit).toHaveBeenCalled()
  })

  it('无激活工作流时编辑禁用', () => {
    render(
      <WorkflowSwitcher
        workflows={[]}
        activeId={undefined}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '编辑' })).toBeDisabled()
  })
})
