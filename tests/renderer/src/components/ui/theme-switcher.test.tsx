import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ThemeSwitcher } from '../../../../../src/renderer/src/components/ui/theme-switcher'
import { resetThemeForTest, useTheme } from '../../../../../src/renderer/src/lib/theme'

/** 探针：把当前偏好显示出来，便于断言主题确实生效 */
function PreferenceProbe(): React.ReactElement {
  const { preference } = useTheme()
  return <span data-testid="preference">{preference}</span>
}

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    // 每个用例之间清干净：偏好回到「跟随系统」，订阅者清空
    resetThemeForTest()
  })

  it('默认显示「主题：跟随系统」触发器，浮层未打开', () => {
    render(<ThemeSwitcher />)
    expect(screen.getByRole('button', { name: '主题：跟随系统' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '主题' })).not.toBeInTheDocument()
  })

  it('hover 触发器弹出浮层：三个图标按钮可见，当前项 aria-pressed', async () => {
    const user = userEvent.setup()
    render(<ThemeSwitcher />)

    await user.hover(screen.getByRole('button', { name: '主题：跟随系统' }))
    const panel = await screen.findByRole('group', { name: '主题' })
    expect(panel).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '亮色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '暗色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跟随系统' })).toBeInTheDocument()
    // 当前偏好是「跟随系统」：只有它按下
    expect(screen.getByRole('button', { name: '跟随系统' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '亮色' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '暗色' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('点「亮色」立即生效并收起浮层，触发器文案跟着变', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ThemeSwitcher />
        <PreferenceProbe />
      </>,
    )

    await user.hover(screen.getByRole('button', { name: '主题：跟随系统' }))
    await user.click(screen.getByRole('button', { name: '亮色' }))

    expect(screen.getByTestId('preference')).toHaveTextContent('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    // 触发器图标与文案跟着当前偏好走
    expect(screen.getByRole('button', { name: '主题：亮色' })).toBeInTheDocument()
    // 选完即收起
    expect(screen.queryByRole('group', { name: '主题' })).not.toBeInTheDocument()
  })

  it('点「暗色」生效：偏好与 html 类名都切到暗色', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ThemeSwitcher />
        <PreferenceProbe />
      </>,
    )

    await user.hover(screen.getByRole('button', { name: '主题：跟随系统' }))
    await user.click(screen.getByRole('button', { name: '暗色' }))

    expect(screen.getByTestId('preference')).toHaveTextContent('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(screen.getByRole('button', { name: '主题：暗色' })).toBeInTheDocument()
  })

  it('点触发器能开也能关（键盘可达的开关）', () => {
    render(<ThemeSwitcher />)
    const trigger = screen.getByRole('button', { name: '主题：跟随系统' })

    fireEvent.click(trigger)
    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.queryByRole('group', { name: '主题' })).not.toBeInTheDocument()
  })

  it('Esc 关闭浮层，其他按键不关', async () => {
    const user = userEvent.setup()
    render(<ThemeSwitcher />)

    await user.hover(screen.getByRole('button', { name: '主题：跟随系统' }))
    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()

    await user.keyboard('{Tab}')
    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: '主题' })).not.toBeInTheDocument(),
    )
  })

  it('移出触发器后延迟关闭（约 150ms）', async () => {
    const user = userEvent.setup()
    render(<ThemeSwitcher />)
    const trigger = screen.getByRole('button', { name: '主题：跟随系统' })

    await user.hover(trigger)
    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()

    // 移出：先有延迟，浮层不会瞬间消失
    fireEvent.mouseLeave(trigger)
    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: '主题' })).not.toBeInTheDocument(),
    )
  })

  it('移入浮层本身不关闭（从触发器移到浮层的途中）', async () => {
    const user = userEvent.setup()
    render(<ThemeSwitcher />)

    await user.hover(screen.getByRole('button', { name: '主题：跟随系统' }))
    await user.hover(screen.getByRole('button', { name: '暗色' }))
    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()
  })
})
