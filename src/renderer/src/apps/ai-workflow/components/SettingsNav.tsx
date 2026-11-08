import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

/** 设置页的五个二级栏目 */
export type SettingsSection = 'runtimes' | 'agents' | 'workflows' | 'rules' | 'plugins'

interface SettingsNavProps {
  value: SettingsSection
  onChange: (value: SettingsSection) => void
}

interface NavItem {
  value: SettingsSection
  label: string
  /** 图标路径（24 视框） */
  path: string
}

const ITEMS: NavItem[] = [
  { value: 'runtimes', label: '运行时', path: 'M4 6.5 9 11l-5 4.5M12.5 16.5H20' },
  {
    value: 'agents',
    label: '智能体',
    path: 'M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4 4 4 0 0 1-4-4V7a4 4 0 0 1 4-4ZM5 21a7 7 0 0 1 14 0z',
  },
  { value: 'workflows', label: '工作流', path: 'M4 6h6v5H4zM14 6h6v5h-6zM4 13h16v5H4z' },
  { value: 'rules', label: '规则', path: 'M13 3 5 13h5l-1 8 8-11h-5z' },
  {
    value: 'plugins',
    label: '插件',
    path: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  },
]

/** 设置页左侧的二级栏目：运行时 / 智能体 / 工作流 / 规则 / 插件（外壳由父级侧栏提供） */
export function SettingsNav({ value, onChange }: SettingsNavProps): ReactElement {
  return (
    <nav aria-label="设置栏目" className="flex flex-col gap-1">
      {ITEMS.map((item) => {
        const active = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-action transition-colors duration-200 outline-none',
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
                'grid size-6 shrink-0 place-items-center rounded-lg transition-colors duration-200',
                active ? 'bg-focus/15 text-focus-soft' : 'bg-white/[0.04] text-ink-faint',
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
            <span className="font-medium">{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
