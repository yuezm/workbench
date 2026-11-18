import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@workbench/client-ui-kit/cn'

/**
 * 基座：shadcn/ui v4 switch（new-york-v4 基线，与 button / select 同源）。
 *
 * 只改 import 路径与 token 引用：`role="switch"` + `aria-checked` + 键盘（Space / Enter）
 * 全归 Radix，调用点不再自己拼「圆底 + 圆点 + translate」那套开关。
 * `rounded-full` 是上游写法，`check:ui` 只拦把按钮/输入做成胶囊的情况。
 *
 * 轨道高度按 20px（`h-5`）而不是上游的 1.15rem(18.4px)：18.4px 高低于
 * `tests/e2e/ui-geometry.spec.ts` 的点击目标门槛（< 20px 判 `tiny-target`），
 * 开关是全列表最常点的小控件，点不准是缺陷不是克制。宽度 32px 不变，视觉差异 1.6px。
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform',
          'data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
