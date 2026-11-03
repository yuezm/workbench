import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

/** 设置页的三个二级栏目 */
export type SettingsSection = 'runtimes' | 'agents' | 'workflows'

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
  { value: 'runtimes', label: '运行时配置', path: 'M4 6.5 9 11l-5 4.5M12.5 16.5H20' },
  {
    value: 'agents',
    label: '智能体配置',
    path: 'M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4 4 4 0 0 1-4-4V7a4 4 0 0 1 4-4ZM5 21a7 7 0 0 1 14 0z',
  },
  { value: 'workflows', label: '工作流配置', path: 'M4 6h6v5H4zM14 6h6v5h-6zM4 13h16v5H4z' },
]

/** 设置页左侧的二级栏目：运行时 / 智能体 / 工作流（外壳由父级侧栏提供） */
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
              'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors duration-200 outline-none',
              'focus-visible:ring-2 focus-visible:ring-focus/60',
              active
                ? 'bg-white/[0.07] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/6%)]'
                : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink',
            )}
            onClick={() => onChange(item.value)}
          >
            <span
              aria-hidden="true"
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-lg transition-colors duration-200',
                active ? 'bg-focus/15 text-focus' : 'bg-white/[0.04] text-ink-faint',
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
