import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeProbe } from '../../../../../../src/protocol/entities'
import { RuntimeStatusBadge } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RuntimeStatusBadge'

function probe(over: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    state: 'ready',
    path: 'C:/tools/dsh.exe',
    cliVersion: '1.2.3',
    protocolVersion: 1,
    pluginVersion: null,
    error: null,
    output: '',
    elapsedMs: 12,
    checkedAt: 't',
    ...over,
  }
}

describe('RuntimeStatusBadge', () => {
  it('从未探测显示「未检测」', () => {
    render(<RuntimeStatusBadge probe={null} />)
    expect(screen.getByText('未检测')).toBeInTheDocument()
  })

  it('可用时显示状态与耗时，绿色', () => {
    render(<RuntimeStatusBadge probe={probe()} />)
    const badge = screen.getByText('可用 · 12ms')
    expect(badge.className).toContain('text-success')
  })

  it('探测中优先于 lastProbe 展示', () => {
    render(<RuntimeStatusBadge probe={probe()} testing />)
    expect(screen.getByText('测试中…')).toBeInTheDocument()
    expect(screen.queryByText('可用 · 12ms')).not.toBeInTheDocument()
  })

  it('不可用且无点击回调时只做展示，title 带失败原因', () => {
    render(<RuntimeStatusBadge probe={probe({ state: 'unavailable', error: '登录态失效' })} />)
    const badge = screen.getByText('不可用 · 12ms')
    expect(badge).toHaveAttribute('title', '登录态失效')
    expect(badge.className).toContain('text-destructive')
  })

  it('不可用且缺原因时用兜底文案', () => {
    render(<RuntimeStatusBadge probe={probe({ state: 'unavailable', error: null })} />)
    expect(screen.getByText('不可用 · 12ms')).toHaveAttribute('title', '探测失败')
  })

  it('不可用且有点击回调时是可展开按钮', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(
      <RuntimeStatusBadge
        probe={probe({ state: 'unavailable', error: '失败' })}
        expanded
        onToggle={onToggle}
      />,
    )
    const button = screen.getByRole('button', { name: '不可用 · 12ms' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await user.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
