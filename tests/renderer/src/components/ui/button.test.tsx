import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  Button,
  buttonVariants,
  type ButtonProps,
} from '../../../../../src/renderer/src/components/ui/button'

describe('Button（shadcn 基座）', () => {
  it('缺省为 default 变体 / default 尺寸', () => {
    render(<Button>确定</Button>)
    const btn = screen.getByRole('button', { name: '确定' })
    expect(btn).toHaveClass('bg-primary', 'h-9')
    expect(btn).toHaveAttribute('data-variant', 'default')
    expect(btn).toHaveAttribute('data-size', 'default')
  })

  it.each([
    ['default', 'bg-primary'],
    ['secondary', 'bg-secondary'],
    ['outline', 'shadow-xs'],
    ['ghost', 'hover:bg-accent'],
    ['destructive', 'bg-destructive'],
    ['link', 'underline-offset-4'],
  ] as const)('variant=%s 应用对应主题', (variant, cls) => {
    render(<Button variant={variant}>{variant}</Button>)
    expect(screen.getByRole('button')).toHaveClass(cls)
  })

  it.each([
    ['xs', 'h-6'],
    ['sm', 'h-8'],
    ['default', 'h-9'],
    ['lg', 'h-10'],
    ['icon', 'size-9'],
  ] as const)('size=%s 应用对应尺寸', (size, cls) => {
    render(<Button size={size}>{size}</Button>)
    expect(screen.getByRole('button')).toHaveClass(cls)
  })

  it('统一基座：圆角、焦点环与禁用语义始终存在', () => {
    render(<Button>基座</Button>)
    expect(screen.getByRole('button')).toHaveClass(
      'rounded-md',
      'focus-visible:ring-[3px]',
      'disabled:pointer-events-none',
      'disabled:opacity-50',
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

  it('asChild 把按钮外观挂到子元素上', () => {
    render(
      <Button asChild>
        <a href="/target">链接</a>
      </Button>,
    )
    const link = screen.getByRole('link', { name: '链接' })
    expect(link).toHaveAttribute('href', '/target')
    expect(link).toHaveClass('bg-primary', 'h-9')
  })

  it('buttonVariants 可单独取用类名', () => {
    expect(buttonVariants({ variant: 'destructive', size: 'sm' })).toContain('bg-destructive')
    expect(buttonVariants({ variant: 'ghost' })).toContain('hover:bg-accent')
  })

  it('ButtonProps 导出变体与尺寸联合类型', () => {
    const props: ButtonProps = { variant: 'outline', size: 'sm', disabled: true }
    render(<Button {...props}>透传</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'outline')
  })
})
