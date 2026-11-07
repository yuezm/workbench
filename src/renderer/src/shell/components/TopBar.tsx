import type { ReactElement } from 'react'
import type { AppPlugin } from '../types'
import { cn } from '../../lib/cn'

interface TopBarProps {
  apps: AppPlugin[]
  activeId: string
  onSelect: (id: string) => void
}

/** 顶部栏：品牌 + app 一级导航（原左侧栏的第一层） */
export function TopBar({ apps, activeId, onSelect }: TopBarProps): ReactElement {
  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center gap-4 border-b border-line bg-abyss px-4">
      {/* 品牌区 */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-md bg-focus">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M12 2c.6 4.8 3.2 7.4 8 8-4.8.6-7.4 3.2-8 8-.6-4.8-3.2-7.4-8-8 4.8-.6 7.4-3.2 8-8z" />
          </svg>
        </span>
        <span className="text-[13px] font-semibold tracking-wide">Workbench</span>
      </div>

      {/* 应用标签 */}
      <nav aria-label="应用导航" className="flex items-center gap-1">
        {apps.map((app) => {
          const active = app.id === activeId
          return (
            <button
              key={app.id}
              type="button"
              className={cn(
                'relative flex items-center gap-2 rounded-md px-3 py-1.5',
                'text-[13px] font-medium transition-colors duration-150 outline-none',
                'focus-visible:ring-2 focus-visible:ring-focus/50',
                active
                  ? 'bg-surface-2 text-ink'
                  : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink',
              )}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(app.id)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'transition-colors duration-150',
                  active ? 'text-focus-soft' : 'text-ink-faint',
                )}
              >
                <app.icon size={15} />
              </span>
              <span>{app.name}</span>
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-focus"
                />
              ) : null}
            </button>
          )
        })}
      </nav>

      <span className="ml-auto text-[11px] text-ink-faint">v0.1.0</span>
    </header>
  )
}
