import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactElement } from 'react'
import { cn } from '../../lib/cn'

const buttonVariants = cva(
  // 基座：统一的圆角、过渡、焦点环与禁用态
  cn(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl',
    'text-sm font-medium tracking-wide select-none',
    'transition-all duration-200 ease-out outline-none',
    'focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:ring-offset-2 focus-visible:ring-offset-abyss',
    'active:scale-[0.97]',
    'disabled:pointer-events-none disabled:opacity-40'
  ),
  {
    variants: {
      variant: {
        /** 主操作：极光渐变 + 同色辉光 */
        primary: cn(
          'bg-gradient-to-b from-focus to-focus-deep text-white',
          'shadow-[0_0_0_1px_rgb(255_255_255/12%)_inset,0_8px_24px_-8px_var(--color-focus)]',
          'hover:brightness-110 hover:shadow-[0_0_0_1px_rgb(255_255_255/18%)_inset,0_10px_32px_-6px_var(--color-focus)]'
        ),
        /** 次操作：玻璃面板 */
        secondary: cn(
          'bg-white/[0.04] text-ink ring-1 ring-line backdrop-blur-sm',
          'hover:bg-white/[0.08] hover:ring-line-strong'
        ),
        /** 弱操作：仅悬停显形 */
        ghost: 'text-ink-dim hover:bg-white/[0.06] hover:text-ink'
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 min-w-24 px-5',
        lg: 'h-11 min-w-28 px-7 text-[15px]'
      }
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md'
    }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps): ReactElement {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
