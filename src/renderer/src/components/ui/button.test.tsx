import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './button'

describe('Button（UI 基元契约）', () => {
  it('缺省为 secondary / md', () => {
    render(<Button>确定</Button>)
    const btn = screen.getByRole('button', { name: '确定' })
    expect(btn).toHaveClass('bg-white/[0.04]', 'h-10')
  })

  it.each([
    ['primary', 'bg-gradient-to-b'],
    ['secondary', 'bg-white/[0.04]'],
    ['ghost', 'text-ink-dim'],
  ] as const)('variant=%s 应用对应主题', (variant, cls) => {
    render(<Button variant={variant}>{variant}</Button>)
    expect(screen.getByRole('button')).toHaveClass(cls)
  })

  it.each([
    ['sm', 'h-8'],
    ['md', 'h-10'],
    ['lg', 'h-11'],
  ] as const)('size=%s 应用对应尺寸', (size, cls) => {
    render(<Button size={size}>{size}</Button>)
    expect(screen.getByRole('button')).toHaveClass(cls)
  })

  it('统一基座：圆角、焦点环与禁用语义始终存在', () => {
    render(<Button>基座</Button>)
    expect(screen.getByRole('button')).toHaveClass(
      'rounded-xl',
      'focus-visible:ring-2',
      'disabled:pointer-events-none',
      'disabled:opacity-40',
    )
  })

  it('透传原生属性，外部 className 可参与合并', () => {
    render(
      <Button className="min-w-40" disabled type="submit">
        提交
      </Button>,
    )
    const btn = screen.getByRole('button', { name: '提交' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('type', 'submit')
    expect(btn).toHaveClass('min-w-40')
  })
})
