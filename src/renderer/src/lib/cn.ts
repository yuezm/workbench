import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 同款类名合并：条件拼接 + 冲突去重 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
