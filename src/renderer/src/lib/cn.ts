import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * 字阶 token（page/title/body/action/meta/badge）在 `text-*` 命名空间里与文字颜色同名，
 * tailwind-merge 默认会把 `text-body` 当成颜色类，后出现的 `text-ink` 就把它整条删掉。
 * 这里把六档显式登记为 font-size 组，字号与颜色各归各的组，互不吃掉。
 */
const TYPE_SCALE = ['page', 'title', 'body', 'action', 'meta', 'badge'] as const

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...TYPE_SCALE] }],
    },
  },
})

/** shadcn/ui 同款类名合并：条件拼接 + 冲突去重 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
