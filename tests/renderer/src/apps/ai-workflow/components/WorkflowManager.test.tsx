import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowWithStages } from '../../../../../../src/shared/ai-workflow-api'
import { WorkflowManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkflowManager'

function wf(id: string, name: string, stages = 0, description = ''): WorkflowWithStages {
  return {
    id,
    name,
    description,
    createdAt: 't',
    stages: Array.from({ length: stages }, (_, i) => ({
      id: `${id}-s${i}`,
      workflowId: id,
      name: `阶段${i + 1}`,
      position: i,
      entryMode: 'none' as const,
      agentId: null,
      onCompleteStageId: null,
      onRejectStageId: null,
    })),
  }
}

describe('WorkflowManager', () => {
  it('列出工作流，点击行选中、点击编辑回调', async () => {
    const onSelect = vi.fn()
    const onEdit = vi.fn()
    const user = userEvent.setup()
    render(
      <WorkflowManager
        workflows={[wf('w1', '研发', 3, '日常研发'), wf('w2', '写作')]}
        activeId="w1"
        onSelect={onSelect}
        onEdit={onEdit}
        onNew={vi.fn()}
      />,
    )
    expect(screen.getByText('3 阶段 · 日常研发')).toBeInTheDocument()
    expect(screen.getByText('当前')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /写作/ }))
    expect(onSelect).toHaveBeenCalledWith('w2')
    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }))
  })

  it('新建工作流回调；空清单显示空态', async () => {
    const onNew = vi.fn()
    const user = userEvent.setup()
    render(
      <WorkflowManager
        workflows={[]}
        activeId={undefined}
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onNew={onNew}
      />,
    )
    expect(screen.getByText('暂无工作流')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    expect(onNew).toHaveBeenCalled()
  })
})
