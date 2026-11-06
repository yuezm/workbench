import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'

export interface DetailHeaderProps {
  /** 页面标题（h2：一级标题语义留给 shell 顶部栏） */
  title: string
  /** 标题下的线索行（工作流 · 阶段 / 线程来源） */
  hint: string
  /** 返回上一级（看板 / 线程详情） */
  onBack: () => void
  /** 右侧操作槽（打开线程等） */
  actions?: ReactNode
}

/** 返回箭头：chevron-left */
function BackIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 6l-6 6 6 6" />
    </svg>
  )
}

/**
 * 二级页面（任务详情 / 线程详情）的返回条：左侧「返回」+ 标题线索，右侧操作槽。
 *
 * 详情是页面而不是弹窗：内容区吃满看板原来的位置，返回由路由栈（上层）决定，
 * 这里只发一个回调，不自己管历史。
 */
export function DetailHeader({ title, hint, onBack, actions }: DetailHeaderProps): ReactElement {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line px-6 py-3">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-ink-dim',
          'transition-colors duration-200 hover:bg-white/[0.06] hover:text-ink',
          'focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:outline-none',
        )}
      >
        <BackIcon />
        返回
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-sm font-medium tracking-wide text-ink">{title}</h2>
        <span className="truncate text-[11px] text-ink-faint">{hint}</span>
      </div>
      {actions}
    </header>
  )
}
