import type { ReactElement } from 'react'
import { cn } from '../../lib/cn'

const closeIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export interface FormErrorProps {
  /** 文案；`null` / `undefined` / 空串不渲染（调用方不必自己写条件） */
  message: string | null | undefined
  /** 关闭按钮：只有可清空的「写命令失败」才给，读视图错误不该被关掉 */
  onDismiss?: () => void
  className?: string
}

/**
 * 统一的错误条：`role="alert"` + 危险色 token（`text-destructive` / `border-destructive/30` / `bg-destructive/10`）。
 *
 * 全站错误文案只走这一个组件：之前每处各写一遍 `<p className="...red-400/30...">`，
 * 一半忘了 `role="alert"`，读屏与测试都抓不到；样式也散成了调色板外的色值。
 */
export function FormError({ message, onDismiss, className }: FormErrorProps): ReactElement | null {
  if (message === null || message === undefined || message === '') return null
  return (
    <p
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        className,
      )}
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss !== undefined && (
        <button
          type="button"
          aria-label="关闭错误提示"
          className="grid size-5 shrink-0 place-items-center rounded-sm text-destructive transition-colors duration-150 hover:bg-destructive/20"
          onClick={onDismiss}
        >
          {closeIcon}
        </button>
      )}
    </p>
  )
}
