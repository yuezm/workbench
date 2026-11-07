import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactElement } from 'react'
import { cn } from '../../lib/cn'

const buttonVariants = cva(
  // 基座：控件圆角（6px）、过渡、焦点环与禁用态
  cn(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md',
    'text-sm font-medium tracking-wide select-none',
    'transition-colors duration-150 ease-out outline-none',
    'focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:ring-offset-2 focus-visible:ring-offset-abyss',
    'disabled:pointer-events-none disabled:opacity-40',
  ),
  {
    variants: {
      variant: {
        /** 主操作：实心靛蓝（白字 6.3:1），不再用渐变与辉光 */
        primary:
          'bg-focus-deep text-white shadow-[0_1px_2px_rgb(0_0_0/45%)] hover:bg-focus active:bg-focus-deep',
        /** 次操作：中性面板 */
        secondary:
          'bg-surface-2 text-ink ring-1 ring-line hover:bg-surface-3 hover:ring-line-strong',
        /** 弱操作：仅悬停显形 */
        ghost: 'text-ink-dim hover:bg-white/[0.06] hover:text-ink',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-4',
        lg: 'h-10 px-5 text-[15px]',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps): ReactElement {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
