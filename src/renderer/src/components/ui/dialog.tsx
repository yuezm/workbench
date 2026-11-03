import { useEffect, type ReactElement, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { panelCls } from './panel'

export interface DialogProps {
  /** 标题栏文本；不传则不渲染标题栏（内容自带标题时用） */
  title?: ReactNode
  /** Esc 与右上角关闭按钮都走它 */
  onClose: () => void
  children: ReactNode
  className?: string
}

function CloseIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

/** 居中模态：遮罩 + Esc 关闭 + 右上角关闭按钮 */
export function Dialog({ title, onClose, children, className }: DialogProps): ReactElement {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          panelCls,
          'max-h-[85vh] w-full max-w-lg overflow-auto bg-surface/95 p-5',
          'shadow-[0_30px_80px_-30px_rgb(0_0_0/85%)]',
          className,
        )}
      >
        {title !== undefined && (
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-ink">{title}</h2>
            <button
              type="button"
              aria-label="关闭"
              className="grid size-7 place-items-center rounded-lg text-ink-faint transition-colors duration-200 hover:bg-white/[0.06] hover:text-ink"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
