import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** 字段小标签：用次级前景（ink-dim），不再用最暗一级 */
export const labelCls = 'text-meta font-medium text-ink-dim'

export interface FieldProps {
  /** 小标签文案 */
  label: string
  /**
   * 必填标记：标题旁给红色星号 + 供读屏的「必填」。
   *
   * 必填字段也要能提交（空提交必须给 `error` 文案），不要靠「按钮灰着不响」表达必填：
   * 静默禁用与静默 return 是同一个毛病，用户看不出为什么点不动。
   */
  required?: boolean
  /** 常驻说明（填什么、可不可空），红色错误之外的那一层提示 */
  hint?: ReactNode
  /** 字段级错误：提交被拒时就地展示，`role="alert"` 让读屏播报 */
  error?: string | null
  className?: string
  labelClassName?: string
  children: ReactNode
}

/**
 * 字段包装：`<label>` 包裹控件 + 小标签 + 必填标记 + 说明 + 错误。
 *
 * 错误放在 `<label>` 内部的 `<span>`：保持「点标签聚焦控件」的行为不变，
 * 又不把块级元素塞进 label（label 只接受短语内容）。
 */
export function Field({
  label,
  required = false,
  hint,
  error,
  className,
  labelClassName,
  children,
}: FieldProps): ReactElement {
  const message = error ?? null
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className={cn('flex items-center gap-1', labelCls, labelClassName)}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-danger">
            *
          </span>
        )}
        {required && <span className="sr-only">必填</span>}
      </span>
      {children}
      {hint !== undefined && <span className="text-meta text-ink-faint">{hint}</span>}
      {message !== null && message !== '' && (
        <span role="alert" className="text-meta text-danger">
          {message}
        </span>
      )}
    </label>
  )
}
