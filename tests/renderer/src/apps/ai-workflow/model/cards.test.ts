import { describe, expect, it } from 'vitest'
import type { Card } from '../../../../../../src/protocol/entities'
import {
  groupNotices,
  isFreeFormOption,
  isNoticeCard,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/cards'

const card: Card = {
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '包名怎么定',
  text: '',
  kind: 'ask',
  options: ['裸名'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
}

describe('isFreeFormOption：哪些选项要人自己写内容', () => {
  it('「其他 / 自定义 / 说点其他的」这类措辞命中', () => {
    for (const option of [
      '说点其他的',
      '其他（请说明）',
      '其它方案',
      '自定义',
      '我自己填',
      '自己写一个',
      '另说',
      '手动输入',
      'Something else',
    ]) {
      expect(isFreeFormOption(option), option).toBe(true)
    }
  })

  it('正常选项不命中：只是选一行就能回答的不该被要求写字', () => {
    for (const option of ['继续', '停止', '带前缀的 scope', 'Keep it', '先跑一遍测试']) {
      expect(isFreeFormOption(option), option).toBe(false)
    }
  })
})

describe('isNoticeCard / groupNotices', () => {
  it('kind 是唯一判据；缺 kind 的老数据按有无选项兜底', () => {
    expect(isNoticeCard({ ...card, kind: 'notice', options: [] })).toBe(true)
    expect(isNoticeCard({ ...card, kind: 'ask', options: [] })).toBe(false)

    const legacy = { ...card, options: [] } as { kind?: string }
    delete legacy.kind
    expect(isNoticeCard(legacy as never)).toBe(true)

    const legacyAsk = { ...card } as { kind?: string }
    delete legacyAsk.kind
    expect(isNoticeCard(legacyAsk as never)).toBe(false)
  })

  it('同落点 + 同标题 + 同正文合并，不同文案各占一组', () => {
    const groups = groupNotices([
      { ...card, kind: 'notice', options: [], id: 'a', text: '依赖已装' },
      { ...card, kind: 'notice', options: [], id: 'b', text: '依赖已装' },
      { ...card, kind: 'notice', options: [], id: 'c', text: '另一句' },
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ id: 'a' })
    expect(groups[0]?.cards.map((item) => item.id)).toEqual(['a', 'b'])
    expect(groups[1]?.cards.map((item) => item.id)).toEqual(['c'])
  })
})
