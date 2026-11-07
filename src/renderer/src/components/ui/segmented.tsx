import type { ReactElement } from 'react'
import { cn } from '../../lib/cn'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  /** 无障碍名称，供读屏区分多个分段控件 */
  ariaLabel?: string
}

/** macOS 风格分段控件：同一互斥视图的若干选项 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: SegmentedProps<T>): ReactElement {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn(
              'rounded-md px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap',
              'transition-colors duration-150 outline-none',
              'focus-visible:ring-2 focus-visible:ring-focus/50',
              active
                ? 'bg-surface-3 text-ink shadow-[0_1px_0_rgb(255_255_255/6%)_inset]'
                : 'text-ink-dim hover:text-ink',
            )}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
