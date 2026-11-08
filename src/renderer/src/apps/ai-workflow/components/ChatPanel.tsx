import { useState, type KeyboardEvent, type ReactElement } from 'react'
import type { Agent, Card, Conversation, Message } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { fieldCls } from '../../../components/ui/input'
import { cn } from '../../../lib/cn'
import type { ChatStreamState } from '../hooks/useChat'
import { ApprovalCards } from './ApprovalCards'

/** 错误条：任一操作失败都在输入区上方提示，下一次成功操作自动消失 */
const ERROR_CLS =
  'rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-body text-red-300'

/** 流式工具事件内容的最大展示长度 */
const STREAM_TOOL_MAX = 120

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export interface ChatPanelProps {
  /** 智能体清单：把会话绑定的 agentId 显示成名字 */
  agents: Agent[]
  conversation: Conversation | null
  /** 当前所在的项目名（或「默认目录」）：聊天与任务共用顶层上下文，头部交代落在哪 */
  projectName?: string
  messages: Message[]
  /** 本会话的 open 卡：审批与选项在会话内处理，不在顶部通知条里 */
  cards?: Card[]
  /** 当前轮已收到的流式输出（正文 / 思考 / 工具事件） */
  streaming: ChatStreamState
  sending: boolean
  error: string | null
  /** 发送一轮：resolve true 表示已发出，组件据此清空草稿 */
  onSend: (text: string) => Promise<boolean>
  onCancel: () => void
}

/**
 * 聊天栏目内容区：会话头部 + 待处理卡片 + 消息流 + 输入区。
 *
 * 会话状态由 useChat 持有（侧栏与内容区共用），这里只留输入草稿。
 * 流式期间正文按增量追加，thinking / 工具事件以次要样式展示，本轮结束后丢弃。
 * 本会话挂着的 open 卡（智能体回执 `ask` / `notices`）在消息流上方就地处理。
 */
export function ChatPanel({
  agents,
  conversation,
  projectName,
  messages,
  cards = [],
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
  const streamEmpty =
    streaming.text === '' && streaming.thinking === '' && streaming.tools.length === 0

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
          <h2 className="truncate text-title font-medium text-ink">{conversation.title}</h2>
          {projectName !== undefined && (
            <span
              aria-label="所属项目"
              title={projectName}
              className="max-w-40 shrink-0 truncate rounded-md bg-white/[0.06] px-1.5 py-0.5 text-badge text-ink-dim"
            >
              {projectName}
            </span>
          )}
          <span className="shrink-0 rounded-md bg-focus/15 px-1.5 py-0.5 text-badge text-focus-soft">
            {agentName(conversation.agentId)}
          </span>
        </header>
      )}

      {conversation !== null && cards.length > 0 && (
        <div className="shrink-0 border-b border-line px-5 py-3">
          <ApprovalCards cards={cards} />
        </div>
      )}

      <div className="flex-1 overflow-auto p-5" aria-label="消息">
        {conversation === null ? (
          <div className="grid h-full place-items-center text-body text-ink-faint">
            点左侧「新对话」开始
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
                      'max-w-[80%] rounded-xl px-3 py-2 text-body whitespace-pre-wrap text-ink',
                      mine ? 'bg-focus/15' : 'bg-surface-2',
                    )}
                  >
                    {message.content}
                    {message.error !== null && (
                      <p className="mt-1 text-body text-red-300">{message.error}</p>
                    )}
                  </div>
                </div>
              )
            })}
            {sending && (
              <div className="flex justify-start">
                <div className="flex max-w-[80%] flex-col gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-body text-ink">
                  {streaming.thinking !== '' && (
                    <p className="text-body whitespace-pre-wrap text-ink-faint italic">
                      {streaming.thinking}
                    </p>
                  )}
                  {streaming.tools.map((tool, index) => (
                    <p
                      key={`${tool.tool}-${index}`}
                      className={cn(
                        'rounded-md bg-surface-2 px-2 py-1 font-mono text-body text-ink-faint',
                        tool.isError && 'text-red-300',
                      )}
                    >
                      {[
                        tool.tool,
                        tool.content === '' ? '' : truncate(tool.content, STREAM_TOOL_MAX),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  ))}
                  <span className="whitespace-pre-wrap">
                    {streamEmpty ? '正在输出…' : streaming.text}
                  </span>
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
