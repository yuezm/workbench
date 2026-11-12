import type { KeyboardEvent, ReactElement } from 'react'
import { GripVerticalIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

interface SortHandleProps {
  /** 无障碍名：写成「拖动排序：<对象名>」，让读屏用户知道这一行被拖的是什么 */
  label: string
  /** 键盘 ↑：到头（首行 / 用户区块首条）时传 undefined，按键不响应也不阻断默认行为 */
  onMoveUp?: () => void
  /** 键盘 ↓：同上，到末行时传 undefined */
  onMoveDown?: () => void
  className?: string
}

/**
 * 拖拽排序抓手（覆盖层组件，SPEC-ui §4）。
 *
 * 鼠标路径靠整行的 HTML5 拖拽（`useRowDrag`），这个图标只负责「看起来能拖」；
 * 键盘路径留在这里：原生拖拽不可键盘操作，所以抓手聚焦后按 ↑ / ↓ 挪一格——
 * 去掉了行内箭头按钮，排序的可操作性不能因此只剩鼠标。
 */
export function SortHandle({
  label,
  onMoveUp,
  onMoveDown,
  className,
}: SortHandleProps): ReactElement {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowUp' && onMoveUp) {
      event.preventDefault()
      onMoveUp()
      return
    }
    if (event.key === 'ArrowDown' && onMoveDown) {
      event.preventDefault()
      onMoveDown()
    }
  }

  return (
    <button
      // 阶段列表在 <form> 里：抓手不能顺手提交表单
      type="button"
      aria-label={label}
      title="拖动调整顺序（聚焦后按 ↑ / ↓ 也能移动）"
      onKeyDown={onKeyDown}
      className={cn(
        'grid size-6 shrink-0 cursor-grab place-items-center rounded-md text-faint-foreground transition-colors duration-150 outline-none',
        'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:cursor-grabbing',
        className,
      )}
    >
      <GripVerticalIcon className="size-4" />
    </button>
  )
}
