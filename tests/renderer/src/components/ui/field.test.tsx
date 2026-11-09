import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Field } from '../../../../../src/renderer/src/components/ui/field'

describe('Field', () => {
  it('用 label 包裹控件并渲染小标签', () => {
    render(
      <Field label="名称">
        <input aria-label="名称输入" />
      </Field>,
    )
    const label = screen.getByText('名称')
    expect(label.tagName).toBe('SPAN')
    expect(label).toHaveClass('text-xs', 'text-muted-foreground')
    expect(label.closest('label')).toContainElement(screen.getByLabelText('名称输入'))
  })

  it('外部 className 可覆盖布局', () => {
    render(
      <Field label="名称" className="col-span-2">
        <input aria-label="名称输入" />
      </Field>,
    )
    expect(screen.getByText('名称').closest('label')).toHaveClass('col-span-2')
  })

  it('默认不渲染必填标记与错误槽', () => {
    render(
      <Field label="描述">
        <input aria-label="描述输入" />
      </Field>,
    )
    expect(screen.queryByText('*')).not.toBeInTheDocument()
    expect(screen.queryByText('必填')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('必填：星号给视觉、读屏另有「必填」说明', () => {
    render(
      <Field label="任务标题" required>
        <input aria-label="任务标题" />
      </Field>,
    )
    const star = screen.getByText('*')
    expect(star).toHaveClass('text-destructive')
    expect(star).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('必填')).toHaveClass('sr-only')
  })

  it('说明文字作为常驻提示渲染', () => {
    render(
      <Field label="cron" hint="分 时 日 月 周">
        <input aria-label="cron 输入" />
      </Field>,
    )
    expect(screen.getByText('分 时 日 月 周')).toHaveClass('text-xs', 'text-faint-foreground')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('字段错误用 role=alert 渲染，空串不渲染', () => {
    const { rerender } = render(
      <Field label="任务标题" required error="任务标题必填">
        <input aria-label="任务标题" />
      </Field>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('任务标题必填')
    expect(screen.getByRole('alert')).toHaveClass('text-destructive')

    rerender(
      <Field label="任务标题" required error="">
        <input aria-label="任务标题" />
      </Field>,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
