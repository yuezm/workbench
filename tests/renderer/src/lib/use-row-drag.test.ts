import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useRowDrag } from '../../../../src/renderer/src/lib/use-row-drag'

/**
 * 行内拖拽排序的共享状态机（智能体 / 工作流 / 工作流阶段的清单共用）。
 *
 * 这些用例只盯「什么时候算一次落点」：整行既是拖拽源也是落点，落点是「占位」而不是交换；
 * 没有拖拽源、拖到自己身上、离开的是别的行时的行为都在这里钉住——
 * 组件用例只验证接线，规则在这里一次说清。
 */

/** 拖拽事件只需要 preventDefault：其余字段（dataTransfer）本实现不碰 */
const dragEvent = (): { preventDefault: ReturnType<typeof vi.fn> } => ({ preventDefault: vi.fn() })
type DragEventStub = Parameters<
  ReturnType<ReturnType<typeof useRowDrag>['rowProps']>['onDragOver']
>[0]
const asEvent = (stub: ReturnType<typeof dragEvent>): DragEventStub =>
  stub as unknown as DragEventStub

describe('useRowDrag', () => {
  it('拖到另一行并松手：只提交一次 (from, to)，状态清空', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useRowDrag(commit))
    const over = dragEvent()

    act(() => result.current.rowProps('a').onDragStart())
    expect(result.current.draggingId).toBe('a')

    act(() => result.current.rowProps('c').onDragOver(asEvent(over)))
    expect(over.preventDefault).toHaveBeenCalledTimes(1)
    expect(result.current.overId).toBe('c')

    const drop = dragEvent()
    act(() => result.current.rowProps('c').onDrop(asEvent(drop)))
    expect(drop.preventDefault).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('a', 'c')
    expect(result.current.draggingId).toBeNull()
    expect(result.current.overId).toBeNull()
  })

  it('没有拖拽源（别的窗口 / 文件拖进来）：不接落点、不高亮、不提交', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useRowDrag(commit))
    const over = dragEvent()

    act(() => result.current.rowProps('c').onDragOver(asEvent(over)))
    expect(over.preventDefault).not.toHaveBeenCalled()
    expect(result.current.overId).toBeNull()

    act(() => result.current.rowProps('c').onDrop(asEvent(dragEvent())))
    expect(commit).not.toHaveBeenCalled()
  })

  it('悬停 / 松手在自己身上：既不提示落点，也不提交', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useRowDrag(commit))
    const over = dragEvent()

    act(() => result.current.rowProps('a').onDragStart())
    act(() => result.current.rowProps('a').onDragOver(asEvent(over)))
    expect(over.preventDefault).not.toHaveBeenCalled()
    expect(result.current.overId).toBeNull()

    act(() => result.current.rowProps('a').onDrop(asEvent(dragEvent())))
    expect(commit).not.toHaveBeenCalled()
    // 松手后照样收尾，不会把源行一直挂成半透明
    expect(result.current.draggingId).toBeNull()
  })

  it('dragLeave 只清自己那条高亮：离开别的行不动落点', () => {
    const { result } = renderHook(() => useRowDrag(() => {}))

    act(() => result.current.rowProps('a').onDragStart())
    act(() => result.current.rowProps('c').onDragOver(asEvent(dragEvent())))
    expect(result.current.overId).toBe('c')

    act(() => result.current.rowProps('b').onDragLeave())
    expect(result.current.overId).toBe('c')

    act(() => result.current.rowProps('c').onDragLeave())
    expect(result.current.overId).toBeNull()
  })

  it('重新按下就清掉上一轮的落点；dragEnd 收尾', () => {
    const { result } = renderHook(() => useRowDrag(() => {}))

    act(() => result.current.rowProps('a').onDragStart())
    act(() => result.current.rowProps('c').onDragOver(asEvent(dragEvent())))
    expect(result.current.overId).toBe('c')

    act(() => result.current.rowProps('b').onDragStart())
    expect(result.current.draggingId).toBe('b')
    expect(result.current.overId).toBeNull()

    act(() => result.current.rowProps('b').onDragEnd())
    expect(result.current.draggingId).toBeNull()
  })
})
