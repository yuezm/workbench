import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENTITY_ORDER_STORAGE_KEYS,
  getEntityOrder,
  moveInEntityOrder,
  moveInEntityOrderTo,
  parseEntityOrder,
  resetEntityOrderForTest,
  setEntityOrder,
  sortByEntityOrder,
  subscribeEntityOrder,
  useEntityOrder,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/entity-order'

/**
 * 实体显示顺序（智能体 / 工作流）。
 *
 * 这些用例守的是「顺序只影响显示」这条口径：纯函数怎么排、脏存储怎么挡、
 * 上移 / 下移的边界，以及 hook 把两行清单交给同一个 store 后侧栏与设置页看到同一份顺序。
 */

interface Item {
  id: string
}

const item = (id: string): Item => ({ id })

beforeEach(() => {
  window.localStorage.clear()
  resetEntityOrderForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetEntityOrderForTest()
})

describe('parseEntityOrder（读本地顺序时挡脏数据）', () => {
  it('没有存储 / 坏 JSON / 不是数组都当「没存过」', () => {
    expect(parseEntityOrder(null)).toEqual([])
    expect(parseEntityOrder('{')).toEqual([])
    expect(parseEntityOrder('{"a":1}')).toEqual([])
    expect(parseEntityOrder('"a1"')).toEqual([])
  })

  it('逐项丢弃非法与重复项，只留非空字符串 id', () => {
    expect(parseEntityOrder('["a1",1,null,"","a1","a2"]')).toEqual(['a1', 'a2'])
    expect(parseEntityOrder('[]')).toEqual([])
  })
})

describe('sortByEntityOrder（命中顺序在前，未登记的原次序追加）', () => {
  it('空顺序原样返回（顺序与视图一致），且不复用入参数组', () => {
    const items = [item('a'), item('b')]
    const sorted = sortByEntityOrder(items, [])
    expect(sorted.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(sorted).not.toBe(items)
  })

  it('按存的顺序重排；没登记过的按原次序追加在后', () => {
    const items = [item('a'), item('b'), item('c'), item('d')]
    expect(sortByEntityOrder(items, ['c', 'a']).map((entry) => entry.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ])
  })

  it('顺序里残留已删实体的 id 时自然忽略', () => {
    const items = [item('a'), item('b')]
    expect(sortByEntityOrder(items, ['ghost', 'b']).map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})

describe('moveInEntityOrderTo（拖动落点：占位不是交换）', () => {
  it('往前 / 往后拖都落在目标行当前的下标上', () => {
    expect(moveInEntityOrderTo(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveInEntityOrderTo(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('拖到自己 / 任一端不在清单里时原样返回副本', () => {
    const ids = ['a', 'b']
    expect(moveInEntityOrderTo(ids, 'a', 'a')).toEqual(['a', 'b'])
    expect(moveInEntityOrderTo(ids, 'ghost', 'a')).toEqual(['a', 'b'])
    expect(moveInEntityOrderTo(ids, 'a', 'ghost')).toEqual(['a', 'b'])
    expect(moveInEntityOrderTo(ids, 'a', 'a')).not.toBe(ids)
  })
})

describe('moveInEntityOrder（抓手上的 ↑ / ↓）', () => {
  it('上下移动一格', () => {
    expect(moveInEntityOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveInEntityOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('越界 / id 不在清单里时原样返回副本', () => {
    expect(moveInEntityOrder(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(moveInEntityOrder(['a', 'b'], 'b', 1)).toEqual(['a', 'b'])
    expect(moveInEntityOrder(['a', 'b'], 'ghost', -1)).toEqual(['a', 'b'])
    const ids = ['a', 'b']
    expect(moveInEntityOrder(ids, 'a', -1)).not.toBe(ids)
  })

  it('单条清单无法移动', () => {
    expect(moveInEntityOrder(['a'], 'a', 1)).toEqual(['a'])
  })
})

describe('顺序 store（渲染层偏好，落 localStorage）', () => {
  it('写入即落盘并通知订阅者', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeEntityOrder(listener)

    setEntityOrder('workflow', ['w2', 'w1'])

    expect(getEntityOrder('workflow')).toEqual(['w2', 'w1'])
    expect(window.localStorage.getItem(ENTITY_ORDER_STORAGE_KEYS.workflow)).toBe('["w2","w1"]')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setEntityOrder('workflow', ['w1'])
    expect(listener).toHaveBeenCalledTimes(1)
    // 两个 kind 各存各的：改工作流不动智能体顺序
    expect(getEntityOrder('agent')).toEqual([])
  })

  it('模块加载时从本地存储恢复顺序', async () => {
    window.localStorage.setItem(ENTITY_ORDER_STORAGE_KEYS.agent, '["a2","a1"]')
    vi.resetModules()
    const fresh =
      await import('../../../../../../src/renderer/src/apps/ai-workflow/model/entity-order')
    expect(fresh.getEntityOrder('agent')).toEqual(['a2', 'a1'])
    expect(fresh.getEntityOrder('workflow')).toEqual([])
  })

  it('写失败（配额 / 隐私模式）不报错，内存态仍然生效', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => setEntityOrder('agent', ['a2'])).not.toThrow()
    expect(getEntityOrder('agent')).toEqual(['a2'])
  })

  it('读失败按「没存过」回落', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied')
    })
    vi.resetModules()
    const fresh =
      await import('../../../../../../src/renderer/src/apps/ai-workflow/model/entity-order')
    expect(fresh.getEntityOrder('agent')).toEqual([])
    expect(fresh.getEntityOrder('workflow')).toEqual([])
  })
})

describe('useEntityOrder（清单 + 拖动 / 键盘两档排序入口）', () => {
  it('按存的顺序渲染，move 落盘后清单与订阅方一起变', () => {
    const { result } = renderHook(() => useEntityOrder('agent', [item('a'), item('b'), item('c')]))
    expect(result.current.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])

    act(() => {
      result.current.move('c', -1)
    })
    expect(result.current.items.map((entry) => entry.id)).toEqual(['a', 'c', 'b'])
    expect(getEntityOrder('agent')).toEqual(['a', 'c', 'b'])

    // 越界移动：顺序不变（首条再上移）
    act(() => {
      result.current.move('a', -1)
    })
    expect(getEntityOrder('agent')).toEqual(['a', 'c', 'b'])
  })

  it('moveTo 是拖动落点：把拖拽源挪到落点行当前的下标', () => {
    const { result } = renderHook(() => useEntityOrder('agent', [item('a'), item('b'), item('c')]))

    act(() => {
      result.current.moveTo('a', 'c')
    })
    expect(result.current.items.map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
    expect(getEntityOrder('agent')).toEqual(['b', 'c', 'a'])
  })

  it('新建实体（顺序里没有）落在末尾', () => {
    setEntityOrder('workflow', ['w2'])
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useEntityOrder('workflow', ids.map(item)),
      { initialProps: { ids: ['w1', 'w2'] } },
    )
    expect(result.current.items.map((entry) => entry.id)).toEqual(['w2', 'w1'])

    rerender({ ids: ['w1', 'w2', 'w3'] })
    expect(result.current.items.map((entry) => entry.id)).toEqual(['w2', 'w1', 'w3'])
  })
})
