import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation } from '../../../../../../src/protocol/entities'
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

function conv(id: string, title: string, agentId = 'a1'): Conversation {
  return { id, title, agentId, sessionId: null, createdAt: 't', updatedAt: 't' }
}

function makeProps(overrides: Partial<ConversationListProps> = {}): ConversationListProps {
  return {
    agents: [agent, researcher],
    agentId: null,
    onAgentChange: vi.fn(),
    conversations: [conv('c1', '第一段对话'), conv('c2', '第二段对话', 'ghost')],
    archived: [],
    activeId: 'c1',
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRemove: vi.fn(),
    onArchive: vi.fn(),
    creating: false,
    ...overrides,
  }
}

describe('ConversationList', () => {
  it('无智能体时提示配置，且「新对话」不可用', () => {
    render(<ConversationList {...makeProps({ agents: [], conversations: [] })} />)

    expect(screen.getByText('先配置智能体')).toBeInTheDocument()
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

  it('三点菜单：删除走菜单项，行内不再常驻删除图标', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(<ConversationList {...makeProps({ onRemove })} />)

    // 删除收进菜单：点开之前没有可用的删除项
    expect(screen.queryByRole('menuitem', { name: '删除' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '会话 第二段对话 更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(onRemove).toHaveBeenCalledWith('c2')
    // 点过之后菜单收起
    expect(screen.queryByRole('menuitem', { name: '删除' })).toBeNull()
  })

  it('三点菜单：归档走菜单项，Esc 收起菜单', async () => {
    const onArchive = vi.fn()
    const user = userEvent.setup()
    render(<ConversationList {...makeProps({ onArchive })} />)

    await user.click(screen.getByRole('button', { name: '会话 第一段对话 更多操作' }))
    expect(screen.getByRole('menu')).toHaveAttribute('aria-label', '会话 第一段对话 操作')
    await user.click(screen.getByRole('menuitem', { name: '归档' }))
    expect(onArchive).toHaveBeenCalledWith('c1', true)

    // Esc 收起菜单（不触发任何回调）
    await user.click(screen.getByRole('button', { name: '会话 第一段对话 更多操作' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()

    // 再点一次三点入口也能收起
    await user.click(screen.getByRole('button', { name: '会话 第一段对话 更多操作' }))
    await user.click(screen.getByRole('button', { name: '会话 第一段对话 更多操作' }))
    expect(screen.queryByRole('menu')).toBeNull()

    // 点页面别处收起
    await user.click(screen.getByRole('button', { name: '会话 第一段对话 更多操作' }))
    await user.click(screen.getByRole('button', { name: '新对话' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('已归档分组：默认收起，展开后可恢复或删除', async () => {
    const onArchive = vi.fn()
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(
      <ConversationList
        {...makeProps({ onArchive, onRemove, archived: [conv('c9', '旧对话')] })}
      />,
    )

    const toggle = screen.getByRole('button', { name: /已归档/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '恢复会话 旧对话' })).toBeNull()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: '恢复会话 旧对话' }))
    expect(onArchive).toHaveBeenCalledWith('c9', false)

    await user.click(screen.getByRole('button', { name: '删除会话 旧对话' }))
    expect(onRemove).toHaveBeenCalledWith('c9')
  })

  it('没有会话时列表为空，仍显示智能体选择与新建入口', () => {
    render(<ConversationList {...makeProps({ conversations: [], activeId: null })} />)

    expect(screen.getByRole('combobox', { name: '选择智能体' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新对话' })).toBeEnabled()
    expect(screen.queryByRole('button', { current: 'page' })).toBeNull()
  })
})
