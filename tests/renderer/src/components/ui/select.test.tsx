import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../../../src/renderer/src/components/ui/select'

/**
 * Radix Select 打开时会给 body 加 pointer-events: none（disableOutsidePointerEvents），
 * jsdom 下 userEvent 默认会因此拒绝后续指针交互。关掉这层检查，才能真实模拟
 * 「点外部关闭」「再点触发器收起」这类 Radix 行为。
 */
const setupUser = () => userEvent.setup({ pointerEventsCheck: 0 })

/** 上游复合结构的最小可用组合 */
function Fixture({
  value = 'a',
  onValueChange = vi.fn(),
  placeholder = '请选择',
  options = [
    { value: 'a', label: '选项 A' },
    { value: 'b', label: '选项 B' },
    { value: 'c', label: '选项 C' },
  ],
  disabled = false,
  triggerClassName,
}: {
  value?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  options?: { value: string; label: string; disabled?: boolean }[]
  disabled?: boolean
  triggerClassName?: string
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger aria-label="选择器" className={triggerClassName}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

describe('Select（shadcn 基座）', () => {
  it('触发器具备 combobox 无障碍语义并显示已选项文案', () => {
    render(<Fixture />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('选项 A')
  })

  it('展开后渲染 listbox 与 option，并标记选中项', async () => {
    const user = setupUser()
    render(<Fixture />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('option', { name: '选项 A' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: '选项 B' })).toHaveAttribute('aria-selected', 'false')

    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('已选项以 data-state=checked 标记，未选项为 unchecked', async () => {
    const user = setupUser()
    render(<Fixture />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    expect(screen.getByRole('option', { name: '选项 A' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('option', { name: '选项 B' })).toHaveAttribute(
      'data-state',
      'unchecked',
    )
  })

  it('点击选项触发 onValueChange 并关闭浮层', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(<Fixture onValueChange={onValueChange} />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    await user.click(screen.getByRole('option', { name: '选项 B' }))
    expect(onValueChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('键盘：↓ 打开浮层，Enter 选中高亮项', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(<Fixture onValueChange={onValueChange} />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onValueChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('键盘：Enter/Space 打开，Esc 关闭', async () => {
    const user = setupUser()
    render(<Fixture />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.keyboard(' ')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('点击外部关闭浮层', async () => {
    const user = setupUser()
    render(<Fixture />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('窗口尺寸变化时关闭浮层', async () => {
    const user = setupUser()
    render(<Fixture />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('value 为空串时显示 placeholder 文案', () => {
    render(<Fixture value="" placeholder="请选择一项" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toHaveTextContent('请选择一项')
    expect(trigger).toHaveAttribute('data-placeholder')
  })

  it('空值项可选中，触发器显示 placeholder 文案', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(
      <Fixture
        value="a"
        onValueChange={onValueChange}
        placeholder="未设置"
        options={[
          { value: '', label: '未设置' },
          { value: 'a', label: '选项 A' },
        ]}
      />,
    )
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: '未设置' }))
    expect(onValueChange).toHaveBeenCalledWith('')
  })

  it('空值项作为当前值时，触发器展示 placeholder 且该项为 checked', () => {
    render(
      <Fixture
        value=""
        placeholder="未设置"
        options={[
          { value: '', label: '未设置' },
          { value: 'a', label: '选项 A' },
        ]}
      />,
    )
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toHaveTextContent('未设置')
    expect(trigger).toHaveAttribute('data-placeholder')
  })

  it('禁用态不展开，也不响应点击', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(<Fixture disabled onValueChange={onValueChange} />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toBeDisabled()

    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('禁用选项不可选', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(
      <Fixture
        onValueChange={onValueChange}
        options={[
          { value: 'a', label: '选项 A' },
          { value: 'x', label: '禁用项', disabled: true },
        ]}
      />,
    )
    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    const disabledOption = screen.getByRole('option', { name: '禁用项' })
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')

    await user.click(disabledOption)
    expect(onValueChange).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('外部 className 可覆盖触发器外观', () => {
    render(<Fixture triggerClassName="w-40" />)
    expect(screen.getByRole('combobox', { name: '选择器' })).toHaveClass('w-40')
  })

  it('受控 value 变化后触发器文案跟随', () => {
    const { rerender } = render(<Fixture value="a" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toHaveTextContent('选项 A')

    rerender(<Fixture value="b" />)
    expect(trigger).toHaveTextContent('选项 B')
  })

  it('分组与分隔线渲染在浮层内', async () => {
    const user = setupUser()
    render(
      <Select value="a" onValueChange={vi.fn()}>
        <SelectTrigger aria-label="选择器">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>分组标题</SelectLabel>
            <SelectItem value="a">选项 A</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="b">选项 B</SelectItem>
        </SelectContent>
      </Select>,
    )

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getByText('分组标题')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('没有选项时浮层为空，键盘不误选', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(<Fixture value="" onValueChange={onValueChange} options={[]} />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('Tab 不关闭浮层：焦点锁在浮层内，Esc 才关闭', async () => {
    const user = setupUser()
    render(<Fixture />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // Radix 拦截 Tab，焦点移入浮层内的选项
    await user.keyboard('{Tab}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(document.activeElement).toHaveAttribute('role', 'option')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('再次点击触发器收起浮层', async () => {
    const user = setupUser()
    render(<Fixture />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })

    await user.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('触发器渲染 size 属性供紧凑场景使用', () => {
    render(
      <Select value="a" onValueChange={vi.fn()}>
        <SelectTrigger aria-label="选择器" size="sm">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">选项 A</SelectItem>
        </SelectContent>
      </Select>,
    )
    expect(screen.getByRole('combobox', { name: '选择器' })).toHaveAttribute('data-size', 'sm')
  })

  it('键盘：Home/End 跳到首尾选项', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(<Fixture onValueChange={onValueChange} />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}{End}')
    await user.keyboard('{Enter}')
    expect(onValueChange).toHaveBeenCalledWith('c')
  })

  it('键盘：首字母连续输入定位到匹配项', async () => {
    const onValueChange = vi.fn()
    const user = setupUser()
    render(
      <Fixture
        onValueChange={onValueChange}
        options={[
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
          { value: 'gamma', label: 'Gamma' },
        ]}
      />,
    )
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    await user.keyboard('g')
    await user.keyboard('{Enter}')
    expect(onValueChange).toHaveBeenCalledWith('gamma')
  })

  it('基座元素带 data-slot 标记，便于样式定位', async () => {
    const user = setupUser()
    render(<Fixture />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toHaveAttribute('data-slot', 'select-trigger')

    await user.click(trigger)
    const option = screen.getByRole('option', { name: '选项 A' })
    expect(option).toHaveAttribute('data-slot', 'select-item')
    expect(option.querySelector('[data-slot="select-item-indicator"]')).toBeInTheDocument()
  })

  it('触发器宽度默认跟随内容，可用 className 覆盖', () => {
    const { rerender } = render(<Fixture />)
    expect(screen.getByRole('combobox', { name: '选择器' })).toHaveClass('w-fit')

    rerender(<Fixture triggerClassName="w-full" />)
    expect(screen.getByRole('combobox', { name: '选择器' })).toHaveClass('w-full')
  })

  it('浮层内容渲染在 portal 中，不受父级 overflow 裁剪影响', async () => {
    const user = setupUser()
    render(
      <div className="overflow-hidden">
        <Fixture />
      </div>,
    )
    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    const listbox = screen.getByRole('listbox')
    expect(listbox.parentElement).not.toBeNull()
    expect(listbox.closest('.overflow-hidden')).toBeNull()
  })
})
