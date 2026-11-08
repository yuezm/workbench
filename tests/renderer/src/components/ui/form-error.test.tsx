import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FormError } from '../../../../../src/renderer/src/components/ui/form-error'

describe('FormError', () => {
  it('空文案不渲染（null / undefined / 空串）', () => {
    const { rerender } = render(<FormError message={null} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    rerender(<FormError message={undefined} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    rerender(<FormError message="" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('有文案时用 role=alert + 危险色 token，不带关闭按钮', () => {
    render(<FormError message="任务标题必填" />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('任务标题必填')
    expect(alert).toHaveClass('border-danger/30', 'bg-danger/10', 'text-danger')
    expect(screen.queryByRole('button', { name: '关闭错误提示' })).not.toBeInTheDocument()
  })

  it('给 onDismiss 时可关闭，并透传 className', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(<FormError message="boom" className="mx-4" onDismiss={onDismiss} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveClass('mx-4')
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
