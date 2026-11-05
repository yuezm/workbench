import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsNav } from '../../../../../../src/renderer/src/apps/ai-workflow/components/SettingsNav'

describe('SettingsNav', () => {
  it('列出四个栏目，标记当前项，点击回调', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<SettingsNav value="runtimes" onChange={onChange} />)

    expect(screen.getByRole('navigation', { name: '设置栏目' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '运行时配置' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('button', { name: '智能体配置' })).not.toHaveAttribute('aria-current')

    await user.click(screen.getByRole('button', { name: '智能体配置' }))
    expect(onChange).toHaveBeenCalledWith('agents')
    await user.click(screen.getByRole('button', { name: '工作流配置' }))
    expect(onChange).toHaveBeenCalledWith('workflows')
    await user.click(screen.getByRole('button', { name: '规则配置' }))
    expect(onChange).toHaveBeenCalledWith('rules')
  })
})
