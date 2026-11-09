import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Textarea } from '../../../../../src/renderer/src/components/ui/textarea'

describe('Textarea（shadcn 基座）', () => {
  it('渲染原生 textarea 语义与统一外观', () => {
    render(<Textarea aria-label="备注" placeholder="请输入" value="x" onChange={vi.fn()} />)
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('备注')
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea).toHaveAttribute('placeholder', '请输入')
    expect(textarea).toHaveValue('x')
    expect(textarea).toHaveClass('w-full', 'rounded-md', 'border-input')
  })

  it('输入触发 onChange', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Textarea aria-label="备注" value="" onChange={onChange} />)
    await user.type(screen.getByLabelText('备注'), 'a')
    expect(onChange).toHaveBeenCalled()
  })

  it('透传 disabled / rows / className', () => {
    render(<Textarea aria-label="备注" disabled rows={4} className="min-h-24 font-mono" />)
    const textarea = screen.getByLabelText('备注')
    expect(textarea).toBeDisabled()
    expect(textarea).toHaveAttribute('rows', '4')
    expect(textarea).toHaveClass('min-h-24', 'font-mono')
  })

  it('非法值走 aria-invalid 语义', () => {
    render(<Textarea aria-label="备注" aria-invalid value="" onChange={vi.fn()} />)
    const textarea = screen.getByLabelText('备注')
    expect(textarea).toHaveAttribute('aria-invalid', 'true')
    expect(textarea).toHaveClass('aria-invalid:border-destructive')
  })
})
