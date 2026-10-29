import type { ReactElement } from 'react'
import type { AppDefinition } from '../types'
import { cn } from '../../lib/cn'

interface SidebarProps {
  apps: AppDefinition[]
  activeId: string
  onSelect: (id: string) => void
}

export function Sidebar({ apps, activeId, onSelect }: SidebarProps): ReactElement {
  return (
    <nav
      className="relative z-10 flex w-56 shrink-0 flex-col border-r border-line bg-white/[0.02] backdrop-blur-xl"
      aria-label="应用导航"
    >
      {/* 品牌区 */}
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <span className="grid size-8 place-items-center rounded-xl bg-gradient-to-br from-focus to-long shadow-[0_4px_16px_-4px_var(--color-focus)]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M12 2c.6 4.8 3.2 7.4 8 8-4.8.6-7.4 3.2-8 8-.6-4.8-3.2-7.4-8-8 4.8-.6 7.4-3.2 8-8z" />
          </svg>
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-wide">Workbench</span>
          <span className="text-[11px] text-ink-faint">个人工作台</span>
        </span>
      </div>

      <div className="mx-4 h-px shrink-0 bg-line" />

      {/* 应用列表 */}
      <div className="flex flex-col gap-1 p-3">
        {apps.map((app) => {
          const active = app.id === activeId
          return (
            <button
              key={app.id}
              type="button"
              className={cn(
                'group relative flex items-center gap-3 rounded-xl px-2.5 py-2',
                'text-left text-sm transition-all duration-200 outline-none',
                'focus-visible:ring-2 focus-visible:ring-focus/60',
                active
                  ? 'bg-white/[0.07] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/6%)]'
                  : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
              )}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(app.id)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full',
                  'bg-gradient-to-b from-focus to-long transition-opacity duration-200',
                  active ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-lg transition-colors duration-200',
                  active
                    ? 'bg-focus/15 text-focus'
                    : 'bg-white/[0.04] text-ink-faint group-hover:text-ink-dim'
                )}
              >
                <app.icon size={15} />
              </span>
              <span className="font-medium">{app.name}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto px-5 pb-4 text-[11px] text-ink-faint">v0.1.0</div>
    </nav>
  )
}
