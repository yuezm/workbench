import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../../../../src/protocol/entities'
import {
  DEFAULT_PROJECT_ID,
  ProjectSwitcher,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/ProjectSwitcher'

function project(id: string, name: string, path: string): Project {
  return { id, name, path, description: '', createdAt: 't', updatedAt: 't' }
}

const projects = [
  project('p1', '工作台', 'D:\\Codes\\workbench'),
  project('p2', '笔记', 'D:\\Notes\\long-folder-name-for-truncation'),
]

const DEFAULT_PATH = 'C:\\Users\\me\\.workbench'

describe('ProjectSwitcher', () => {
  it('列出项目：标题行 + 每个项目名与文件夹路径；点击回调 onSelect', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectSwitcher
        projects={projects}
        activeId="p1"
        defaultPath={DEFAULT_PATH}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '项目：工作台' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '默认目录' })).toBeInTheDocument()
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
        defaultPath={DEFAULT_PATH}
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
        defaultPath={DEFAULT_PATH}
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

  it('没有项目时给空态与引导文案，默认目录行仍然可用', () => {
    render(
      <ProjectSwitcher
        projects={[]}
        activeId={undefined}
        defaultPath={DEFAULT_PATH}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText('还没有项目，可先落到默认目录')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '默认目录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ 添加' })).toBeInTheDocument()
  })

  it('「默认目录」行常驻：副标题是宿主默认目录路径，可选中且没有编辑入口', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <ProjectSwitcher
        projects={projects}
        activeId={DEFAULT_PROJECT_ID}
        defaultPath={DEFAULT_PATH}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )

    const row = screen.getByRole('button', { name: '默认目录' })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row.className).toContain('bg-surface-3')
    expect(screen.getByText(DEFAULT_PATH)).toBeInTheDocument()
    // 默认目录不对应项目行：没有文件夹选择器也没有编辑入口
    expect(screen.queryByRole('button', { name: '编辑项目 默认目录' })).not.toBeInTheDocument()

    await user.click(row)
    expect(onSelect).toHaveBeenCalledWith(DEFAULT_PROJECT_ID)
  })

  it('默认目录路径未知时给兜底文案', () => {
    render(
      <ProjectSwitcher
        projects={projects}
        activeId="p1"
        defaultPath=""
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText('未配置项目时的工作目录')).toBeInTheDocument()
  })

  it('有项目时默认目录行也在（不依赖未归属数量），未选中不高亮', () => {
    render(
      <ProjectSwitcher
        projects={projects}
        activeId="p1"
        defaultPath={DEFAULT_PATH}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '默认目录' })).not.toHaveAttribute('aria-current')
    expect(screen.queryByText('还没有项目，可先落到默认目录')).not.toBeInTheDocument()
    // 默认目录行只占一行，不带数量徽标（它不是伪项目聚合）
    expect(screen.queryByText('没有项目的任务')).not.toBeInTheDocument()
  })
})
