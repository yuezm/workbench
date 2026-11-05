import type { ReactElement } from 'react'
import type { Agent, Conversation } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'

export interface ConversationListProps {
  agents: Agent[]
  /** null 表示跟随第一个智能体 */
  agentId: string | null
  onAgentChange: (agentId: string) => void
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onRemove: (id: string) => void
  /** 新建对话请求进行中：按钮禁用，避免连点建出多条 */
  creating: boolean
}

/**
 * 聊天栏目的上下文列表（纯展示）：智能体选择 + 新建对话 + 会话清单。
 * 外壳（宽度 / 边框 / 背景）由父级侧栏提供，本组件只管内容与滚动。
 */
export function ConversationList({
  agents,
  agentId,
  onAgentChange,
  conversations,
  activeId,
  onSelect,
  onCreate,
  onRemove,
  creating,
}: ConversationListProps): ReactElement {
  const selectedAgentId = agentId ?? agents[0]?.id ?? ''
  const agentName = (id: string): string =>
    agents.find((item) => item.id === id)?.name ?? '未知智能体'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {agents.length > 0 ? (
        <Select
          ariaLabel="选择智能体"
          value={selectedAgentId}
          options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
          onChange={onAgentChange}
        />
      ) : (
        <p className="text-xs text-ink-faint">先到设置里配置智能体</p>
      )}

      <Button
        variant="primary"
        size="sm"
        disabled={agents.length === 0 || creating}
        onClick={onCreate}
      >
        新对话
      </Button>

      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        {conversations.map((conversation) => {
          const isActive = conversation.id === activeId
          return (
            <li key={conversation.id} className="flex items-start gap-1">
              <button
                type="button"
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors duration-200 outline-none',
                  'focus-visible:ring-2 focus-visible:ring-focus/60',
                  isActive
                    ? 'bg-white/[0.07] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/6%)]'
                    : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink',
                )}
                onClick={() => onSelect(conversation.id)}
              >
                <span className="w-full truncate font-medium">{conversation.title}</span>
                <span className="w-full truncate text-xs text-ink-faint">
                  {agentName(conversation.agentId)}
                </span>
              </button>
              <button
                type="button"
                aria-label={`删除对话 ${conversation.title}`}
                className="mt-1 grid size-6 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors duration-200 outline-none hover:bg-white/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/60"
                onClick={() => onRemove(conversation.id)}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
