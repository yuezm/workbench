import { useState, type KeyboardEvent, type ReactElement } from 'react'
import type { Agent, ChatConversation, ChatMessage } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { fieldCls } from '../../../components/ui/input'
import { cn } from '../../../lib/cn'

/** 错误条：任一操作失败都在输入区上方提示，下一次成功操作自动消失 */
const ERROR_CLS = 'rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300'

export interface ChatPanelProps {
  /** 智能体清单：把会话绑定的 agentId 显示成名字 */
  agents: Agent[]
  conversation: ChatConversation | null
  messages: ChatMessage[]
  /** 当前轮已收到的流式增量 */
  streaming: string
  sending: boolean
  error: string | null
  /** 发送一轮：resolve true 表示已发出，组件据此清空草稿 */
  onSend: (text: string) => Promise<boolean>
  onCancel: () => void
}

/**
 * 聊天栏目内容区：会话头部 + 消息流 + 输入区。
 * 会话状态由 useChat 持有（侧栏与内容区共用），这里只留输入草稿。
 */
export function ChatPanel({
  agents,
  conversation,
  messages,
  streaming,
  sending,
  error,
  onSend,
  onCancel,
}: ChatPanelProps): ReactElement {
  const [draft, setDraft] = useState('')

  const agentName = (id: string): string =>
    agents.find((item) => item.id === id)?.name ?? '未知智能体'
  const canSend = conversation !== null && draft.trim() !== ''

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    if (await onSend(text)) setDraft('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {conversation !== null && (
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="truncate text-sm font-medium text-ink">{conversation.title}</h2>
          <span className="shrink-0 rounded-md bg-focus/15 px-1.5 py-0.5 text-xs text-focus">
            {agentName(conversation.agentId)}
          </span>
        </header>
      )}

      <div className="flex-1 overflow-auto p-5" aria-label="消息">
        {conversation === null ? (
          <div className="grid h-full place-items-center text-sm text-ink-faint">
            还没有对话，点左侧「新对话」开始
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => {
              const mine = message.role === 'user'
              return (
                <div
                  key={message.id}
                  className={cn('flex', mine ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap text-ink',
                      mine ? 'bg-focus/15' : 'bg-white/[0.05]',
                    )}
                  >
                    {message.content}
                    {message.error !== null && (
                      <p className="mt-1 text-xs text-red-300">{message.error}</p>
                    )}
                  </div>
                </div>
              )
            })}
            {sending && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-xl bg-white/[0.05] px-3 py-2 text-sm whitespace-pre-wrap text-ink">
                  {streaming === '' ? '正在输出…' : streaming}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
        {error !== null && <p className={ERROR_CLS}>{error}</p>}
        <textarea
          aria-label="消息输入"
          className={cn(fieldCls, 'min-h-20 resize-none py-2')}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex justify-end">
          {sending ? (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              停止
            </Button>
          ) : (
            <Button variant="primary" size="sm" disabled={!canSend} onClick={() => void send()}>
              发送
            </Button>
          )}
        </div>
      </footer>
    </section>
  )
}
