import type { ComponentPropsWithRef, ReactElement } from 'react'
import { cn } from '../../lib/cn'

/**
 * 字段控件基础样式：控件圆角 6px、实心面板底、正文用 ink（不借父级透明度压暗），
 * 聚焦时描边加主色环。占位符用 ink-faint（≥4.5:1），不额外降透明度。
 */
export const fieldCls =
  'text-body w-full rounded-md border border-line bg-surface-2 px-3 text-ink caret-focus placeholder:text-ink-faint outline-none transition-colors duration-150 hover:border-line-strong focus:border-focus focus:ring-2 focus:ring-focus/25 disabled:cursor-not-allowed disabled:opacity-40'

/** 单行输入框样式 */
export const inputCls = `${fieldCls} h-9`

/** 带 `ref` 的输入属性：校验失败要把焦点移回出错字段，所以允许外部持有 ref */
export type InputProps = ComponentPropsWithRef<'input'>

/** 文本输入框：统一边框、圆角、留白与焦点环 */
export function Input({ className, ...props }: InputProps): ReactElement {
  return <input className={cn(inputCls, className)} {...props} />
}
