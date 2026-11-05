/**
 * 提示词拼装黄金用例（T14a/T12b/M4-T3）：`titleFromContent` 的边界、`chatPrompt` /
 * `taskPrompt` 的逐字段文案，以及回执块说明 / 回答续接 / later 复查提示词的确定性。
 * 文案逐字沿用旧 `main/ai-workflow/chat.ts` 的 `buildChatPrompt` / `titleFromContent`。
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Card, Message, Task } from '../../src/protocol/entities'
import {
  answerPrompt,
  chatPrompt,
  laterPrompt,
  receiptBlockHint,
  taskPrompt,
  titleFromContent,
} from '../../src/kernel/prompt'

const CREATED = '2026-01-01T00:00:00.000Z'
/** 阶段任务提示词与聊天首轮提示词末尾固定追加的回执块说明（M4 D4）。 */
const HINT = receiptBlockHint()

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

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '确认',
  text: '',
  options: ['好', '不好'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
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
  it('systemPrompt 非空：能力段 + # 对话记录 + 结尾提示 + 回执块说明（段间两空行）', () => {
    expect(chatPrompt(agent(), [message()])).toBe(
      `你是助手。\n\n# 对话记录\n\n用户：早\n\n请回答最后一条用户消息。\n\n${HINT}`,
    )
  })

  it('systemPrompt 空白：省略能力段', () => {
    expect(chatPrompt(agent({ systemPrompt: '   ' }), [message()])).toBe(
      `# 对话记录\n\n用户：早\n\n请回答最后一条用户消息。\n\n${HINT}`,
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
      `你是助手。\n\n# 对话记录\n\n用户：早\n助手：早呀\n今天做什么？\n用户：继续\n\n请回答最后一条用户消息。\n\n${HINT}`,
    )
  })
})

describe('kernel/prompt 回执块说明', () => {
  it('固定文本：五键与上限齐全，重复调用同文本', () => {
    const hint = receiptBlockHint()
    expect(hint).toBe(HINT)
    expect(hint).toContain('ask/notices/resolves/later/events')
    expect(hint).toContain('100')
    expect(hint).toContain('options 最多 20 项')
    expect(hint).toContain('summary ≤200')
    // 固定文案不随调用变化（同输入同文本）
    expect(receiptBlockHint()).toBe(hint)
    // 短文案：含标题与 JSON 示例在内不超过 6 行
    expect(hint.split('\n').length).toBeLessThanOrEqual(6)
  })

  it('taskPrompt 末尾追加回执块说明，空段过滤不受影响', () => {
    const task: Task = {
      id: 't-1',
      title: 'T',
      description: 'd',
      workflowId: 'wf-1',
      currentStageId: 'st-1',
      status: 'active',
      origin: 'manual',
      ruleId: null,
      externalRef: null,
      labels: [],
      createdAt: CREATED,
      updatedAt: CREATED,
    }
    expect(taskPrompt(agent({ systemPrompt: 'sys' }), task, null)).toBe(
      `sys\n\n# 任务：T\n\nd\n\n${HINT}`,
    )
  })
})

describe('kernel/prompt answerPrompt / laterPrompt', () => {
  it('answerPrompt：按 createdAt（同毫秒按 id）升序拼问答对，重复调用同文本', () => {
    const later = card({
      id: 'card-2',
      title: '第二条',
      options: ['A', 'B'],
      status: 'answered',
      optionIndex: 1,
      answeredBy: 'ui',
      answeredAt: '2026-01-01T00:00:02.000Z',
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    const earlier = card({
      id: 'card-1',
      title: '第一条',
      status: 'answered',
      optionIndex: 0,
      answeredBy: 'ui',
      answeredAt: '2026-01-01T00:00:01.000Z',
      createdAt: '2026-01-01T00:00:01.000Z',
    })

    const prompt = answerPrompt([later, earlier])
    expect(prompt).toBe(
      '# 卡片确认结果\n请基于以下人为你选定的答案继续本轮任务：\n- 第一条：好\n- 第二条：B',
    )
    expect(answerPrompt([earlier, later])).toBe(prompt)
    expect(answerPrompt([])).toBe('# 卡片确认结果\n请基于以下人为你选定的答案继续本轮任务：')

    // 同一 createdAt 按 id 兜底，顺序稳定
    const tied = [
      card({ id: 'card-b', title: 'B', status: 'answered', optionIndex: 0, answeredBy: 'ui' }),
      card({ id: 'card-a', title: 'A', status: 'answered', optionIndex: 0, answeredBy: 'ui' }),
    ]
    expect(answerPrompt(tied)).toBe(
      '# 卡片确认结果\n请基于以下人为你选定的答案继续本轮任务：\n- A：好\n- B：好',
    )
  })

  it('answerPrompt：未回答 / 下标失效的卡片显示占位文案', () => {
    expect(answerPrompt([card({ options: [] })])).toContain('- 确认：（未回答）')
    expect(
      answerPrompt([card({ status: 'answered', optionIndex: 9, answeredBy: 'ui' })]),
    ).toContain('- 确认：（未回答）')
  })

  it('laterPrompt：固定文案，重复调用同文本', () => {
    expect(laterPrompt()).toBe(
      '# 稍后复查\n上一轮回执要求稍后复查。请检查当前进展，需要时继续完成本任务；没有可做的事就直接结束本轮。',
    )
    expect(laterPrompt()).toBe(laterPrompt())
  })
})
