// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  normalizeModelId,
  parseModelId,
  stripModelDisplaySuffix,
} from '../../src/protocol/model-id'

describe('protocol/model-id', () => {
  it('stripModelDisplaySuffix：只剥末尾一组方括号，其它位置原样', () => {
    expect(stripModelDisplaySuffix('deepseek-v4.1-flash[1m]')).toBe('deepseek-v4.1-flash')
    expect(stripModelDisplaySuffix('  MiniMax-M3.1-Flash-Preview[1m]  ')).toBe(
      'MiniMax-M3.1-Flash-Preview',
    )
    // 括号内为空不算显示后缀；中间的方括号不动
    expect(stripModelDisplaySuffix('model[]')).toBe('model[]')
    expect(stripModelDisplaySuffix('a[1m]/b[2k]')).toBe('a[1m]/b')
    expect(stripModelDisplaySuffix('')).toBe('')
  })

  it('parseModelId：剥后缀 + 解 %2F，两侧空白不合法', () => {
    expect(parseModelId('magpie/auto%2Fdeepseek-v4.1-flash')).toEqual({
      provider: 'magpie',
      id: 'auto/deepseek-v4.1-flash',
    })
    expect(parseModelId('minimax-code/MiniMax-M3.1-Flash-Preview[1m]')).toEqual({
      provider: 'minimax-code',
      id: 'MiniMax-M3.1-Flash-Preview',
    })
    expect(parseModelId('magpie/model[1m]')).toEqual({ provider: 'magpie', id: 'model' })
    // provider 侧的后缀同样剥掉（选择器把标注写在整串末尾时只会落在 id，这里防御两侧）
    expect(parseModelId('magpie[1m]/model')).toEqual({ provider: 'magpie', id: 'model' })
    expect(parseModelId('%20/a')).toBeNull()
    expect(parseModelId('a/%20')).toBeNull()
    expect(parseModelId('/model')).toBeNull()
    expect(parseModelId('provider/')).toBeNull()
  })

  it('normalizeModelId：provider/id 形态；解码后 id 为空 / 格式不对给 null', () => {
    expect(normalizeModelId('magpie/auto%2Fdeepseek-v4.1-flash[1m]')).toBe(
      'magpie/auto/deepseek-v4.1-flash',
    )
    expect(normalizeModelId('  magpie/glm-5.3  ')).toBe('magpie/glm-5.3')
    expect(normalizeModelId('magpie/[1m]')).toBeNull()
    expect(normalizeModelId('nomodel')).toBeNull()
    expect(normalizeModelId('')).toBeNull()
  })
})
