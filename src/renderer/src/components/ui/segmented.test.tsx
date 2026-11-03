import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Segmented } from './segmented'

const options = [
  { value: 'board', label: '工作台' },
  { value: 'settings', label: '设置' },
] as const

describe('Segmented', () => {
  it('渲染选项并标记当前选中项', () => {
    render(
      <Segmented value="board" onChange={vi.fn()} options={[...options]} ariaLabel="视图切换" />,
    )
    expect(screen.getByRole('tablist', { name: '视图切换' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '工作台' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '设置' })).toHaveAttribute('aria-selected', 'false')
  })

  it('点击切换时回调对应值', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Segmented value="board" onChange={onChange} options={[...options]} />)
    await user.click(screen.getByRole('tab', { name: '设置' }))
    expect(onChange).toHaveBeenCalledWith('settings')
  })
})
