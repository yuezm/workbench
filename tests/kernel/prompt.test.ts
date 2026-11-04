/**
 * 提示词拼装黄金用例（T14a/T12b）：`titleFromContent` 的边界与 `chatPrompt` 的逐字段文案。
 * 文案逐字沿用旧 `main/ai-workflow/chat.ts` 的 `buildChatPrompt` / `titleFromContent`。
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Message } from '../../src/protocol/entities'
import { chatPrompt, titleFromContent } from '../../src/kernel/prompt'

const CREATED = '2026-01-01T00:00:00.000Z'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '助手',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '你是助手。',
  createdAt: CREATED,
  ...over,
})

const message = (over: Partial<Message> = {}): Message => ({
  id: 'ms-1',
  conversationId: 'cv-1',
  role: 'user',
  content: '早',
  error: null,
  createdAt: CREATED,
  ...over,
})

describe('kernel/prompt titleFromContent', () => {
  it('空串 / 纯空白 / 只有换行：返回「新对话」', () => {
    expect(titleFromContent('')).toBe('新对话')
    expect(titleFromContent('   ')).toBe('新对话')
    expect(titleFromContent('\n第二行')).toBe('新对话')
    expect(titleFromContent(' \t\r\n ')).toBe('新对话')
  })

  it('取首行并去首尾空白；不超过 24 码点时原样返回', () => {
    expect(titleFromContent('  帮我看看  ')).toBe('帮我看看')
    expect(titleFromContent('第一行\n第二行')).toBe('第一行')
    expect(titleFromContent('一二三四五六七八九十一二三四五六七八九十一二三四')).toBe(
      '一二三四五六七八九十一二三四五六七八九十一二三四',
    )
  })

  it('超过 24 码点：截断并加省略号', () => {
    const twentyFive = '一二三四五六七八九十一二三四五六七八九十一二三四五'
    expect(Array.from(twentyFive)).toHaveLength(25)
    expect(titleFromContent(twentyFive)).toBe(Array.from(twentyFive).slice(0, 24).join('') + '…')
  })

  it('emoji 按码点截断，不把代理对切成半个字符', () => {
    const emoji = '😀'.repeat(25)
    expect(Array.from(titleFromContent(emoji))).toHaveLength(25) // 24 个 emoji + 省略号
    expect(titleFromContent(emoji)).toBe('😀'.repeat(24) + '…')
  })
})

describe('kernel/prompt chatPrompt', () => {
  it('systemPrompt 非空：能力段 + # 对话记录 + 结尾提示（段间两空行）', () => {
    expect(chatPrompt(agent(), [message()])).toBe(
      '你是助手。\n\n# 对话记录\n\n用户：早\n\n请回答最后一条用户消息。',
    )
  })

  it('systemPrompt 空白：省略能力段', () => {
    expect(chatPrompt(agent({ systemPrompt: '   ' }), [message()])).toBe(
      '# 对话记录\n\n用户：早\n\n请回答最后一条用户消息。',
    )
  })

  it('历史多行：按角色逐行拼（用户 / 助手）', () => {
    const prompt = chatPrompt(agent(), [
      message({ id: 'ms-1', role: 'user', content: '早', createdAt: CREATED }),
      message({
        id: 'ms-2',
        role: 'assistant',
        content: '早呀\n今天做什么？',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      message({ id: 'ms-3', role: 'user', content: '继续' }),
    ])

    expect(prompt).toBe(
      '你是助手。\n\n# 对话记录\n\n用户：早\n助手：早呀\n今天做什么？\n用户：继续\n\n请回答最后一条用户消息。',
    )
  })
})
