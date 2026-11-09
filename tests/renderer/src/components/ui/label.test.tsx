import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Label } from '../../../../../src/renderer/src/components/ui/label'
import { Input } from '../../../../../src/renderer/src/components/ui/input'

describe('Label（shadcn 基座）', () => {
  it('渲染 label 元素并关联表单控件', () => {
    render(
      <>
        <Label htmlFor="名称">名称</Label>
        <Input id="名称" />
      </>,
    )
    const label = screen.getByText('名称')
    expect(label.tagName).toBe('LABEL')
    expect(label).toHaveAttribute('for', '名称')
    expect(screen.getByLabelText('名称')).toBeInTheDocument()
  })

  it('统一基座：中等字重、不可选中', () => {
    render(<Label>标题</Label>)
    expect(screen.getByText('标题')).toHaveClass('text-sm', 'font-medium', 'select-none')
  })

  it('外部 className 可参与合并', () => {
    render(<Label className="text-destructive">错误</Label>)
    expect(screen.getByText('错误')).toHaveClass('text-destructive')
  })

  it('包裹控件时点击标签聚焦控件', () => {
    render(
      <Label>
        名称
        <Input />
      </Label>,
    )
    expect(screen.getByText('名称').querySelector('input')).toBeInTheDocument()
  })
})
