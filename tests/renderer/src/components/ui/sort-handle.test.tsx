import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SortHandle } from '../../../../../src/renderer/src/components/ui/sort-handle'

/**
 * 拖拽抓手：拖拽本身不可键盘操作，抓手上的 ↑ / ↓ 是排序的键盘路径（SPEC-ui §10 可操作性）。
 * 这里守两件事：按键命中时才 preventDefault；没传到头的方向（首行上移 / 末行下移）不响应。
 */
describe('SortHandle', () => {
  it('渲染成不提交表单的按钮，带无障碍名与操作提示', () => {
    render(<SortHandle label="拖动排序：智能体 coder" onMoveUp={() => {}} onMoveDown={() => {}} />)
    const handle = screen.getByRole('button', { name: '拖动排序：智能体 coder' })
    expect(handle).toHaveAttribute('type', 'button')
    expect(handle).toHaveAttribute('title', '拖动调整顺序（聚焦后按 ↑ / ↓ 也能移动）')
  })

  it('↑ / ↓ 各自回调一次，并拦掉默认滚动', () => {
    const up = vi.fn()
    const down = vi.fn()
    render(<SortHandle label="抓手" onMoveUp={up} onMoveDown={down} />)
    const handle = screen.getByRole('button', { name: '抓手' })

    expect(fireEvent.keyDown(handle, { key: 'ArrowUp' })).toBe(false)
    expect(up).toHaveBeenCalledTimes(1)
    expect(down).not.toHaveBeenCalled()

    expect(fireEvent.keyDown(handle, { key: 'ArrowDown' })).toBe(false)
    expect(down).toHaveBeenCalledTimes(1)
    expect(up).toHaveBeenCalledTimes(1)
  })

  it('到头的那一端没有回调：按键不响应，也不吞默认行为', () => {
    const up = vi.fn()
    const down = vi.fn()

    // 末行：↓ 已经没有了（只剩 ↑）
    const first = render(<SortHandle label="抓手" onMoveUp={up} />)
    expect(
      fireEvent.keyDown(screen.getByRole('button', { name: '抓手' }), { key: 'ArrowDown' }),
    ).toBe(true)
    expect(down).not.toHaveBeenCalled()
    first.unmount()

    // 首行：↑ 已经没有了（只剩 ↓）
    render(<SortHandle label="抓手" onMoveDown={down} />)
    expect(
      fireEvent.keyDown(screen.getByRole('button', { name: '抓手' }), { key: 'ArrowUp' }),
    ).toBe(true)
    expect(up).not.toHaveBeenCalled()
  })

  it('别的键不理会', () => {
    const up = vi.fn()
    const down = vi.fn()
    render(<SortHandle label="抓手" onMoveUp={up} onMoveDown={down} />)

    expect(fireEvent.keyDown(screen.getByRole('button', { name: '抓手' }), { key: 'Enter' })).toBe(
      true,
    )
    expect(up).not.toHaveBeenCalled()
    expect(down).not.toHaveBeenCalled()
  })
})
