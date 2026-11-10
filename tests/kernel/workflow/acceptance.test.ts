import { describe, expect, it } from 'vitest'
import { ACCEPTANCE_LIMITS } from '../../../src/protocol/entities'
import { normalizeAcceptance, sameAcceptance } from '../../../src/kernel/workflow/acceptance'

/**
 * 验收条目归一（M20）：trim → 丢空 → 去重 → 逐条截断 → 整体截断。
 *
 * 归一是**确定性**的：同一输入同一结果，所以可以进提示词、进事实 payload、进投影 JSON。
 * 越界不报错（写长了是文案问题），只截断——拒绝保存会让「多写一句」变成无法提交。
 */
describe('kernel/workflow/acceptance normalizeAcceptance', () => {
  it('去首尾空白、丢空条目，保持出现顺序', () => {
    expect(normalizeAcceptance(['  pnpm check 退出码 0  ', '', '   ', '不改 schema'])).toEqual([
      'pnpm check 退出码 0',
      '不改 schema',
    ])
  })

  it('缺省 / null / 空数组都归一成空数组', () => {
    expect(normalizeAcceptance(undefined)).toEqual([])
    expect(normalizeAcceptance(null)).toEqual([])
    expect(normalizeAcceptance([])).toEqual([])
  })

  it('重复条目按归一后的文本去重（先后出现的保留先者）', () => {
    expect(normalizeAcceptance(['  a ', 'a', 'b', ' b'])).toEqual(['a', 'b'])
  })

  it('单条超长按码点截断到上限，不切坏代理对', () => {
    const long = '😀'.repeat(ACCEPTANCE_LIMITS.maxChars + 10)
    const [item] = normalizeAcceptance([long])
    expect(Array.from(item)).toHaveLength(ACCEPTANCE_LIMITS.maxChars)
  })

  it('条目数超上限时截断到上限', () => {
    const many = Array.from({ length: ACCEPTANCE_LIMITS.maxItems + 5 }, (_, i) => `第 ${i} 条`)
    expect(normalizeAcceptance(many)).toHaveLength(ACCEPTANCE_LIMITS.maxItems)
  })

  it('同一输入重复归一结果全等（可重放）', () => {
    const input = ['  x  ', 'y', 'x']
    expect(normalizeAcceptance(input)).toEqual(normalizeAcceptance(input))
  })
})

describe('kernel/workflow/acceptance sameAcceptance', () => {
  it('缺省与空数组视为同值', () => {
    expect(sameAcceptance(undefined, [])).toBe(true)
    expect(sameAcceptance(null, undefined)).toBe(true)
    expect(sameAcceptance(['a'], undefined)).toBe(false)
  })

  it('顺序与文本都敏感：改一个字或换顺序都算变', () => {
    expect(sameAcceptance(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameAcceptance(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(sameAcceptance(['a', 'b'], ['b', 'a'])).toBe(false)
  })
})
