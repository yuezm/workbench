import type { ReactElement } from 'react'
import type { AppPlugin } from '../types'
import { cn } from '../../lib/cn'
import { ThemeSwitcher } from '../../components/ui/theme-switcher'

interface TopBarProps {
  apps: AppPlugin[]
  activeId: string
  onSelect: (id: string) => void
}

/** 顶部栏：品牌 + app 一级导航（原左侧栏的第一层） */
export function TopBar({ apps, activeId, onSelect }: TopBarProps): ReactElement {
  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center gap-4 border-b border-border bg-background px-4">
      {/* 品牌区 */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-md bg-primary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M12 2c.6 4.8 3.2 7.4 8 8-4.8.6-7.4 3.2-8 8-.6-4.8-3.2-7.4-8-8 4.8-.6 7.4-3.2 8-8z" />
          </svg>
        </span>
        <span className="text-sm font-medium">Workbench</span>
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
                'text-sm font-medium transition-colors duration-150 outline-none',
                'focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(app.id)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'transition-colors duration-150',
                  active ? 'text-brand' : 'text-faint-foreground',
                )}
              >
                <app.icon size={15} />
              </span>
              <span>{app.name}</span>
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary"
                />
              ) : null}
            </button>
          )
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* 主题切换器：全局设置（亮/暗/跟随系统），任何 app 都从这里切 */}
        <ThemeSwitcher />
        <span className="text-xs text-faint-foreground">v0.1.0</span>
      </div>
    </header>
  )
}
