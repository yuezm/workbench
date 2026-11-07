import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'

/** 工作台的两个一级栏目 */
export type WorkspaceSection = 'chat' | 'tasks'

export interface WorkspaceNavProps {
  value: WorkspaceSection
  onChange: (value: WorkspaceSection) => void
  /** 当前栏目的上下文列表：聊天 = 会话清单，任务 = 工作流切换器 */
  children: ReactNode
}

interface NavItem {
  value: WorkspaceSection
  label: string
  /** 图标路径（24 视框） */
  path: string
}

const ITEMS: NavItem[] = [
  { value: 'chat', label: '聊天', path: 'M4 5h16v11H9l-5 4z' },
  { value: 'tasks', label: '任务', path: 'M4 6h6v5H4zM14 6h6v5h-6zM4 13h16v5H4z' },
]

/**
 * 工作台侧栏顶部：横向「聊天 / 任务」切换条 + 当前栏目的上下文列表槽。
 * 外壳（宽度 / 边框 / 背景）由父级侧栏提供。
 */
export function WorkspaceNav({ value, onChange, children }: WorkspaceNavProps): ReactElement {
  return (
    <nav aria-label="工作台栏目" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
        {ITEMS.map((item) => {
          const active = item.value === value
          return (
            <button
              key={item.value}
              type="button"
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[13px] font-medium',
                'transition-colors duration-150 outline-none',
                'focus-visible:ring-2 focus-visible:ring-focus/60',
                active
                  ? 'bg-surface-3 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/6%)]'
                  : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink',
              )}
              onClick={() => onChange(item.value)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'transition-colors duration-200',
                  active ? 'text-focus-soft' : 'text-ink-faint',
                )}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={item.path} />
                </svg>
              </span>
              <span>{item.label}</span>
            </button>
          )
        })}
      </div>

      <div className="h-px shrink-0 bg-line" />

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </nav>
  )
}
