import type { HTMLAttributes, ReactElement } from 'react'
import { cn } from '../../lib/cn'

/** 玻璃面板样式（圆角 + 描边 + 背景 + 阴影） */
export const panelCls =
  'rounded-2xl border border-line bg-white/[0.03] backdrop-blur-xl shadow-[0_1px_0_rgb(255_255_255/5%)_inset,0_20px_50px_-30px_rgb(0_0_0/70%)]'

/** 面板内的小徽标（计数等） */
export const badgeCls =
  'rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] tabular-nums text-ink-dim'

export type PanelProps = HTMLAttributes<HTMLDivElement>

/** 统一的面板容器 */
export function Panel({ className, ...props }: PanelProps): ReactElement {
  return <div className={cn(panelCls, className)} {...props} />
}
