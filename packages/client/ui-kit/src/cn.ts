import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn/ui 同款类名合并：条件拼接 + 冲突去重。
 *
 * 字阶与文字颜色各归各的组：Tailwind v4 的原生档位（text-xs / text-sm /
 * text-base / text-lg）由 tailwind-merge 识别成 font-size，语义色
 * （text-foreground / text-muted-foreground / text-faint-foreground …）
 * 识别成 text-color，互不吃掉。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
