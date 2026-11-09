import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { appPlugins } from '../../../../../src/renderer/src/shell/registry'
import { TopBar } from '../../../../../src/renderer/src/shell/components/TopBar'

describe('TopBar', () => {
  it('渲染注册表中所有 app 标签', () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    for (const app of appPlugins) {
      expect(screen.getByRole('button', { name: app.name })).toBeInTheDocument()
    }
  })

  it('高亮当前选中的 app（aria-current）', () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: appPlugins[0]!.name })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('未选中的标签没有 aria-current', () => {
    render(<TopBar apps={appPlugins} activeId="不存在" onSelect={() => {}} />)
    for (const app of appPlugins) {
      expect(screen.getByRole('button', { name: app.name })).not.toHaveAttribute('aria-current')
    }
  })

  it('点击标签触发 onSelect 并携带 app id', async () => {
    const onSelect = vi.fn()
    render(<TopBar apps={appPlugins} activeId="" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: appPlugins[0]!.name }))
    expect(onSelect).toHaveBeenCalledWith(appPlugins[0]!.id)
  })

  it('右侧显示版本号', () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    expect(screen.getByText('v0.1.0')).toBeInTheDocument()
  })

  it('右侧有主题切换器：全局入口，任何 app 都能切主题', async () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: /主题：/ })
    expect(trigger).toBeInTheDocument()
    // hover 展开三个选项：亮色 / 暗色 / 跟随系统
    await userEvent.hover(trigger)
    expect(await screen.findByRole('group', { name: '主题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '亮色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '暗色' })).toBeInTheDocument()
  })
})
