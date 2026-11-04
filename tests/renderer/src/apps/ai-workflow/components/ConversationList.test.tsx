import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, ChatConversation } from '../../../../../../src/shared/ai-workflow-api'
import {
  ConversationList,
  type ConversationListProps,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/ConversationList'

const agent: Agent = {
  id: 'a1',
  name: '写作助手',
  description: '',
  runtimeId: 'r1',
  systemPrompt: '',
  createdAt: 't',
}
const researcher: Agent = { ...agent, id: 'a2', name: '研究员' }

function conv(id: string, title: string, agentId = 'a1'): ChatConversation {
  return { id, title, agentId, sessionId: null, createdAt: 't', updatedAt: 't' }
}

function makeProps(overrides: Partial<ConversationListProps> = {}): ConversationListProps {
  return {
    agents: [agent, researcher],
    agentId: null,
    onAgentChange: vi.fn(),
    conversations: [conv('c1', '第一段对话'), conv('c2', '第二段对话', 'ghost')],
    activeId: 'c1',
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRemove: vi.fn(),
    creating: false,
    ...overrides,
  }
}

describe('ConversationList', () => {
  it('无智能体时提示配置，且「新对话」不可用', () => {
    render(<ConversationList {...makeProps({ agents: [], conversations: [] })} />)

    expect(screen.getByText('先到设置里配置智能体')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '选择智能体' })).toBeNull()
    expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled()
  })

  it('列出智能体并回调选择结果，默认显示第一个', async () => {
    const onAgentChange = vi.fn()
    const user = userEvent.setup()
    render(<ConversationList {...makeProps({ onAgentChange })} />)

    const select = screen.getByRole('combobox', { name: '选择智能体' })
    expect(select).toHaveTextContent('写作助手')

    await user.click(select)
    await user.click(screen.getByRole('option', { name: '研究员' }))
    expect(onAgentChange).toHaveBeenCalledWith('a2')
  })

  it('显式选中的智能体优先于第一个', () => {
    render(<ConversationList {...makeProps({ agentId: 'a2' })} />)

    expect(screen.getByRole('combobox', { name: '选择智能体' })).toHaveTextContent('研究员')
  })

  it('「新对话」可点击；creating 时禁用', async () => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<ConversationList {...makeProps({ onCreate })} />)

    await user.click(screen.getByRole('button', { name: '新对话' }))
    expect(onCreate).toHaveBeenCalledTimes(1)

    rerender(<ConversationList {...makeProps({ onCreate, creating: true })} />)
    expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled()
  })

  it('会话列表：当前项标记 aria-current，点击回调选中；智能体缺失时回退文案', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<ConversationList {...makeProps({ onSelect })} />)

    expect(screen.getByRole('button', { current: 'page' })).toHaveTextContent('第一段对话')
    expect(screen.getByRole('button', { name: /^第二段对话/ })).not.toHaveAttribute('aria-current')
    expect(screen.getByText('未知智能体')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^第二段对话/ }))
    expect(onSelect).toHaveBeenCalledWith('c2')
  })

  it('删除按钮带标题化 aria-label，点击回调对应会话 id', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(<ConversationList {...makeProps({ onRemove })} />)

    const remove = screen.getByRole('button', { name: '删除对话 第二段对话' })
    await user.click(remove)
    expect(onRemove).toHaveBeenCalledWith('c2')
  })

  it('没有会话时列表为空，仍显示智能体选择与新建入口', () => {
    render(<ConversationList {...makeProps({ conversations: [], activeId: null })} />)

    expect(screen.getByRole('combobox', { name: '选择智能体' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新对话' })).toBeEnabled()
    expect(screen.queryByRole('button', { current: 'page' })).toBeNull()
  })
})
