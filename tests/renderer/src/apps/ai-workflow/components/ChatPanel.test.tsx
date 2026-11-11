import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Card, Conversation, Message } from '../../../../../../src/protocol/entities'
import type { ChatStreamState } from '../../../../../../src/renderer/src/apps/ai-workflow/hooks/useChat'
import {
  ChatPanel,
  type ChatPanelProps,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/ChatPanel'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

const agent: Agent = {
  id: 'a1',
  name: '写作助手',
  description: '',
  runtimeId: 'r1',
  systemPrompt: '',
  createdAt: 't',
}

function conv(id: string, title: string, agentId = 'a1'): Conversation {
  return {
    id,
    title,
    agentId,
    projectId: null,
    sessionId: null,
    createdAt: 't',
    updatedAt: 't',
  }
}

function msg(
  id: string,
  conversationId: string,
  role: Message['role'],
  content: string,
  error: string | null = null,
): Message {
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

  it('头部交代所属项目（聊天与任务共用顶层上下文）', () => {
    const { rerender } = render(<ChatPanel {...makeProps({ projectName: '工作台' })} />)
    expect(screen.getByLabelText('所属项目')).toHaveTextContent('工作台')

    rerender(<ChatPanel {...makeProps({ projectName: '默认目录' })} />)
    expect(screen.getByLabelText('所属项目')).toHaveTextContent('默认目录')
  })

  it('未传项目名时不渲染项目徽标', () => {
    render(<ChatPanel {...makeProps()} />)
    expect(screen.queryByLabelText('所属项目')).not.toBeInTheDocument()
  })

  it('没有会话时显示空状态，输入框存在但发送禁用', async () => {
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ conversation: null })} />)

    expect(screen.getByText('点左侧「新对话」开始')).toBeInTheDocument()
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
    // 空内容按 Enter 不能「什么都不发生」：给一句话说明为什么没发出去
    expect(screen.getByText('先输入内容再发送')).toBeInTheDocument()

    await user.type(input, '  你好呀  ')
    expect(screen.queryByText('先输入内容再发送')).toBeNull()
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('  你好呀  \n')

    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledWith('你好呀')
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('发送时父级抛错：就地说明原因并保留草稿', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('桥接断开')
    })
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ onSend })} />)

    const input = screen.getByLabelText('消息输入')
    await user.type(input, '发不出去')
    await user.keyboard('{Enter}')

    expect(await screen.findByText('发送失败：桥接断开')).toBeInTheDocument()
    expect(input).toHaveValue('发不出去')
  })

  it('发送失败为非 Error 值时按字符串展示', async () => {
    // 桥接可能抛出非 Error 值：错误文案统一转成字符串
    const onSend = vi.fn(() => Promise.reject('桥接断了'))
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ onSend })} />)

    const input = screen.getByLabelText('消息输入')
    await user.type(input, '发不出去')
    await user.keyboard('{Enter}')

    expect(await screen.findByText('发送失败：桥接断了')).toBeInTheDocument()
    expect(input).toHaveValue('发不出去')
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
    // 失败色走语义 token，不用调色板外的 red-300
    expect(failed.className).toContain('text-destructive')
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
    expect(screen.getByRole('alert')).toHaveTextContent('发送失败')
  })
})

describe('ChatPanel 会话内待处理卡', () => {
  const card: Card = {
    id: 'card-c',
    runId: 'run-c',
    taskId: null,
    conversationId: 'c1',
    title: '要继续吗',
    text: '上一轮停在方案选择',
    kind: 'ask',
    options: ['继续', '重来'],
    key: null,
    version: 1,
    status: 'open',
    delivery: 'delivered',
    deliveryRef: 'in-app',
    optionIndex: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: 't',
    updatedAt: 't',
  }

  let kernel: FakeKernel

  beforeEach(() => {
    kernel = installFakeKernel()
  })

  it('本会话的卡展示在消息流上方：正文与选项都在会话内', () => {
    render(<ChatPanel {...makeProps({ cards: [card] })} />)

    const cards = screen.getByRole('region', { name: '待处理卡' })
    expect(cards).toHaveTextContent('要继续吗')
    expect(cards).toHaveTextContent('上一轮停在方案选择')
    expect(screen.getByRole('radio', { name: '继续' })).toBeInTheDocument()
  })

  it('选中再提交：dispatch card.answer，卡片留在会话里等事实刷新', async () => {
    const user = userEvent.setup()
    render(<ChatPanel {...makeProps({ cards: [card] })} />)

    await user.click(screen.getByRole('radio', { name: '重来' }))
    await user.click(screen.getByRole('button', { name: '提交所选' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({
          type: 'card.answer',
          cardId: 'card-c',
          optionIndex: 1,
          via: 'ui',
        }),
      ),
    )
    expect(screen.getByText('要继续吗')).toBeInTheDocument()
  })

  it('点系统通知进来：focusCardId 透传，会话内那张卡被标成定位态', () => {
    render(<ChatPanel {...makeProps({ cards: [card], focusCardId: 'card-c' })} />)

    const anchor = screen.getByText('要继续吗').closest('[data-card-id]')
    expect(anchor).toHaveAttribute('data-card-id', 'card-c')
    expect(anchor).toHaveAttribute('data-focused', 'true')
  })

  it('没有卡时会话内不占版面', () => {
    render(<ChatPanel {...makeProps()} />)
    expect(screen.queryByRole('region', { name: '待处理卡' })).toBeNull()
  })
})
