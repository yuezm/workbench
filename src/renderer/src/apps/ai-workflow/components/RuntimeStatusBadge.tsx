import type { ReactElement } from 'react'
import type { RuntimeProbe } from '../../../../../protocol/entities'
import { cn } from '../../../lib/cn'

/** 健康 pill 的统一基座：小圆角、等宽数字（耗时对齐不跳动） */
const pillCls = 'rounded-sm px-2 py-0.5 text-xs tabular-nums'

export interface RuntimeStatusBadgeProps {
  /** 最近一次探测结论；null = 从未探测 */
  probe: RuntimeProbe | null
  /** 探测进行中：优先于 lastProbe 展示 */
  testing?: boolean
  /** 失败详情是否展开（配合 onToggle） */
  expanded?: boolean
  /** 不可用时点击切换失败详情 */
  onToggle?: () => void
}

/**
 * 运行时健康状态 pill：未检测（灰）/ 可用（绿）/ 不可用（红）/ 测试中（强调色）。
 *
 * 失败原因放在 title 里（悬浮可见），点击 pill 由父级展开完整 error 与输出尾部；
 * 没有 onToggle 时退化为纯展示，避免在清单外误用。
 */
export function RuntimeStatusBadge({
  probe,
  testing = false,
  expanded = false,
  onToggle,
}: RuntimeStatusBadgeProps): ReactElement {
  if (testing) {
    return <span className={cn(pillCls, 'bg-primary/15 text-brand')}>测试中…</span>
  }

  if (probe === null) {
    return <span className={cn(pillCls, 'bg-accent text-faint-foreground')}>未检测</span>
  }

  if (probe.state === 'ready') {
    return (
      <span className={cn(pillCls, 'bg-success/10 text-success')}>可用 · {probe.elapsedMs}ms</span>
    )
  }

  const failCls = cn(pillCls, 'bg-destructive/10 text-destructive')
  const text = `不可用 · ${probe.elapsedMs}ms`
  const title = probe.error ?? '探测失败'

  if (!onToggle) {
    return (
      <span className={failCls} title={title}>
        {text}
      </span>
    )
  }

  return (
    <button
      type="button"
      aria-expanded={expanded}
      title={title}
      className={cn(
        failCls,
        'cursor-pointer transition-colors duration-200 outline-none',
        'hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/60',
      )}
      onClick={onToggle}
    >
      {text}
    </button>
  )
}
