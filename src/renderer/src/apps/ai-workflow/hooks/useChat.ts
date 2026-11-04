import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Agent,
  ChatConversation,
  ChatMessage,
  ChatStreamEvent,
} from '../../../../../shared/ai-workflow-api'
import { wfApi } from '../api'

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
  conversations: ChatConversation[]
  activeId: string | null
  active: ChatConversation | null
  messages: ChatMessage[]
  /** 当前轮的流式输出 */
  streaming: ChatStreamState
  sending: boolean
  creating: boolean
  error: string | null
  /** 切换当前会话；旧会话的残留消息与流式输出一并清掉 */
  selectConversation: (id: string) => void
  createConversation: () => Promise<void>
  removeConversation: (id: string) => Promise<void>
  /** 发送一轮；成功发出返回 true（调用方据此清空输入草稿） */
  sendMessage: (text: string) => Promise<boolean>
  cancelRun: () => Promise<void>
}

/**
 * 聊天状态机：会话增删选、消息拉取、流式事件、发送与中止。
 *
 * 状态从 ChatPanel 抽出，供侧栏（会话清单）与内容区（消息流）共用同一份：
 * 两侧各建一份实例会各订阅一次事件、各拉一次消息，选中项也对不上。
 *
 * 流事件形如 `{type:'event', event: RunEvent}`（增量）与 `{type:'end'}`（本轮落库）；
 * 只消费当前会话的事件，end 后重拉消息列表。
 */
export function useChat(agents: Agent[]): UseChatResult {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState<ChatStreamState>(EMPTY_STREAM)
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 自增即触发一次消息重载（发送成功后 / end 事件） */
  const [reloadKey, setReloadKey] = useState(0)

  const selectedAgentId = agentId ?? agents[0]?.id ?? ''
  const active = conversations.find((item) => item.id === activeId) ?? null

  /** 供事件回调读取最新会话，避免 activeId 变化时重建订阅 */
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  /** 流事件只处理当前会话：切走后旧会话的增量直接丢弃 */
  const handleEvent = useCallback((event: ChatStreamEvent): void => {
    if (event.conversationId !== activeIdRef.current) return
    if (event.type === 'end') {
      // 本轮结果已落库，交给消息重载收尾
      setSending(false)
      setStreaming(EMPTY_STREAM)
      setReloadKey((key) => key + 1)
      return
    }
    const delta = event.event
    if (!delta) return
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

  // 挂载：拉会话列表并选中第一条，同时订阅流事件（卸载时退订）
  useEffect(() => {
    const chat = wfApi().chat
    void chat
      .listConversations()
      .then((list) => {
        setConversations(list)
        setActiveId(list[0]?.id ?? null)
      })
      .catch((e: unknown) => setError(errMsg(e)))
    return chat.onEvent(handleEvent)
  }, [handleEvent])

  // 选中会话变化或重载标记变化时拉消息；过期的响应不写入
  useEffect(() => {
    if (!activeId) return
    let alive = true
    void wfApi()
      .chat.listMessages(activeId)
      .then((list) => {
        if (!alive) return
        setMessages(list)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(errMsg(e))
      })
    return () => {
      alive = false
    }
  }, [activeId, reloadKey])

  /** 切换当前会话：清掉上一段的残留消息与流式输出（放在事件里，避免 effect 内同步 setState） */
  const selectConversation = (id: string): void => {
    setActiveId(id)
    setMessages([])
    setStreaming(EMPTY_STREAM)
    setError(null)
  }

  const createConversation = async (): Promise<void> => {
    setCreating(true)
    try {
      const created = await wfApi().chat.createConversation(selectedAgentId)
      setConversations(await wfApi().chat.listConversations())
      selectConversation(created.id)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  const removeConversation = async (id: string): Promise<void> => {
    try {
      await wfApi().chat.removeConversation(id)
      const list = await wfApi().chat.listConversations()
      setConversations(list)
      setError(null)
      // 删掉的正是当前会话：落到剩余第一条，没有剩余则清空
      if (id === activeIdRef.current) {
        if (list[0]) selectConversation(list[0].id)
        else {
          setActiveId(null)
          setMessages([])
          setStreaming(EMPTY_STREAM)
        }
      }
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const sendMessage = async (text: string): Promise<boolean> => {
    const content = text.trim()
    if (!content || !activeId) return false
    setSending(true)
    try {
      await wfApi().chat.send(activeId, content)
      setError(null)
      // 用户消息已落库，重载一次让气泡出现
      setReloadKey((key) => key + 1)
      return true
    } catch (e) {
      setError(errMsg(e))
      setSending(false)
      return false
    }
  }

  const cancelRun = async (): Promise<void> => {
    if (!activeId) return
    try {
      await wfApi().chat.cancel(activeId)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return {
    agentId,
    setAgentId,
    selectedAgentId,
    conversations,
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
    sendMessage,
    cancelRun,
  }
}
