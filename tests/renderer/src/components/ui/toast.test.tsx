import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, toast, ToastHost } from '../../../../../src/renderer/src/components/ui/toast'

/**
 * 轻提示：一句成功文案浮一下就走，不占版面、不用人关。
 *
 * 计时用假时钟——真实 2.4 秒会让用例白等；`ToastHost` 的卸载清空由 RTL 的
 * 自动 cleanup 兜住（每个用例渲染自己的宿主，提示不跨用例残留）。
 */
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Toast：轻提示', () => {
  it('弹一条成功提示：status 语义 + polite 播报，2.4 秒后自己消失', () => {
    render(<ToastHost />)
    act(() => {
      toast('已保存 1 条连接')
    })

    const row = screen.getByRole('status')
    expect(row.textContent).toContain('已保存 1 条连接')
    // 读屏的语气在容器上：成功不是 alert，不打断用户正在听的内容
    expect(row.closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite')

    act(() => {
      vi.advanceTimersByTime(2399)
    })
    expect(screen.queryByRole('status')).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('空白文案不弹：没有可告知的事', () => {
    render(<ToastHost />)
    act(() => {
      toast('   ')
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('多条依次排队；收掉一条不动另一条，未知 id 不报错', () => {
    render(<ToastHost />)
    const ids: number[] = []
    act(() => {
      ids.push(toast('A'))
    })
    act(() => {
      ids.push(toast('B'))
    })
    expect(screen.getAllByRole('status')).toHaveLength(2)

    act(() => {
      dismissToast(ids[0] ?? 0)
    })
    const rest = screen.getAllByRole('status')
    expect(rest).toHaveLength(1)
    expect(rest[0]?.textContent).toContain('B')

    act(() => {
      dismissToast(9999)
    })
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('语气只换图标着色：成功走 success，知会走 info', () => {
    const view = render(<ToastHost />)
    const ids: number[] = []
    act(() => {
      ids.push(toast('已保存 1 条连接'))
    })
    expect(view.container.querySelector('.text-success')).not.toBeNull()
    expect(view.container.querySelector('.text-info')).toBeNull()

    act(() => {
      dismissToast(ids[0] ?? 0)
    })
    act(() => {
      toast('已同步', 'info')
    })
    expect(view.container.querySelector('.text-info')).not.toBeNull()
    expect(view.container.querySelector('.text-success')).toBeNull()
  })

  it('宿主卸载即清空：上一棵树的提示不带进下一棵', () => {
    const first = render(<ToastHost />)
    act(() => {
      toast('旧提示')
    })
    first.unmount()

    render(<ToastHost />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('空队列上卸载：什么都不做，也不留下空壳容器', () => {
    const view = render(<ToastHost />)
    view.unmount()
    expect(document.querySelector('[aria-live]')).toBeNull()
  })
})
