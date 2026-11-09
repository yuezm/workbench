import { useState, type KeyboardEvent, type ReactElement } from 'react'
import type { Agent, Card, Conversation, Message } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { FormError } from '../../../components/ui/form-error'
import { Textarea } from '../../../components/ui/textarea'
import { cn } from '../../../lib/cn'
import type { ChatStreamState } from '../hooks/useChat'
import { ApprovalCards } from './ApprovalCards'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
  /** 本地提示：空内容发送 / 父级抛错，都贴在输入框上方，不静默吞掉 */
  const [notice, setNotice] = useState<string | null>(null)

  const agentName = (id: string): string =>
    agents.find((item) => item.id === id)?.name ?? '未知智能体'
  const canSend = conversation !== null && draft.trim() !== ''
  const streamEmpty =
    streaming.text === '' && streaming.thinking === '' && streaming.tools.length === 0

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) {
      setNotice('先输入内容再发送')
      return
    }
    setNotice(null)
    try {
      if (await onSend(text)) setDraft('')
    } catch (e) {
      // 父级可能 rethrow：就地说明，草稿留着，别让 async 处理器产生无人接的拒绝
      setNotice(`发送失败：${errMsg(e)}`)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {conversation !== null && (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <h2 className="truncate text-base font-medium text-foreground">{conversation.title}</h2>
          {projectName !== undefined && (
            <span
              aria-label="所属项目"
              title={projectName}
              className="max-w-40 shrink-0 truncate rounded-md bg-accent px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {projectName}
            </span>
          )}
          <span className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-xs text-brand">
            {agentName(conversation.agentId)}
          </span>
        </header>
      )}

      {conversation !== null && cards.length > 0 && (
        <div className="shrink-0 border-b border-border px-5 py-3">
          <ApprovalCards cards={cards} />
        </div>
      )}

      <div className="flex-1 overflow-auto p-5" aria-label="消息">
        {conversation === null ? (
          <div className="grid h-full place-items-center text-sm text-faint-foreground">
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
                      'max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap text-foreground',
                      mine ? 'bg-primary/15' : 'bg-muted',
                    )}
                  >
                    {message.content}
                    {message.error !== null && (
                      <p className="mt-1 text-sm text-destructive">{message.error}</p>
                    )}
                  </div>
                </div>
              )
            })}
            {sending && (
              <div className="flex justify-start">
                <div className="flex max-w-[80%] flex-col gap-1.5 rounded-xl bg-muted px-3 py-2 text-sm text-foreground">
                  {streaming.thinking !== '' && (
                    <p className="text-sm whitespace-pre-wrap text-faint-foreground italic">
                      {streaming.thinking}
                    </p>
                  )}
                  {streaming.tools.map((tool, index) => (
                    <p
                      key={`${tool.tool}-${index}`}
                      className={cn(
                        'rounded-md bg-muted px-2 py-1 font-mono text-sm text-faint-foreground',
                        tool.isError && 'text-destructive',
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

      <footer className="flex shrink-0 flex-col gap-2 border-t border-border p-3">
        <FormError message={error} />
        <FormError message={notice} />
        <Textarea
          aria-label="消息输入"
          className="min-h-20 resize-none"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          value={draft}
          onChange={(event) => {
            setNotice(null)
            setDraft(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="flex justify-end">
          {sending ? (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              停止
            </Button>
          ) : (
            <Button variant="default" size="sm" disabled={!canSend} onClick={() => void send()}>
              发送
            </Button>
          )}
        </div>
      </footer>
    </section>
  )
}
