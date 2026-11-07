import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** 字段小标签：用次级前景（ink-dim），不再用最暗一级 */
export const labelCls = 'text-[11px] font-medium tracking-wide text-ink-dim'

export interface FieldProps {
  /** 小标签文案 */
  label: string
  className?: string
  labelClassName?: string
  children: ReactNode
}

/** 字段包装：`<label>` 包裹控件 + 小标签，让各表单排版统一 */
export function Field({ label, className, labelClassName, children }: FieldProps): ReactElement {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className={cn(labelCls, labelClassName)}>{label}</span>
      {children}
    </label>
  )
}
