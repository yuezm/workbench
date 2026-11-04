import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, ChatConversation, ChatMessage } from '../../../../../shared/ai-workflow-api'
import type { ChatStreamState } from '../hooks/useChat'
import { ChatPanel, type ChatPanelProps } from './ChatPanel'

const agent: Agent = {
  id: 'a1',
  name: '写作助手',
  description: '',
  runtimeId: 'r1',
  systemPrompt: '',
  createdAt: 't',
}

function conv(id: string, title: string, agentId = 'a1'): ChatConversation {
  return { id, title, agentId, sessionId: null, createdAt: 't', updatedAt: 't' }
}

function msg(
  id: string,
  conversationId: string,
  role: ChatMessage['role'],
  content: string,
  error: string | null = null,
): ChatMessage {
  return { id, conversationId, role, content, error, createdAt: 't' }
}

function stream(over: Partial<ChatStreamState> = {}): ChatStreamState {
  return { text: '', thinking: '', tools: [], ...over }
}

function makeProps(overrides: Partial<ChatPanelProps> = {}): ChatPanelProps {
  return {
    agents: [agent],
    conversation: conv('c1', '第一段对话'),
    messages: [],
    streaming: stream(),
    sending: false,
    error: null,
    onSend: vi.fn(async () => true),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('ChatPanel', () => {
  it('显示会话标题与智能体徽标，智能体缺失时回退文案', () => {
    const { rerender } = render(<ChatPanel {...makeProps()} />)

    expect(screen.getByRole('heading', { name: '第一段对话' })).toBeInTheDocument()
    expect(screen.getByText('写作助手')).toBeInTheDocument()

    rerender(<ChatPanel {...makeProps({ conversation: conv('c2', '无主会话', 'ghost') })} />)
    expect(screen.getByText('未知智能体')).toBeInTheDocument()
  })

  it('没有会话时显示空状态，输入框存在但发送禁用', async () => {
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ conversation: null })} />)

    expect(screen.getByText('还没有对话，点左侧「新对话」开始')).toBeInTheDocument()
    expect(screen.getByLabelText('消息')).toBeInTheDocument()

    await user.type(screen.getByLabelText('消息输入'), '有人吗')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('发送：空内容不发、Enter 发送且成功后清空、Shift+Enter 换行', async () => {
    const onSend = vi.fn(async () => true)
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ onSend })} />)

    const input = screen.getByLabelText('消息输入')
    await user.click(input)
    await user.keyboard('{Enter}')
    expect(onSend).not.toHaveBeenCalled()

    await user.type(input, '  你好呀  ')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('  你好呀  \n')

    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledWith('你好呀')
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('点击发送按钮提交 trim 后的内容', async () => {
    const onSend = vi.fn(async () => true)
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ onSend })} />)

    await user.type(screen.getByLabelText('消息输入'), '发出去')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(onSend).toHaveBeenCalledWith('发出去')
  })

  it('onSend 返回 false 时保留草稿', async () => {
    const onSend = vi.fn(async () => false)
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ onSend })} />)

    const input = screen.getByLabelText('消息输入')
    await user.type(input, '发不出去')
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledWith('发不出去')
    expect(input).toHaveValue('发不出去')
  })

  it('发送中显示「停止」并触发 onCancel，流式正文随增量显示', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<ChatPanel {...makeProps({ sending: true, onCancel })} />)

    expect(screen.getByText('正在输出…')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '停止' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()

    rerender(<ChatPanel {...makeProps({ sending: true, streaming: stream({ text: '你好' }) })} />)
    expect(screen.getByText('你好')).toBeInTheDocument()
    expect(screen.queryByText('正在输出…')).toBeNull()
  })

  it('流式 thinking 与工具事件以次要样式展示，工具内容过长会截断', () => {
    const longContent = `{"path":"${'a'.repeat(200)}"}`
    render(
      <ChatPanel
        {...makeProps({
          sending: true,
          streaming: stream({
            thinking: '正在思考',
            tools: [
              { tool: 'read', content: longContent, isError: false },
              { tool: 'grep', content: '短内容', isError: false },
              { tool: 'write', content: '', isError: true },
            ],
          }),
        })}
      />,
    )

    expect(screen.getByText('正在思考').className).toContain('italic')
    expect(screen.getByText(/read · \{"path":"a+…$/)).toBeInTheDocument()
    expect(screen.getByText('grep · 短内容')).toBeInTheDocument()
    const failed = screen.getByText('write')
    expect(failed.className).toContain('text-red-300')
  })

  it('渲染消息流与消息级错误文案', () => {
    render(
      <ChatPanel
        {...makeProps({
          messages: [
            msg('m1', 'c1', 'user', '问一句'),
            msg('m2', 'c1', 'assistant', '答一句', '退出码 1'),
          ],
        })}
      />,
    )

    expect(screen.getByText('问一句')).toBeInTheDocument()
    expect(screen.getByText('答一句')).toBeInTheDocument()
    expect(screen.getByText('退出码 1')).toBeInTheDocument()
  })

  it('错误条渲染在输入区上方', () => {
    render(<ChatPanel {...makeProps({ error: '发送失败' })} />)
    expect(screen.getByText('发送失败')).toBeInTheDocument()
  })
})
