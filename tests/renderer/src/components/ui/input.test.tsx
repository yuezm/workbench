import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Input } from '../../../../../src/renderer/src/components/ui/input'

describe('Input', () => {
  it('渲染原生 input 语义与统一外观', () => {
    render(<Input aria-label="名称" placeholder="请输入" value="x" onChange={vi.fn()} />)
    const input = screen.getByLabelText<HTMLInputElement>('名称')
    expect(input.type).toBe('text')
    expect(input).toHaveAttribute('placeholder', '请输入')
    expect(input).toHaveValue('x')
    expect(input).toHaveClass('h-9', 'rounded-md', 'border-line', 'bg-surface-2')
  })

  it('输入触发 onChange', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Input aria-label="名称" value="" onChange={onChange} />)
    await user.type(screen.getByLabelText('名称'), 'a')
    expect(onChange).toHaveBeenCalled()
  })

  it('透传 type / disabled / className', () => {
    render(<Input aria-label="密码" type="password" disabled className="font-mono" />)
    const input = screen.getByLabelText('密码')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toBeDisabled()
    expect(input).toHaveClass('font-mono')
  })
})
