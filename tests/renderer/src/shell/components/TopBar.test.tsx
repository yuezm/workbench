import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { apps } from '../../../../../src/renderer/src/shell/registry'
import { TopBar } from '../../../../../src/renderer/src/shell/components/TopBar'

describe('TopBar', () => {
  it('渲染注册表中所有 app 标签', () => {
    render(<TopBar apps={apps} activeId={apps[0]!.id} onSelect={() => {}} />)
    for (const app of apps) {
      expect(screen.getByRole('button', { name: app.name })).toBeInTheDocument()
    }
  })

  it('高亮当前选中的 app（aria-current）', () => {
    render(<TopBar apps={apps} activeId={apps[0]!.id} onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: apps[0]!.name })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('未选中的标签没有 aria-current', () => {
    render(<TopBar apps={apps} activeId="不存在" onSelect={() => {}} />)
    for (const app of apps) {
      expect(screen.getByRole('button', { name: app.name })).not.toHaveAttribute('aria-current')
    }
  })

  it('点击标签触发 onSelect 并携带 app id', async () => {
    const onSelect = vi.fn()
    render(<TopBar apps={apps} activeId="" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: apps[0]!.name }))
    expect(onSelect).toHaveBeenCalledWith(apps[0]!.id)
  })

  it('右侧显示版本号', () => {
    render(<TopBar apps={apps} activeId={apps[0]!.id} onSelect={() => {}} />)
    expect(screen.getByText('v0.1.0')).toBeInTheDocument()
  })
})
