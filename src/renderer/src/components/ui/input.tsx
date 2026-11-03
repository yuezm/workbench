import type { InputHTMLAttributes, ReactElement } from 'react'
import { cn } from '../../lib/cn'

/** 字段控件基础样式：边框、底色、悬停与焦点态 */
export const fieldCls =
  'w-full rounded-lg border border-line bg-black/25 px-3 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors duration-200 hover:border-line-strong focus:border-focus/70 focus:bg-black/35 disabled:cursor-not-allowed disabled:opacity-40'

/** 单行输入框样式 */
export const inputCls = `${fieldCls} h-9`

export type InputProps = InputHTMLAttributes<HTMLInputElement>

/** 文本输入框：统一边框、圆角、留白与焦点环 */
export function Input({ className, ...props }: InputProps): ReactElement {
  return <input className={cn(inputCls, className)} {...props} />
}
