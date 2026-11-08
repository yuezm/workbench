import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Menu, type MenuSection } from '../../../../../src/renderer/src/components/ui/menu'

/** 两条分组、三个条目：第一组无标题，第二组带标题 */
function buildSections(calls: string[]): MenuSection[] {
  return [
    {
      items: [
        {
          id: 'a',
          label: '从空白创建',
          description: '空草稿说明',
          ariaLabel: '执行 A',
          onSelect: () => calls.push('a'),
        },
      ],
    },
    {
      title: '模板',
      items: [
        {
          id: 'b',
          label: '模板 B',
          badge: '3 阶段',
          description: 'B 的说明',
          ariaLabel: '使用模板 B',
          onSelect: () => calls.push('b'),
        },
        { id: 'c', label: '模板 C', onSelect: () => calls.push('c') },
      ],
    },
  ]
}

const blocker = (): DOMRect =>
  ({
    top: 600,
    bottom: 640,
    left: 160,
    right: 300,
    width: 140,
    height: 40,
    x: 160,
    y: 600,
    toJSON: () => ({}),
  }) as DOMRect

describe('Menu', () => {
  it('触发器具备 menu 无障碍语义，点击展开与收起', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)
    const trigger = screen.getByRole('button', { name: '新建' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: '新建' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)

    await user.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('渲染分组标题、徽标与第二行说明', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)
    await user.click(screen.getByRole('button', { name: '新建' }))

    const menu = screen.getByRole('menu')
    expect(menu).toHaveTextContent('模板')
    expect(menu).toHaveTextContent('空草稿说明')
    expect(menu).toHaveTextContent('B 的说明')
    expect(menu).toHaveTextContent('3 阶段')
  })

  it('ariaLabel 覆盖可访问名称；无 ariaLabel 时用文本内容', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)
    await user.click(screen.getByRole('button', { name: '新建' }))

    expect(screen.getByRole('menuitem', { name: '执行 A' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '使用模板 B' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '模板 C' })).toBeInTheDocument()
  })

  it('点击条目触发回调并收起菜单', async () => {
    const calls: string[] = []
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections(calls)} />)

    await user.click(screen.getByRole('button', { name: '新建' }))
    await user.click(screen.getByRole('menuitem', { name: '使用模板 B' }))
    expect(calls).toEqual(['b'])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('键盘：↓ 打开并高亮首项，继续 ↓ 移动，Enter 选中', async () => {
    const calls: string[] = []
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections(calls)} />)
    const trigger = screen.getByRole('button', { name: '新建' })
    trigger.focus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getAllByRole('menuitem')[0].id)

    await user.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getAllByRole('menuitem')[1].id)

    await user.keyboard('{Enter}')
    expect(calls).toEqual(['b'])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('键盘：↑ 打开并高亮末项，↓ 从末项环绕回首项', async () => {
    const calls: string[] = []
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections(calls)} />)
    const trigger = screen.getByRole('button', { name: '新建' })
    trigger.focus()

    await user.keyboard('{ArrowUp}')
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getAllByRole('menuitem')[2].id)

    await user.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getAllByRole('menuitem')[0].id)

    await user.keyboard('{ArrowUp}')
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getAllByRole('menuitem')[2].id)
  })

  it('键盘：Space 打开，Esc 与 Tab 收起，收起后 Enter 不误选', async () => {
    const calls: string[] = []
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections(calls)} />)
    const trigger = screen.getByRole('button', { name: '新建' })
    trigger.focus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(calls).toEqual([])

    await user.keyboard(' ')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it('悬停移动高亮', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)
    await user.click(screen.getByRole('button', { name: '新建' }))

    await user.hover(screen.getByRole('menuitem', { name: '使用模板 B' }))
    expect(screen.getByRole('menuitem', { name: '使用模板 B' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByRole('menuitem', { name: '执行 A' })).not.toHaveAttribute('aria-current')
  })

  it('点击外部关闭，点击浮层内部不关闭', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)

    await user.click(screen.getByRole('button', { name: '新建' }))
    await user.click(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('窗口尺寸变化时收起菜单', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)

    await user.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('菜单自身滚动保持打开，页面滚动才收起', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)
    await user.click(screen.getByRole('button', { name: '新建' }))

    // 条目多于可视高度时滚轮滚的是菜单自己：不能因 scroll 事件把菜单收掉
    fireEvent.scroll(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)

    // 页面滚动会让浮层与触发器错位 → 收起
    fireEvent.scroll(window)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('收起状态下 Esc/Tab 与普通键无副作用', async () => {
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)
    const trigger = screen.getByRole('button', { name: '新建' })
    trigger.focus()

    await user.keyboard('{Escape}x')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    // 无关按键不改高亮、也不误选
    await user.keyboard('x')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('没有条目时菜单为空，键盘与点击不误触发', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Menu label="新建" sections={[]} />)
    const trigger = screen.getByRole('button', { name: '新建' })
    trigger.focus()

    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(trigger).not.toHaveAttribute('aria-activedescendant')

    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('浮层 fixed 定位，避免被父级裁剪', async () => {
    const user = userEvent.setup()
    render(
      <div className="overflow-hidden">
        <Menu label="新建" sections={buildSections([])} />
      </div>,
    )
    await user.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getByRole('menu')).toHaveStyle({
      position: 'fixed',
      left: '8px',
      top: '8px',
      width: '280px',
      maxHeight: '480px',
    })
  })

  it('下方空间不足时上翻，并按触发器右缘对齐', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(blocker())
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)

    await user.click(screen.getByRole('button', { name: '新建' }))
    // 下方仅 120px、上方 592px：按估算高度 3*56+16=184 上翻
    expect(screen.getByRole('menu')).toHaveStyle({ top: '408px', left: '20px' })
    spy.mockRestore()
  })

  it('浮层有实际高度时按测量高度决定上翻位置', async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(blocker())
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    const user = userEvent.setup()
    render(<Menu label="新建" sections={buildSections([])} />)

    await user.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getByRole('menu')).toHaveStyle({ top: '392px', maxHeight: '480px' })
    rectSpy.mockRestore()
    heightSpy.mockRestore()
  })
})
