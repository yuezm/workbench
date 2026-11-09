import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useTheme, type ThemePreference } from '../../lib/theme'
import { Button } from './button'

/**
 * 主题切换器：图标按钮 + hover 浮层。
 *
 * - 触发器图标跟随「当前偏好」（亮色 = 太阳 / 暗色 = 月亮 / 跟随系统 = 显示器）。
 * - 浮层向下弹出（挂在顶部栏右侧，向下不遮内容），三个图标按钮即选即用。
 * - 鼠标移出后延迟关闭（`CLOSE_DELAY_MS`），给「从触发器移到浮层」的途中留余量。
 * - 键盘可达：触发器是按钮（Enter / Space 开关），浮层内按钮可 Tab 到，Esc 关闭。
 * - 视觉走语义 token（`bg-card` / `border-input/60`），不用玻璃拟态（SPEC-ui §6）。
 */

/** 三个偏好项：值、文案、图标 */
const OPTIONS: { value: ThemePreference; label: string; Icon: typeof SunIcon }[] = [
  { value: 'light', label: '亮色', Icon: SunIcon },
  { value: 'dark', label: '暗色', Icon: MoonIcon },
  { value: 'system', label: '跟随系统', Icon: MonitorIcon },
]

/** 偏好 → 图标：触发器图标跟随当前偏好（穷举映射，不留兜底分支） */
const ICON_BY_PREFERENCE: Record<ThemePreference, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
}

/** 触发器上的文案：把「偏好」说清楚，避免与浮层里的选项同名 */
const TRIGGER_LABEL: Record<ThemePreference, string> = {
  light: '主题：亮色',
  dark: '主题：暗色',
  system: '主题：跟随系统',
}

/** 移出后延迟关闭的毫秒数：鼠标从触发器移到浮层的途中不要误关 */
const CLOSE_DELAY_MS = 150

/**
 * 主题切换器（图标 + hover 浮层）。
 *
 * 无必需 props：主题状态直接来自 `useTheme()`。
 */
export function ThemeSwitcher(): ReactElement {
  const { preference, setPreference } = useTheme()
  /** 浮层是否展开 */
  const [open, setOpen] = useState(false)
  /** 待执行的关闭定时器：移出后延迟关闭，移回来就取消 */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 外层容器：既是浮层的定位基准，也是 hover 区域（含触发器与浮层） */
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  /** 取消待执行的关闭 */
  const cancelPendingClose = useCallback((): void => {
    if (closeTimer.current === null) return
    clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])

  /** 移出触发器或浮层：延迟关闭 */
  const scheduleClose = useCallback((): void => {
    cancelPendingClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [cancelPendingClose])

  // 卸载时清掉挂起的定时器，避免对已卸载组件 setState
  useEffect(() => cancelPendingClose, [cancelPendingClose])

  // Esc 关闭：浮层可能被 hover 打开（焦点不一定在组件内），因此挂在 document 上
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      cancelPendingClose()
      setOpen(false)
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [cancelPendingClose, open])

  /** 移入触发器或浮层：立即展开 */
  const openPanel = (): void => {
    cancelPendingClose()
    setOpen(true)
  }

  /** 选一项：立即生效并收起浮层 */
  const choose = (next: ThemePreference): void => {
    cancelPendingClose()
    setPreference(next)
    setOpen(false)
  }

  /** 点触发器：开 / 关（键盘可达的入口） */
  const toggle = (): void => {
    cancelPendingClose()
    setOpen((current) => !current)
  }

  const TriggerIcon = ICON_BY_PREFERENCE[preference]

  return (
    <div ref={rootRef} className="relative" onMouseEnter={openPanel} onMouseLeave={scheduleClose}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={TRIGGER_LABEL[preference]}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={TRIGGER_LABEL[preference]}
        onClick={toggle}
      >
        <TriggerIcon />
      </Button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="主题"
          onMouseEnter={cancelPendingClose}
          className="absolute top-full right-0 z-50 mt-1 flex items-center gap-0.5 rounded-lg border border-input/60 bg-card p-1 shadow-lg"
        >
          {OPTIONS.map(({ value, label, Icon }) => {
            const selected = value === preference
            return (
              <Button
                key={value}
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                aria-pressed={selected}
                title={label}
                className={cn(
                  selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
                onClick={() => choose(value)}
              >
                <Icon />
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
