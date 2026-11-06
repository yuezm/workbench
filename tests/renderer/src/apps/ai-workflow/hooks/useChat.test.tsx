import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Agent,
  Conversation,
  Message,
  RunEvent,
} from '../../../../../../src/protocol/entities'
import type { Command } from '../../../../../../src/protocol/commands'
import type { CommandDispatchResult, KernelEvent } from '../../../../../../src/protocol/ipc'
import { useChat } from '../../../../../../src/renderer/src/apps/ai-workflow/hooks/useChat'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

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

function msg(
  id: string,
  conversationId: string,
  role: Message['role'],
  content: string,
  error: string | null = null,
): Message {
  return { id, conversationId, role, content, error, createdAt: 't' }
}

const c1 = conv('c1', '第一段对话')
const c2 = conv('c2', '第二段对话')
const c3 = conv('c3', '第三段对话')

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

function seedConversations(list: Conversation[]): void {
  kernel.setView('conversations.all', undefined, list)
}

function seedMessages(conversationId: string, list: Message[]): void {
  kernel.setView('messages.byConversation', { conversationId }, list)
}

function mount(agents: Agent[] = [agent, researcher]) {
  return renderHook(() => useChat(agents))
}

/** 构造一条聊天流事件（conversationId 缺省为当前会话 c1） */
function stream(event: RunEvent, conversationId = 'c1'): KernelEvent {
  return { kind: 'stream', runId: 'r1', conversationId, event }
}

function streamEnd(conversationId = 'c1'): KernelEvent {
  return { kind: 'stream-end', runId: 'r1', conversationId }
}

describe('useChat', () => {
  it('挂载选中第一条会话，随选中项取消息视图', async () => {
    seedConversations([c2, c1])
    seedMessages('c2', [msg('m-c2', 'c2', 'user', 'c2 的消息')])
    const { result } = mount()

    await waitFor(() => expect(result.current.conversations).toHaveLength(2))
    expect(result.current.activeId).toBe('c2')
    expect(result.current.active?.title).toBe('第二段对话')
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c2 的消息'))
    expect(result.current.error).toBeNull()
    expect(result.current.streaming).toEqual({ text: '', thinking: '', tools: [] })
  })

  it('「新对话」用选中智能体创建并选中新会话', async () => {
    seedConversations([c1])
    const created = conv('c9', '新会话')
    kernel.onDispatch(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'chat.create') {
        kernel.setView('conversations.all', undefined, [created, c1])
        return { facts: [], value: created } as unknown as CommandDispatchResult<C>
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))
    // 未显式选择时跟随第一个智能体
    expect(result.current.selectedAgentId).toBe('a1')

    await act(async () => {
      await result.current.createConversation()
    })
    expect(kernel.dispatched.find((command) => command.type === 'chat.create')).toMatchObject({
      agentId: 'a1',
    })
    await waitFor(() => expect(result.current.activeId).toBe('c9'))
    expect(result.current.active?.title).toBe('新会话')
    expect(result.current.conversations).toHaveLength(2)
    expect(result.current.creating).toBe(false)
  })

  it('切换智能体后「新对话」使用新选的智能体', async () => {
    seedConversations([])
    const { result } = mount()

    act(() => result.current.setAgentId('a2'))
    expect(result.current.agentId).toBe('a2')
    expect(result.current.selectedAgentId).toBe('a2')

    await act(async () => {
      await result.current.createConversation()
    })
    expect(kernel.dispatched.find((command) => command.type === 'chat.create')).toMatchObject({
      agentId: 'a2',
    })
  })

  it('发送：空内容或无会话都不发；成功后消息视图刷新并返回 true', async () => {
    const first = msg('m1', 'c1', 'assistant', '在的')
    seedConversations([c1])
    seedMessages('c1', [first])
    kernel.onDispatch((command) => {
      if (command.type === 'chat.send') {
        kernel.setView('messages.byConversation', { conversationId: 'c1' }, [
          first,
          msg('m2', 'c1', 'user', command.content),
        ])
      }
      return { facts: [], value: null }
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    await act(async () => {
      expect(await result.current.sendMessage('   ')).toBe(false)
    })
    expect(kernel.dispatched.some((command) => command.type === 'chat.send')).toBe(false)

    let ok = false
    await act(async () => {
      ok = await result.current.sendMessage('  你好呀  ')
    })
    expect(ok).toBe(true)
    expect(kernel.dispatched.find((command) => command.type === 'chat.send')).toMatchObject({
      conversationId: 'c1',
      content: '你好呀',
    })
    expect(result.current.sending).toBe(true)
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(result.current.messages[1]?.content).toBe('你好呀')
    expect(kernel.dispatched.filter((command) => command.type === 'chat.send')).toHaveLength(1)
  })

  it('没有会话时发送直接返回 false', async () => {
    seedConversations([])
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBeNull())

    let ok = true
    await act(async () => {
      ok = await result.current.sendMessage('有人吗')
    })
    expect(ok).toBe(false)
    expect(kernel.dispatched.some((command) => command.type === 'chat.send')).toBe(false)
    expect(result.current.sending).toBe(false)
    // 没有会话时不订阅消息视图：不产生参数错误，消息为空
    expect(result.current.error).toBeNull()
    expect(result.current.messages).toEqual([])
  })

  it('text 事件流式追加；stream-end 后消息视图刷新并清掉流式与发送中', async () => {
    const first = msg('m1', 'c1', 'user', '问一句')
    seedConversations([c1])
    seedMessages('c1', [first])
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.sendMessage('讲个笑话')
    })
    expect(result.current.sending).toBe(true)
    expect(result.current.streaming).toEqual({ text: '', thinking: '', tools: [] })
    expect(kernel.dispatched.some((command) => command.type === 'chat.send')).toBe(true)

    await act(async () => {
      kernel.pushStream(stream({ seq: 1, type: 'text', text: '你' }))
    })
    await act(async () => {
      kernel.pushStream(stream({ seq: 2, type: 'text', text: '好' }))
    })
    expect(result.current.streaming.text).toBe('你好')

    // 没有正文的 text 事件不改变已累积文本
    await act(async () => {
      kernel.pushStream(stream({ seq: 3, type: 'text' }))
    })
    expect(result.current.streaming.text).toBe('你好')

    // 消息落库：消息视图随 message.* 事实重取
    kernel.setView('messages.byConversation', { conversationId: 'c1' }, [
      first,
      msg('m2', 'c1', 'assistant', '你好', '退出码 1'),
    ])
    await act(async () => {
      kernel.pushStream(streamEnd())
    })
    expect(result.current.streaming).toEqual({ text: '', thinking: '', tools: [] })
    expect(result.current.sending).toBe(false)
    await waitFor(() => expect(result.current.messages[1]?.error).toBe('退出码 1'))
  })

  it('thinking 事件累积到次要输出，status 事件被忽略', async () => {
    seedConversations([c1])
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      kernel.pushStream(stream({ seq: 1, type: 'thinking', text: '想' }))
    })
    await act(async () => {
      kernel.pushStream(stream({ seq: 2, type: 'thinking', text: '一下' }))
    })
    expect(result.current.streaming.thinking).toBe('想一下')
    expect(result.current.streaming.text).toBe('')

    await act(async () => {
      kernel.pushStream(stream({ seq: 3, type: 'status', status: 'running' }))
    })
    expect(result.current.streaming).toEqual({ text: '', thinking: '想一下', tools: [] })
  })

  it('tool_call / tool_result 事件进入工具区，缺字段有兜底', async () => {
    seedConversations([c1])
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      kernel.pushStream(stream({ seq: 1, type: 'tool_call', tool: 'read', input: '{"p":1}' }))
    })
    await act(async () => {
      kernel.pushStream(stream({ seq: 2, type: 'tool_result', tool: 'read', output: 'ok' }))
    })
    await act(async () => {
      kernel.pushStream(stream({ seq: 3, type: 'tool_result', isError: true }))
    })

    expect(result.current.streaming.tools).toEqual([
      { tool: 'read', content: '{"p":1}', isError: false },
      { tool: 'read', content: 'ok', isError: false },
      { tool: '未知工具', content: '', isError: true },
    ])
    expect(result.current.streaming.tools).toHaveLength(3)
  })

  it('tool_call 缺字段时用兜底工具名与空内容，thinking 缺文本不追加', async () => {
    seedConversations([c1])
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      kernel.pushStream(stream({ seq: 1, type: 'thinking' }))
      kernel.pushStream(stream({ seq: 2, type: 'tool_call' }))
    })

    expect(result.current.streaming.thinking).toBe('')
    expect(result.current.streaming.tools).toEqual([
      { tool: '未知工具', content: '', isError: false },
    ])
  })

  it('切换会话后忽略旧会话事件，消息跟随新会话视图', async () => {
    seedConversations([c1, c3])
    seedMessages('c1', [msg('m1', 'c1', 'user', 'c1 的消息')])
    seedMessages('c3', [msg('m-c3', 'c3', 'user', 'c3 的消息')])
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c1 的消息'))

    act(() => result.current.selectConversation('c3'))
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c3 的消息'))
    expect(result.current.active?.id).toBe('c3')

    // 旧会话的增量与结束：不处理
    await act(async () => {
      kernel.pushStream(stream({ seq: 1, type: 'text', text: '旧会话增量' }, 'c1'))
      kernel.pushStream(streamEnd('c1'))
    })
    expect(result.current.streaming.text).toBe('')
    expect(result.current.messages[0]?.content).toBe('c3 的消息')
  })

  it('删除会话：非当前会话不影响选中，当前会话被删后切下一条或清空', async () => {
    seedConversations([c1, c2, c3])
    seedMessages('c1', [msg('m-c1', 'c1', 'user', 'c1 的消息')])
    seedMessages('c2', [msg('m-c2', 'c2', 'user', 'c2 的消息')])
    let list = [c1, c2, c3]
    kernel.onDispatch((command) => {
      if (command.type === 'chat.remove') {
        list = list.filter((item) => item.id !== command.conversationId)
        kernel.setView('conversations.all', undefined, list)
      }
      return { facts: [], value: null }
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c1 的消息'))

    // 删非当前会话
    await act(async () => {
      await result.current.removeConversation('c3')
    })
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual(['c1', 'c2']),
    )
    expect(result.current.activeId).toBe('c1')

    // 删当前会话：切到剩余第一条
    await act(async () => {
      await result.current.removeConversation('c1')
    })
    await waitFor(() => expect(result.current.activeId).toBe('c2'))
    await waitFor(() => expect(result.current.messages[0]?.content).toBe('c2 的消息'))

    // 再删当前会话：没有剩余 → 清空
    await act(async () => {
      await result.current.removeConversation('c2')
    })
    await waitFor(() => expect(result.current.activeId).toBeNull())
    expect(result.current.active).toBeNull()
    expect(result.current.messages).toEqual([])
    expect(result.current.conversations).toEqual([])
  })

  it('创建失败写入 error 并结束 creating', async () => {
    seedConversations([])
    kernel.onDispatch(() => Promise.reject(new Error('创建失败')))
    const { result } = mount()

    await act(async () => {
      await result.current.createConversation()
    })
    expect(result.current.error).toBe('创建失败')
    expect(result.current.creating).toBe(false)
  })

  it('删除失败为非 Error 时按字符串展示，选中不变', async () => {
    seedConversations([c1])
    kernel.onDispatch(() => Promise.reject('删除纯文本失败'))
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.removeConversation('c1')
    })
    expect(result.current.error).toBe('删除纯文本失败')
    expect(result.current.activeId).toBe('c1')
  })

  it('会话列表加载失败写入 error，且没有选中会话', async () => {
    kernel.failView('conversations.all', undefined, '会话列表不可用')
    const { result } = mount()

    await waitFor(() => expect(result.current.error).toBe('会话列表不可用'))
    expect(result.current.activeId).toBeNull()
    expect(result.current.conversations).toEqual([])
  })

  it('消息加载失败写入 error', async () => {
    seedConversations([c1])
    kernel.failView('messages.byConversation', { conversationId: 'c1' }, '消息加载失败')
    const { result } = mount()

    await waitFor(() => expect(result.current.error).toBe('消息加载失败'))
  })

  it('发送失败写入 error、返回 false 并结束发送中', async () => {
    seedConversations([c1])
    kernel.onDispatch(() => Promise.reject(new Error('发送失败')))
    const { result } = mount()
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
    seedConversations([c1])
    kernel.onDispatch(() => Promise.reject(new Error('删除失败')))
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.removeConversation('c1')
    })
    expect(result.current.error).toBe('删除失败')
    expect(result.current.activeId).toBe('c1')
  })

  it('中止：有会话时 dispatch chat.cancel，失败写入 error', async () => {
    seedConversations([c1])
    kernel.onDispatch(() => Promise.reject(new Error('取消失败')))
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.cancelRun()
    })
    expect(kernel.dispatched.find((command) => command.type === 'chat.cancel')).toMatchObject({
      conversationId: 'c1',
    })
    expect(result.current.error).toBe('取消失败')

    // 成功路径：下一次成功操作清掉错误
    kernel.onDispatch(() => ({ facts: [], value: null }))
    await act(async () => {
      await result.current.cancelRun()
    })
    expect(result.current.error).toBeNull()
    expect(kernel.dispatched.filter((command) => command.type === 'chat.cancel')).toHaveLength(2)
  })

  it('没有会话时中止直接返回', async () => {
    seedConversations([])
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBeNull())

    await act(async () => {
      await result.current.cancelRun()
    })
    expect(kernel.dispatched.some((command) => command.type === 'chat.cancel')).toBe(false)
  })

  it('归档：归档的会话移出主列表、进已归档分组，选中回落到剩余第一条', async () => {
    seedConversations([c1, c2])
    const archived = { ...c1, archivedAt: 't-archived' }
    let list = [c1, c2]
    kernel.onDispatch((command) => {
      if (command.type === 'chat.archive') {
        list = command.archived === false ? [c1, c2] : [archived, c2]
        kernel.setView('conversations.all', undefined, list)
      }
      return { facts: [], value: null }
    })
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))
    expect(result.current.archivedConversations).toEqual([])

    await act(async () => {
      await result.current.archiveConversation('c1', true)
    })
    expect(kernel.dispatched.find((command) => command.type === 'chat.archive')).toMatchObject({
      conversationId: 'c1',
      archived: true,
    })
    await waitFor(() => expect(result.current.conversations.map((item) => item.id)).toEqual(['c2']))
    expect(result.current.archivedConversations.map((item) => item.id)).toEqual(['c1'])
    expect(result.current.activeId).toBe('c2')

    // 恢复：回到主列表
    await act(async () => {
      await result.current.archiveConversation('c1', false)
    })
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual(['c1', 'c2']),
    )
    expect(result.current.archivedConversations).toEqual([])
  })

  it('归档失败写入 error，列表归属不变', async () => {
    seedConversations([c1])
    kernel.onDispatch(() => Promise.reject(new Error('归档失败')))
    const { result } = mount()
    await waitFor(() => expect(result.current.activeId).toBe('c1'))

    await act(async () => {
      await result.current.archiveConversation('c1', true)
    })
    expect(result.current.error).toBe('归档失败')
    expect(result.current.conversations.map((item) => item.id)).toEqual(['c1'])
  })

  it('卸载时调用流订阅返回的退订函数', async () => {
    seedConversations([c1])
    const off = vi.fn()
    const subscribe = vi.spyOn(kernel.store, 'onStream').mockImplementation(() => off)
    const { unmount } = mount()

    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
    expect(off).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalled()

    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
