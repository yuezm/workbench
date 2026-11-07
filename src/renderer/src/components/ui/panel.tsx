import type { HTMLAttributes, ReactElement } from 'react'
import { cn } from '../../lib/cn'

/** 面板样式（容器圆角 10px + 描边 + 实心面板底 + 一层低调投影，不做玻璃模糊） */
export const panelCls =
  'rounded-xl border border-line bg-surface shadow-[0_1px_0_rgb(255_255_255/5%)_inset,0_18px_40px_-28px_rgb(0_0_0/80%)]'

/** 面板内的小徽标（计数等）：徽标圆角 4px */
export const badgeCls =
  'rounded-sm bg-white/[0.07] px-1.5 py-0.5 text-[11px] tabular-nums text-ink-dim'

export type PanelProps = HTMLAttributes<HTMLDivElement>

/** 统一的面板容器 */
export function Panel({ className, ...props }: PanelProps): ReactElement {
  return <div className={cn(panelCls, className)} {...props} />
}
