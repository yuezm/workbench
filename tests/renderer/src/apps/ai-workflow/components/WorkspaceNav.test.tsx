import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceNav } from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkspaceNav'

describe('WorkspaceNav', () => {
  it('横向列出两个栏目，标记当前项，点击回调', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <WorkspaceNav value="tasks" onChange={onChange}>
        <span>上下文列表</span>
      </WorkspaceNav>,
    )

    expect(screen.getByRole('navigation', { name: '工作台栏目' })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    // 任务在前、聊天在后：看板是日常主入口
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '任务',
      '聊天',
    ])
    expect(screen.getByRole('button', { name: '任务' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '聊天' })).not.toHaveAttribute('aria-current')

    await user.click(screen.getByRole('button', { name: '任务' }))
    expect(onChange).toHaveBeenCalledWith('tasks')
    await user.click(screen.getByRole('button', { name: '聊天' }))
    expect(onChange).toHaveBeenCalledWith('chat')
  })

  it('渲染当前栏目的上下文列表（children）', () => {
    const { rerender } = render(
      <WorkspaceNav value="chat" onChange={vi.fn()}>
        <span>会话清单</span>
      </WorkspaceNav>,
    )
    expect(screen.getByText('会话清单')).toBeInTheDocument()

    rerender(
      <WorkspaceNav value="tasks" onChange={vi.fn()}>
        <span>工作流切换器</span>
      </WorkspaceNav>,
    )
    expect(screen.getByText('工作流切换器')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '任务' })).toHaveAttribute('aria-current', 'page')
  })
})
