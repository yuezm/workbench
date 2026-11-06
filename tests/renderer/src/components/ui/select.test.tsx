import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Select } from '../../../../../src/renderer/src/components/ui/select'

const options = [
  { value: 'a', label: '选项 A' },
  { value: 'b', label: '选项 B' },
  { value: 'c', label: '选项 C' },
]

describe('Select', () => {
  it('触发器具备 combobox 无障碍语义', () => {
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('选项 A')
  })

  it('展开后渲染 listbox 与 option，并标记选中项', async () => {
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox', { name: '选择器' })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('option', { name: '选项 A' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: '选项 B' })).toHaveAttribute('aria-selected', 'false')

    // 再点触发器收起
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('点击选项触发 onChange 并关闭浮层', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select value="a" onChange={onChange} options={options} ariaLabel="选择器" />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    await user.click(screen.getByRole('option', { name: '选项 B' }))
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('键盘：↓ 打开并移动高亮，Enter 选中', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select value="a" onChange={onChange} options={options} ariaLabel="选择器" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // 打开时高亮落在当前值上
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 A' }).id,
    )

    await user.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 B' }).id,
    )

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('键盘：↑ 从当前值往回移动，Home/End 跳到首尾', async () => {
    const user = userEvent.setup()
    render(<Select value="b" onChange={vi.fn()} options={options} ariaLabel="选择器" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 A' }).id,
    )

    await user.keyboard('{End}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 C' }).id,
    )

    await user.keyboard('{Home}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 A' }).id,
    )
  })

  it('键盘：Enter/Space 打开，Esc 关闭', async () => {
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)
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
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('窗口尺寸变化时关闭浮层', async () => {
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('值不匹配任何选项时显示占位文案', () => {
    render(
      <Select
        value="zzz"
        onChange={vi.fn()}
        options={options}
        ariaLabel="选择器"
        placeholder="请选择一项"
      />,
    )
    expect(screen.getByRole('combobox', { name: '选择器' })).toHaveTextContent('请选择一项')
  })

  it('禁用态不展开，也不响应键盘', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select value="a" onChange={onChange} options={options} ariaLabel="选择器" disabled />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    expect(trigger).toBeDisabled()

    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('禁用选项不可选', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Select
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: '选项 A' },
          { value: 'x', label: '禁用项', disabled: true },
        ]}
        ariaLabel="选择器"
      />,
    )
    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    const disabledOption = screen.getByRole('option', { name: '禁用项' })
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')

    await user.click(disabledOption)
    expect(onChange).not.toHaveBeenCalled()
    // 浮层保持打开
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('键盘导航跳过禁用选项', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Select
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: '选项 A' },
          { value: 'x', label: '禁用项', disabled: true },
          { value: 'c', label: '选项 C' },
        ]}
        ariaLabel="选择器"
      />,
    )
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 C' }).id,
    )
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('浮层使用 fixed 定位，避免被父级裁剪', async () => {
    const user = userEvent.setup()
    render(
      <div className="overflow-hidden">
        <Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />
      </div>,
    )
    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    expect(screen.getByRole('listbox')).toHaveStyle({ position: 'fixed' })
  })

  it('触发器暴露当前选中项的 value（与原生 select 语义一致）', () => {
    render(<Select value="b" onChange={vi.fn()} options={options} ariaLabel="选择器" />)
    expect(screen.getByRole('combobox', { name: '选择器' })).toHaveValue('b')
  })

  it('外部 className 可覆盖触发器外观', () => {
    render(
      <Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" className="w-40" />,
    )
    expect(screen.getByRole('combobox', { name: '选择器' })).toHaveClass('w-40')
  })

  it('值不匹配任何选项时打开，高亮落在首个可用项；↑ 打开则落在末项', async () => {
    const user = userEvent.setup()
    render(<Select value="zzz" onChange={vi.fn()} options={options} ariaLabel="选择器" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 A' }).id,
    )
    await user.keyboard('{Escape}')

    await user.keyboard('{ArrowUp}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 C' }).id,
    )
  })

  it('末项禁用时 End 落在最后一个可用项', async () => {
    const user = userEvent.setup()
    render(
      <Select
        value="a"
        onChange={vi.fn()}
        options={[
          { value: 'a', label: '选项 A' },
          { value: 'b', label: '选项 B' },
          { value: 'x', label: '禁用项', disabled: true },
        ]}
        ariaLabel="选择器"
      />,
    )
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()
    await user.keyboard('{ArrowDown}{End}')
    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: '选项 B' }).id,
    )
  })

  it('所有选项都禁用时没有高亮，键盘不会误选', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Select
        value=""
        onChange={onChange}
        options={[{ value: 'x', label: '禁用项', disabled: true }]}
        ariaLabel="选择器"
      />,
    )
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    expect(trigger).not.toHaveAttribute('aria-activedescendant')
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('没有选项时浮层为空，键盘不误选', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Select value="" onChange={onChange} options={[]} ariaLabel="选择器" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('空间不足时浮层改为向上弹出', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 740,
      left: 40,
      right: 240,
      width: 200,
      height: 40,
      x: 40,
      y: 700,
      toJSON: () => ({}),
    } as DOMRect)
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    // 下方空间不足（768 - 740 - 8 = 20px）→ 浮层上翻，并按内容高度贴合触发器
    expect(screen.getByRole('listbox')).toHaveStyle({
      position: 'fixed',
      top: '580px',
      left: '40px',
      width: '200px',
    })
    spy.mockRestore()
  })

  it('浮层有实际高度时按测量高度决定上翻位置与最大高度', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 740,
      left: 40,
      right: 240,
      width: 200,
      height: 40,
      x: 40,
      y: 700,
      toJSON: () => ({}),
    } as DOMRect)
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    // 下方仅 20px（768 - 740 - 8）、上方 692px：测量高度 200 > 下方空间 → 上翻 200px
    expect(screen.getByRole('listbox')).toHaveStyle({
      top: '492px',
      maxHeight: '320px',
      left: '40px',
      width: '200px',
    })
    rectSpy.mockRestore()
    heightSpy.mockRestore()
  })

  it('浮层最小宽度不小于 180px，避免窄触发器截断选项文字', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 40,
      right: 100,
      width: 60,
      height: 40,
      x: 40,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect)
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    expect(screen.getByRole('listbox')).toHaveStyle({ width: '180px' })
    spy.mockRestore()
  })

  it('点击浮层内部（而非选项）不关闭', async () => {
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)

    await user.click(screen.getByRole('combobox', { name: '选择器' }))
    await user.click(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('浮层打开期间选项全部禁用时不再高亮', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />,
    )
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')

    rerender(
      <Select
        value="a"
        onChange={vi.fn()}
        options={[
          { value: 'a', label: '选项 A', disabled: true },
          { value: 'b', label: '选项 B', disabled: true },
        ]}
        ariaLabel="选择器"
      />,
    )
    await user.keyboard('{ArrowDown}')
    expect(trigger).not.toHaveAttribute('aria-activedescendant')
  })

  it('Tab 关闭浮层；关闭状态下 Home/End/Esc 与普通键无副作用', async () => {
    const user = userEvent.setup()
    render(<Select value="a" onChange={vi.fn()} options={options} ariaLabel="选择器" />)
    const trigger = screen.getByRole('combobox', { name: '选择器' })
    trigger.focus()

    await user.keyboard('{Home}{End}{Escape}x{Tab}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
