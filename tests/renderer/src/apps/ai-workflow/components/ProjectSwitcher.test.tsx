import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../../../../src/protocol/entities'
import {
  ProjectSwitcher,
  UNASSIGNED_PROJECT_ID,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/ProjectSwitcher'

function project(id: string, name: string, path: string): Project {
  return { id, name, path, description: '', createdAt: 't', updatedAt: 't' }
}

const projects = [
  project('p1', '工作台', 'D:\\Codes\\workbench'),
  project('p2', '笔记', 'D:\\Notes\\long-folder-name-for-truncation'),
]

describe('ProjectSwitcher', () => {
  it('列出项目：标题行 + 每个项目名与文件夹路径；点击回调 onSelect', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectSwitcher
        projects={projects}
        activeId="p1"
        unassignedCount={0}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '项目：工作台' })).toBeInTheDocument()
    expect(screen.getByText('D:\\Codes\\workbench')).toBeInTheDocument()
    // 路径可能很长：只截断展示，不换行
    expect(screen.getByText('D:\\Notes\\long-folder-name-for-truncation').className).toContain(
      'truncate',
    )

    await user.click(screen.getByRole('button', { name: '项目：笔记' }))
    expect(onSelect).toHaveBeenCalledWith('p2')
  })

  it('「+ 添加」触发 onCreate', async () => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectSwitcher
        projects={projects}
        activeId="p1"
        unassignedCount={0}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onEdit={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: '+ 添加' }))
    expect(onCreate).toHaveBeenCalled()
  })

  it('选中项高亮，且只有选中项露出「编辑」按钮', async () => {
    const onEdit = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectSwitcher
        projects={projects}
        activeId="p2"
        unassignedCount={0}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onEdit={onEdit}
      />,
    )

    const active = screen.getByRole('button', { name: '项目：笔记' })
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(active.className).toContain('bg-surface-3')
    expect(screen.getByRole('button', { name: '项目：工作台' })).not.toHaveAttribute('aria-current')

    // 编辑只挂在选中项上：非选中项不出现编辑入口
    expect(screen.queryByRole('button', { name: '编辑项目 工作台' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '编辑项目 笔记' }))
    expect(onEdit).toHaveBeenCalledWith(projects[1])
  })

  it('没有项目且没有未归属任务时给空态与引导文案', () => {
    render(
      <ProjectSwitcher
        projects={[]}
        activeId={undefined}
        unassignedCount={0}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText('还没有项目')).toBeInTheDocument()
    expect(screen.getByText('添加本地文件夹作为项目')).toBeInTheDocument()
  })

  it('有未归属任务时在末尾渲染「未归属」行：副标题 + 数量，可选中且没有编辑入口', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectSwitcher
        projects={projects}
        activeId={UNASSIGNED_PROJECT_ID}
        unassignedCount={3}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )

    const row = screen.getByRole('button', { name: '未归属' })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row.className).toContain('bg-surface-3')
    expect(screen.getByText('没有项目的任务')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    // 伪项目没有文件夹也没有编辑入口
    expect(screen.queryByRole('button', { name: '编辑项目 未归属' })).not.toBeInTheDocument()

    await user.click(row)
    expect(onSelect).toHaveBeenCalledWith(UNASSIGNED_PROJECT_ID)
  })

  it('没有未归属任务时不渲染「未归属」行', () => {
    render(
      <ProjectSwitcher
        projects={projects}
        activeId={undefined}
        unassignedCount={0}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: '未归属' })).not.toBeInTheDocument()
    expect(screen.queryByText('没有项目的任务')).not.toBeInTheDocument()
  })

  it('一个项目都没有但有未归属任务：不显示空态，只显示未归属行', () => {
    render(
      <ProjectSwitcher
        projects={[]}
        activeId={UNASSIGNED_PROJECT_ID}
        unassignedCount={2}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.queryByText('还没有项目')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '未归属' })).toBeInTheDocument()
  })
})
