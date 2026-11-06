import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsNav } from '../../../../../../src/renderer/src/apps/ai-workflow/components/SettingsNav'

describe('SettingsNav', () => {
  it('列出五个栏目，标记当前项，点击回调', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<SettingsNav value="runtimes" onChange={onChange} />)

    expect(screen.getByRole('navigation', { name: '设置栏目' })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(5)
    expect(screen.getByRole('button', { name: '运行时' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '智能体' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: '插件' })).not.toHaveAttribute('aria-current')

    await user.click(screen.getByRole('button', { name: '智能体' }))
    expect(onChange).toHaveBeenCalledWith('agents')
    await user.click(screen.getByRole('button', { name: '工作流' }))
    expect(onChange).toHaveBeenCalledWith('workflows')
    await user.click(screen.getByRole('button', { name: '规则' }))
    expect(onChange).toHaveBeenCalledWith('rules')
    await user.click(screen.getByRole('button', { name: '插件' }))
    expect(onChange).toHaveBeenCalledWith('plugins')
  })

  it('第五栏为插件：选中时标记当前项', () => {
    render(<SettingsNav value="plugins" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '插件' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '运行时' })).not.toHaveAttribute('aria-current')
  })
})
