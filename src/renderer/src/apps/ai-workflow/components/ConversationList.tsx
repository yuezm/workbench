import { useEffect, useState, type ReactElement } from 'react'
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
  /** 已归档的会话：收在清单底部的分组里，只能恢复或删除 */
  archived: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onRemove: (id: string) => void
  /** 归档 / 恢复（archived=false） */
  onArchive: (id: string, archived: boolean) => void
  /** 新建对话请求进行中：按钮禁用，避免连点建出多条 */
  creating: boolean
}

/** 三点图标：会话行右侧的更多操作入口 */
function MoreIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

/** 菜单项统一样式；`danger` 用于删除 */
const menuItemCls = (danger: boolean): string =>
  cn(
    'w-full rounded-md px-2 py-1.5 text-left text-action transition-colors duration-150 outline-none',
    'focus-visible:ring-2 focus-visible:ring-focus/60',
    danger
      ? 'text-red-300 hover:bg-red-400/10'
      : 'text-ink-dim hover:bg-white/[0.06] hover:text-ink',
  )

/**
 * 聊天栏目的上下文列表（纯展示）：智能体选择 + 新建对话 + 会话清单。
 * 外壳（宽度 / 边框 / 背景）由父级侧栏提供，本组件只管内容与滚动。
 *
 * 会话行默认只露标题与智能体；删除 / 归档收进 hover 才出现的三点菜单，
 * 避免每行都挂一个常驻图标。已归档的会话单独收在底部分组里，可恢复。
 */
export function ConversationList({
  agents,
  agentId,
  onAgentChange,
  conversations,
  archived,
  activeId,
  onSelect,
  onCreate,
  onRemove,
  onArchive,
  creating,
}: ConversationListProps): ReactElement {
  const selectedAgentId = agentId ?? agents[0]?.id ?? ''
  const agentName = (id: string): string =>
    agents.find((item) => item.id === id)?.name ?? '未知智能体'
  /** 打开菜单的会话 id（同时只开一个） */
  const [menuId, setMenuId] = useState<string | null>(null)
  /** 已归档分组是否展开 */
  const [showArchived, setShowArchived] = useState(false)

  // 菜单打开时点别处 / 按 Esc 收起：挂在 document 上，避免点行内其它元素时菜单残留
  useEffect(() => {
    if (menuId === null) return
    const close = (): void => setMenuId(null)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuId(null)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuId])

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
        <p className="text-meta text-ink-faint">先配置智能体</p>
      )}

      <Button
        variant="primary"
        size="sm"
        disabled={agents.length === 0 || creating}
        onClick={onCreate}
      >
        新对话
      </Button>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        <ul className="flex flex-col gap-1">
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeId
            return (
              <li key={conversation.id} className="group relative flex items-center">
                <button
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-2.5 py-2 pr-8 text-left text-action transition-colors duration-200 outline-none',
                    'focus-visible:ring-2 focus-visible:ring-focus/60',
                    isActive
                      ? 'bg-surface-3 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/6%)]'
                      : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink',
                  )}
                  onClick={() => onSelect(conversation.id)}
                >
                  <span className="w-full truncate font-medium">{conversation.title}</span>
                  <span className="w-full truncate text-meta text-ink-faint">
                    {agentName(conversation.agentId)}
                  </span>
                </button>

                {/* 三点入口：hover / 键盘聚焦 / 菜单打开时可见，避免常驻图标压住标题 */}
                <div
                  className={cn(
                    'absolute top-1.5 right-1 transition-opacity duration-150',
                    'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
                    menuId === conversation.id && 'opacity-100',
                  )}
                >
                  <button
                    type="button"
                    aria-label={`会话 ${conversation.title} 更多操作`}
                    aria-haspopup="menu"
                    aria-expanded={menuId === conversation.id}
                    className={cn(
                      'grid size-6 place-items-center rounded-lg text-ink-faint transition-colors duration-150 outline-none',
                      'hover:bg-white/[0.08] hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/60',
                    )}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() =>
                      setMenuId((current) => (current === conversation.id ? null : conversation.id))
                    }
                  >
                    <MoreIcon />
                  </button>

                  {menuId === conversation.id && (
                    <div
                      role="menu"
                      aria-label={`会话 ${conversation.title} 操作`}
                      className="absolute top-7 right-0 z-10 flex w-24 flex-col gap-0.5 rounded-lg border border-line bg-surface-2 p-1 shadow-lg shadow-black/40"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className={menuItemCls(false)}
                        onClick={() => {
                          setMenuId(null)
                          onArchive(conversation.id, true)
                        }}
                      >
                        归档
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={menuItemCls(true)}
                        onClick={() => {
                          setMenuId(null)
                          onRemove(conversation.id)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        {archived.length > 0 && (
          <div className="mt-auto flex flex-col gap-1 pt-1">
            <button
              type="button"
              aria-expanded={showArchived}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-left text-action text-ink-faint transition-colors duration-150 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/60"
              onClick={() => setShowArchived((open) => !open)}
            >
              <span className="truncate">已归档</span>
              <span className="rounded-sm bg-white/[0.06] px-1.5 text-badge">
                {archived.length}
              </span>
            </button>

            {showArchived && (
              <ul className="flex flex-col gap-1">
                {archived.map((conversation) => (
                  <li
                    key={conversation.id}
                    className="flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-action text-ink-faint"
                  >
                    <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                    <button
                      type="button"
                      aria-label={`恢复会话 ${conversation.title}`}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-action font-medium text-ink-dim transition-colors duration-150 outline-none hover:bg-white/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-focus/60"
                      onClick={() => onArchive(conversation.id, false)}
                    >
                      恢复
                    </button>
                    <button
                      type="button"
                      aria-label={`删除会话 ${conversation.title}`}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-action font-medium text-red-300/80 transition-colors duration-150 outline-none hover:bg-red-400/10 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-focus/60"
                      onClick={() => onRemove(conversation.id)}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
