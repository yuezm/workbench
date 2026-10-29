import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { apps } from '../registry'
import { Sidebar } from './Sidebar'

describe('Sidebar', () => {
  it('渲染注册表中所有 app 条目', () => {
    render(<Sidebar apps={apps} activeId={apps[0]!.id} onSelect={() => {}} />)
    for (const app of apps) {
      expect(screen.getByRole('button', { name: app.name })).toBeInTheDocument()
    }
  })

  it('高亮当前选中的 app（aria-current）', () => {
    render(<Sidebar apps={apps} activeId={apps[0]!.id} onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: apps[0]!.name })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('未选中的条目没有 aria-current', () => {
    render(<Sidebar apps={apps} activeId="不存在" onSelect={() => {}} />)
    for (const app of apps) {
      expect(screen.getByRole('button', { name: app.name })).not.toHaveAttribute('aria-current')
    }
  })

  it('点击条目触发 onSelect 并携带 app id', async () => {
    const onSelect = vi.fn()
    render(<Sidebar apps={apps} activeId="" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: apps[0]!.name }))
    expect(onSelect).toHaveBeenCalledWith(apps[0]!.id)
  })
})
