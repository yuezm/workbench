import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Field } from './field'

describe('Field', () => {
  it('用 label 包裹控件并渲染小标签', () => {
    render(
      <Field label="名称">
        <input aria-label="名称输入" />
      </Field>,
    )
    const label = screen.getByText('名称')
    expect(label.tagName).toBe('SPAN')
    expect(label).toHaveClass('text-[11px]', 'text-ink-faint')
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
})
