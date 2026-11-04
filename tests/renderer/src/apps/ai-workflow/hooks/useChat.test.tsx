import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Agent,
  AiWorkflowApi,
  ChatConversation,
  ChatMessage,
  ChatStreamEvent,
  RunEvent,
} from '../../../../../../src/shared/ai-workflow-api'
import { useChat } from '../../../../../../src/renderer/src/apps/ai-workflow/hooks/useChat'

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

function msg(
  id: string,
  conversationId: string,
  role: ChatMessage['role'],
  content: string,
  error: string | null = null,
): ChatMessage {
  return { id, conversationId, role, content, error, createdAt: 't' }
}

const c1 = conv('c1', '第一段对话')
const c2 = conv('c2', '第二段对话')
const c3 = conv('c3', '第三段对话')

/** 手动控制 resolve / reject 的 promise，用于验证过期响应 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** hook 订阅的流事件回调（mount 后由 onEvent 捕获） */
let emit: ((event: ChatStreamEvent) => void) | null = null
/** onEvent 返回的退订函数 */
let off: ReturnType<typeof vi.fn<() => void>>

interface ChatMocks {
  listConversations: ReturnType<typeof vi.fn>
  createConversation: ReturnType<typeof vi.fn>
  removeConversation: ReturnType<typeof vi.fn>
  listMessages: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

function makeChat(overrides: Partial<ChatMocks> = {}): ChatMocks {
  return {
    listConversations: vi.fn(async () => []),
    createConversation: vi.fn(async () => c1),
    removeConversation: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => []),
    send: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onEvent: vi.fn((cb: (event: ChatStreamEvent) => void): (() => void) => {
      emit = cb
      return off
    }),
    ...overrides,
  }
}

function mount(chat: ChatMocks, agents: Agent[] = [agent, researcher]) {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = {
    chat,
  } as unknown as Partial<AiWorkflowApi>
  return renderHook(() => useChat(agents))
}

/** 构造一条流事件（conversationId 缺省为当前会话 c1） */
function streamEvent(event: RunEvent, conversationId = 'c1'): ChatStreamEvent {
  return { conversationId, type: 'event', event }
}

beforeEach(() => {
  vi.clearAllMocks()
  emit = null
  off = vi.fn<() => void>()
})

describe('useChat', () => {
  it('挂载拉会话并选中第一条，随选中项拉消息', async () => {
    const chat = makeChat({
      listConversations: vi.fn(async () => [c2, c1]),
      listMessages: vi.fn(async (id: string) => [msg(`m-${id}`, id, 'user', `${id} 的消息`)]),
    })
    const { result } = mount(chat)

    await waitFor(() => expect(result.current.conversations).toHaveLength(2))
    expect(result.current.activeId).toBe('c2')
    expect(result.current.active?.title).toBe('第二段对话')
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c2 的消息'))
    expect(chat.listMessages).toHaveBeenCalledWith('c2')
    expect(result.current.error).toBeNull()
  })

  it('「新对话」用选中智能体创建并选中新会话', async () => {
    const created = conv('c9', '新会话')
    let list = [c1]
    const chat = makeChat({
      listConversations: vi.fn(async () => list),
      createConversation: vi.fn(async () => {
        list = [created, c1]
        return created
      }),
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))
    // 未显式选择时跟随第一个智能体
    expect(result.current.selectedAgentId).toBe('a1')

    await act(async () => {
      await result.current.createConversation()
    })
    expect(chat.createConversation).toHaveBeenCalledWith('a1')
    expect(result.current.activeId).toBe('c9')
    expect(result.current.active?.title).toBe('新会话')
    expect(result.current.conversations).toHaveLength(2)
    expect(chat.listConversations).toHaveBeenCalledTimes(2)
    expect(result.current.creating).toBe(false)
  })

  it('切换智能体后「新对话」使用新选的智能体', async () => {
    const chat = makeChat()
    const { result } = mount(chat)

    act(() => result.current.setAgentId('a2'))
    expect(result.current.agentId).toBe('a2')
    expect(result.current.selectedAgentId).toBe('a2')

    await act(async () => {
      await result.current.createConversation()
    })
    expect(chat.createConversation).toHaveBeenCalledWith('a2')
  })

  it('发送：空内容或无会话都不发；成功后重拉消息并返回 true', async () => {
    let msgs: ChatMessage[] = [msg('m1', 'c1', 'assistant', '在的')]
    const chat = makeChat({
      listConversations: vi.fn(async () => [c1]),
      listMessages: vi.fn(async () => msgs),
      send: vi.fn(async (id: string, content: string) => {
        msgs = [...msgs, msg('m2', id, 'user', content)]
      }),
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    await act(async () => {
      expect(await result.current.sendMessage('   ')).toBe(false)
    })
    expect(chat.send).not.toHaveBeenCalled()

    let ok = false
    await act(async () => {
      ok = await result.current.sendMessage('  你好呀  ')
    })
    expect(ok).toBe(true)
    expect(chat.send).toHaveBeenCalledWith('c1', '你好呀')
    expect(result.current.sending).toBe(true)
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('在的'))
    expect(chat.listMessages).toHaveBeenCalledTimes(2)
  })

  it('没有会话时发送直接返回 false', async () => {
    const chat = makeChat()
    const { result } = mount(chat)
    await waitFor(() => expect(chat.listConversations).toHaveBeenCalled())

    let ok = true
    await act(async () => {
      ok = await result.current.sendMessage('有人吗')
    })
    expect(ok).toBe(false)
    expect(chat.send).not.toHaveBeenCalled()
    expect(result.current.sending).toBe(false)
  })

  it('text 事件流式追加；end 后重拉消息并清掉流式与发送中', async () => {
    let msgs: ChatMessage[] = [msg('m1', 'c1', 'user', '问一句')]
    const chat = makeChat({
      listConversations: vi.fn(async () => [c1]),
      listMessages: vi.fn(async () => msgs),
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.sendMessage('讲个笑话')
    })
    expect(result.current.sending).toBe(true)
    expect(result.current.streaming).toEqual({ text: '', thinking: '', tools: [] })

    await act(async () => {
      emit?.(streamEvent({ seq: 1, type: 'text', text: '你' }))
    })
    await act(async () => {
      emit?.(streamEvent({ seq: 2, type: 'text', text: '好' }))
    })
    expect(result.current.streaming.text).toBe('你好')

    // 没有正文的 text 事件不改变已累积文本
    await act(async () => {
      emit?.(streamEvent({ seq: 3, type: 'text' }))
    })
    expect(result.current.streaming.text).toBe('你好')

    msgs = [...msgs, msg('m2', 'c1', 'assistant', '你好', '退出码 1')]
    await act(async () => {
      emit?.({ conversationId: 'c1', type: 'end' })
    })
    expect(result.current.streaming).toEqual({ text: '', thinking: '', tools: [] })
    expect(result.current.sending).toBe(false)
    await waitFor(() => expect(result.current.messages[1]?.error).toBe('退出码 1'))
    expect(chat.listMessages).toHaveBeenCalledTimes(3)
  })

  it('thinking 事件累积到次要输出，status 事件与缺失 event 的事件被忽略', async () => {
    const chat = makeChat({ listConversations: vi.fn(async () => [c1]) })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      emit?.(streamEvent({ seq: 1, type: 'thinking', text: '想' }))
    })
    await act(async () => {
      emit?.(streamEvent({ seq: 2, type: 'thinking', text: '一下' }))
    })
    expect(result.current.streaming.thinking).toBe('想一下')

    await act(async () => {
      emit?.(streamEvent({ seq: 3, type: 'status', status: 'running' }))
      emit?.({ conversationId: 'c1', type: 'event' })
    })
    expect(result.current.streaming).toEqual({ text: '', thinking: '想一下', tools: [] })
  })

  it('tool_call / tool_result 事件进入工具区，缺字段有兜底', async () => {
    const chat = makeChat({ listConversations: vi.fn(async () => [c1]) })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      emit?.(streamEvent({ seq: 1, type: 'tool_call', tool: 'read', input: '{"p":1}' }))
    })
    await act(async () => {
      emit?.(streamEvent({ seq: 2, type: 'tool_result', tool: 'read', output: 'ok' }))
    })
    await act(async () => {
      emit?.(streamEvent({ seq: 3, type: 'tool_result', isError: true }))
    })

    expect(result.current.streaming.tools).toEqual([
      { tool: 'read', content: '{"p":1}', isError: false },
      { tool: 'read', content: 'ok', isError: false },
      { tool: '未知工具', content: '', isError: true },
    ])
  })

  it('tool_call 缺字段时用兜底工具名与空内容，thinking 缺文本不追加', async () => {
    const chat = makeChat({ listConversations: vi.fn(async () => [c1]) })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      emit?.(streamEvent({ seq: 1, type: 'thinking' }))
      emit?.(streamEvent({ seq: 2, type: 'tool_call' }))
    })

    expect(result.current.streaming.thinking).toBe('')
    expect(result.current.streaming.tools).toEqual([
      { tool: '未知工具', content: '', isError: false },
    ])
  })

  it('切换会话后忽略旧会话事件，过期请求不写入', async () => {
    const fresh = deferred<ChatMessage[]>()
    const stale = deferred<ChatMessage[]>()
    let c1Calls = 0
    const listMessages = vi.fn((id: string) => {
      if (id !== 'c1') return Promise.resolve([msg('m-c3', 'c3', 'user', 'c3 的消息')])
      c1Calls += 1
      return c1Calls === 1 ? fresh.promise : stale.promise
    })
    const chat = makeChat({
      listConversations: vi.fn(async () => [c1, conv('c3', '第三段对话', 'ghost')]),
      listMessages,
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    act(() => result.current.selectConversation('c3'))
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c3 的消息'))
    expect(result.current.active?.id).toBe('c3')

    // 第一个会话的响应迟到：不写入当前界面
    await act(async () => {
      fresh.resolve([msg('m-old', 'c1', 'user', 'c1 的旧消息')])
      await fresh.promise
    })
    expect(result.current.messages.some((m) => m.content === 'c1 的旧消息')).toBe(false)
    expect(result.current.messages[0]?.content).toBe('c3 的消息')

    // 旧会话的增量与结束：不处理
    const calls = chat.listMessages.mock.calls.length
    await act(async () => {
      emit?.(streamEvent({ seq: 1, type: 'text', text: '旧会话增量' }, 'c1'))
      emit?.({ conversationId: 'c1', type: 'end' })
    })
    expect(result.current.streaming.text).toBe('')
    expect(chat.listMessages).toHaveBeenCalledTimes(calls)

    // 切回 c1 再切走：迟到的失败也不写入 error
    act(() => result.current.selectConversation('c1'))
    act(() => result.current.selectConversation('c3'))
    await act(async () => {
      stale.reject(new Error('过期失败'))
      await stale.promise.catch(() => undefined)
    })
    expect(result.current.error).toBeNull()
    expect(result.current.messages[0]?.content).toBe('c3 的消息')
  })

  it('删除会话：非当前会话不影响选中，当前会话被删后切下一条或清空', async () => {
    let list = [c1, c2, c3]
    const chat = makeChat({
      listConversations: vi.fn(async () => list),
      listMessages: vi.fn(async (id: string) => [msg(`m-${id}`, id, 'user', `${id} 的消息`)]),
      removeConversation: vi.fn(async (id: string) => {
        list = list.filter((item) => item.id !== id)
      }),
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c1 的消息'))

    // 删非当前会话
    await act(async () => {
      await result.current.removeConversation('c3')
    })
    expect(result.current.conversations.map((item) => item.id)).toEqual(['c1', 'c2'])
    expect(result.current.activeId).toBe('c1')

    // 删当前会话：切到剩余第一条
    await act(async () => {
      await result.current.removeConversation('c1')
    })
    expect(result.current.activeId).toBe('c2')
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c2 的消息'))

    // 再删当前会话：没有剩余 → 清空
    await act(async () => {
      await result.current.removeConversation('c2')
    })
    expect(result.current.activeId).toBeNull()
    expect(result.current.active).toBeNull()
    expect(result.current.messages).toEqual([])
    expect(result.current.conversations).toEqual([])
  })

  it('创建失败写入 error 并结束 creating', async () => {
    const chat = makeChat({
      createConversation: vi.fn(() => Promise.reject(new Error('创建失败'))),
    })
    const { result } = mount(chat)

    await act(async () => {
      await result.current.createConversation()
    })
    expect(result.current.error).toBe('创建失败')
    expect(result.current.creating).toBe(false)
  })

  it('会话列表加载失败写入 error，且没有选中会话', async () => {
    const chat = makeChat({ listConversations: vi.fn(() => Promise.reject('会话列表不可用')) })
    const { result } = mount(chat)

    await waitFor(() => expect(result.current.error).toBe('会话列表不可用'))
    expect(result.current.activeId).toBeNull()
  })

  it('消息加载失败写入 error', async () => {
    const chat = makeChat({
      listConversations: vi.fn(async () => [c1]),
      listMessages: vi.fn(() => Promise.reject(new Error('消息加载失败'))),
    })
    const { result } = mount(chat)

    await waitFor(() => expect(result.current.error).toBe('消息加载失败'))
  })

  it('发送失败写入 error、返回 false 并结束发送中', async () => {
    const chat = makeChat({
      listConversations: vi.fn(async () => [c1]),
      send: vi.fn(() => Promise.reject(new Error('发送失败'))),
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    let ok = true
    await act(async () => {
      ok = await result.current.sendMessage('在吗')
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe('发送失败')
    expect(result.current.sending).toBe(false)
  })

  it('删除失败写入 error，选中不变', async () => {
    const chat = makeChat({
      listConversations: vi.fn(async () => [c1]),
      removeConversation: vi.fn(() => Promise.reject(new Error('删除失败'))),
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.removeConversation('c1')
    })
    expect(result.current.error).toBe('删除失败')
    expect(result.current.activeId).toBe('c1')
  })

  it('中止：有会话时调用 cancel，失败写入 error；无会话时不调用', async () => {
    const chat = makeChat({
      listConversations: vi.fn(async () => [c1]),
      cancel: vi.fn(() => Promise.reject(new Error('取消失败'))),
    })
    const { result } = mount(chat)
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.cancelRun()
    })
    expect(chat.cancel).toHaveBeenCalledWith('c1')
    expect(result.current.error).toBe('取消失败')

    // 成功路径：下一次成功操作清掉错误
    chat.cancel.mockResolvedValueOnce(undefined)
    await act(async () => {
      await result.current.cancelRun()
    })
    expect(result.current.error).toBeNull()
    expect(chat.cancel).toHaveBeenCalledTimes(2)
  })

  it('没有会话时中止直接返回', async () => {
    const chat = makeChat()
    const { result } = mount(chat)
    await waitFor(() => expect(chat.listConversations).toHaveBeenCalled())

    await act(async () => {
      await result.current.cancelRun()
    })
    expect(chat.cancel).not.toHaveBeenCalled()
  })

  it('卸载时调用 onEvent 返回的退订函数', async () => {
    const chat = makeChat()
    const { unmount } = mount(chat)

    await waitFor(() => expect(chat.listConversations).toHaveBeenCalled())
    expect(chat.onEvent).toHaveBeenCalledTimes(1)
    expect(off).not.toHaveBeenCalled()

    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
