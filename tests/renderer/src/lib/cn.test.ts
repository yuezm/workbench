import { describe, expect, it } from 'vitest'
import { cn } from '../../../../src/renderer/src/lib/cn'

describe('cn（shadcn 同款类名合并）', () => {
  it('拼接多个类名', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c')
  })

  it('忽略 falsy 输入，支持条件类', () => {
    const enabled = Math.sign(1) > 0
    const disabled = Math.sign(-1) > 0
    expect(cn('base', disabled && 'hidden', undefined, null, '', 'extra')).toBe('base extra')
    expect(cn('base', enabled && 'on')).toBe('base on')
  })

  it('同组冲突类后者胜出（tailwind-merge 语义）', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('text-sm', 'h-10', 'text-lg')).toBe('h-10 text-lg')
  })

  it('非冲突类全部保留', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })

  it('字阶与文字颜色分属两组，互不吃掉', () => {
    // text-body / text-meta 这类语义字号不能被 tailwind-merge 当成颜色类删除
    expect(cn('text-body', 'text-ink')).toBe('text-body text-ink')
    expect(cn('text-meta text-ink-faint', 'text-ink-dim')).toBe('text-meta text-ink-dim')
    // 同组字号仍然后者胜出
    expect(cn('text-body', 'text-title')).toBe('text-title')
  })

  it('支持数组与对象语法', () => {
    expect(cn(['a', { b: true, c: false }])).toBe('a b')
  })

  it('无有效输入返回空串', () => {
    expect(cn()).toBe('')
    expect(cn(false, undefined)).toBe('')
  })
})
