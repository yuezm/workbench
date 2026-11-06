import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent, Conversation, Message, RunEvent } from '../../../../../protocol/entities'
import type { KernelEvent } from '../../../../../protocol/ipc'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'

/** 把未知异常转成可展示文案 */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 流式期间展示的一条工具事件（只保留展示需要的字段） */
export interface ChatStreamTool {
  /** 工具名 */
  tool: string
  /** tool_call 的参数或 tool_result 的输出 */
  content: string
  /** tool_result 是否失败 */
  isError: boolean
}

/** 当前轮的流式输出：正文 + 思考 + 工具事件（结束后随消息落库一起丢弃） */
export interface ChatStreamState {
  text: string
  thinking: string
  tools: ChatStreamTool[]
}

const EMPTY_STREAM: ChatStreamState = { text: '', thinking: '', tools: [] }

export interface UseChatResult {
  /** null 表示跟随第一个智能体 */
  agentId: string | null
  setAgentId: (id: string | null) => void
  /** 新建对话时实际使用的智能体：未显式选择则取第一个 */
  selectedAgentId: string
  /** 未归档的会话（聊天清单主体） */
  conversations: Conversation[]
  /** 已归档的会话（清单底部的「已归档」分组） */
  archivedConversations: Conversation[]
  activeId: string | null
  active: Conversation | null
  messages: Message[]
  /** 当前轮的流式输出 */
  streaming: ChatStreamState
  sending: boolean
  creating: boolean
  error: string | null
  /** 切换当前会话；旧会话的残留消息与流式输出一并清掉 */
  selectConversation: (id: string) => void
  createConversation: () => Promise<void>
  removeConversation: (id: string) => Promise<void>
  /** 归档 / 恢复（archived=false）：只改列表归属，不删消息 */
  archiveConversation: (id: string, archived: boolean) => Promise<void>
  /** 发送一轮；成功发出返回 true（调用方据此清空输入草稿） */
  sendMessage: (text: string) => Promise<boolean>
  cancelRun: () => Promise<void>
}

/**
 * 聊天状态机（M5）：会话 / 消息读内核视图，增删改发命令，流事件走 store 的旁路订阅。
 *
 * 状态从 ChatPanel 抽出，供侧栏（会话清单）与内容区（消息流）共用同一份：
 * 两侧各建一份实例会各订阅一次事件、各拉一次消息，选中项也对不上。
 *
 * 视图：`conversations.all`（会话清单）、`messages.byConversation`（当前会话消息）。
 * 流：`stream` 增量追加到本轮的 UI 态，`stream-end` 收尾；消息落库后
 * `message.*` 事实会让消息视图自动重取，结束时不再手动拉列表。
 */
/** subscribe 只推流旁路；facts 走视图失效，不进聊天流。 */
 type ChatStreamKernelEvent = Extract<KernelEvent, { kind: 'stream' | 'stream-end' }>

export function useChat(agents: Agent[]): UseChatResult {
  const [agentId, setAgentId] = useState<string | null>(null)
  /** 用户选中的会话：缺失（被删/清空）时回落到清单第一条，由视图数据派生 */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState<ChatStreamState>(EMPTY_STREAM)
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  /** 写操作的错误（命令被拒）；展示时优先于视图读错误 */
  const [writeError, setWriteError] = useState<string | null>(null)

  const conversationsState = useKernelViewState('conversations.all')
  const allConversations = conversationsState.data ?? []
  /** 归档只影响清单归属：归档的不进主列表，留在底部「已归档」分组里 */
  const conversations = allConversations.filter((item) => (item.archivedAt ?? null) === null)
  const archivedConversations = allConversations.filter((item) => (item.archivedAt ?? null) !== null)
  /** 选中项由视图数据兜底：选中的会话被删/归档后自动落到第一条未归档，不需要 effect 回填 */
  const activeId =
    selectedId !== null && conversations.some((item) => item.id === selectedId)
      ? selectedId
      : (conversations[0]?.id ?? null)
  const messagesState = useKernelViewState(
    'messages.byConversation',
    activeId ? { conversationId: activeId } : null,
  )
  const messages = messagesState.data ?? []
  const error = writeError ?? conversationsState.error ?? messagesState.error
  const active = conversations.find((item) => item.id === activeId) ?? null
  const selectedAgentId = agentId ?? agents[0]?.id ?? ''

  /** 供事件回调读取最新会话，避免 activeId 变化时重建订阅 */
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  /** 流事件只处理当前会话：切走后旧会话的增量直接丢弃 */
  const handleEvent = useCallback((event: ChatStreamKernelEvent): void => {
    if (event.conversationId === null || event.conversationId !== activeIdRef.current) return
    if (event.kind === 'stream-end') {
      // 本轮结束：收尾流式态；消息落库后消息视图随事实失效重取
      setSending(false)
      setStreaming(EMPTY_STREAM)
      return
    }
    const delta: RunEvent = event.event
    switch (delta.type) {
      case 'text':
        setStreaming((prev) => ({ ...prev, text: prev.text + (delta.text ?? '') }))
        return
      case 'thinking':
        setStreaming((prev) => ({ ...prev, thinking: prev.thinking + (delta.text ?? '') }))
        return
      case 'tool_call':
        setStreaming((prev) => ({
          ...prev,
          tools: [
            ...prev.tools,
            { tool: delta.tool ?? '未知工具', content: delta.input ?? '', isError: false },
          ],
        }))
        return
      case 'tool_result':
        setStreaming((prev) => ({
          ...prev,
          tools: [
            ...prev.tools,
            {
              tool: delta.tool ?? '未知工具',
              content: delta.output ?? '',
              isError: delta.isError === true,
            },
          ],
        }))
        return
      default:
        // status 等进度事件不进入聊天正文
        return
    }
  }, [])

  // 挂载：订阅流事件旁路（卸载时退订）
  useEffect(() => getKernelStore().onStream((event) => handleEvent(event as ChatStreamKernelEvent)), [handleEvent])

  /** 切换当前会话：清掉上一段的残留流式输出（消息随视图参数切换自动重取） */
  const selectConversation = (id: string): void => {
    setSelectedId(id)
    setStreaming(EMPTY_STREAM)
    setWriteError(null)
  }

  const createConversation = async (): Promise<void> => {
    setCreating(true)
    try {
      const result = await getKernelStore().dispatch({
        type: 'chat.create',
        commandId: '',
        agentId: selectedAgentId,
      })
      const created = result.value
      if (created !== null) {
        setSelectedId(created.id)
        setStreaming(EMPTY_STREAM)
      }
      setWriteError(null)
    } catch (e) {
      setWriteError(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  const removeConversation = async (id: string): Promise<void> => {
    try {
      await getKernelStore().dispatch({ type: 'chat.remove', commandId: '', conversationId: id })
      setWriteError(null)
      // 删掉的正是当前会话：清掉选中，落到剩余第一条（没有剩余则清空）
      if (id === activeIdRef.current) {
        setSelectedId(null)
        setStreaming(EMPTY_STREAM)
      }
    } catch (e) {
      setWriteError(errMsg(e))
    }
  }

  /** 归档 / 恢复：归档后当前选中的会话会从主列表消失，选中自然回落到第一条未归档 */
  const archiveConversation = async (id: string, archived: boolean): Promise<void> => {
    try {
      await getKernelStore().dispatch({
        type: 'chat.archive',
        commandId: '',
        conversationId: id,
        archived,
      })
      setWriteError(null)
    } catch (e) {
      setWriteError(errMsg(e))
    }
  }

  const sendMessage = async (text: string): Promise<boolean> => {
    const content = text.trim()
    if (!content || !activeId) return false
    setSending(true)
    try {
      await getKernelStore().dispatch({
        type: 'chat.send',
        commandId: '',
        conversationId: activeId,
        content,
      })
      setWriteError(null)
      // 用户消息已落库：`message.*` 事实会让消息视图自动刷新
      return true
    } catch (e) {
      setWriteError(errMsg(e))
      setSending(false)
      return false
    }
  }

  const cancelRun = async (): Promise<void> => {
    if (!activeId) return
    try {
      await getKernelStore().dispatch({
        type: 'chat.cancel',
        commandId: '',
        conversationId: activeId,
      })
      setWriteError(null)
    } catch (e) {
      setWriteError(errMsg(e))
    }
  }

  return {
    agentId,
    setAgentId,
    selectedAgentId,
    conversations,
    archivedConversations,
    activeId,
    active,
    messages,
    streaming,
    sending,
    creating,
    error,
    selectConversation,
    createConversation,
    removeConversation,
    archiveConversation,
    sendMessage,
    cancelRun,
  }
}
