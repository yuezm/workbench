import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'

/** 下拉项 */
export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  /** 无障碍名称（触发器 aria-label） */
  ariaLabel: string
  /** 没有匹配项时显示的占位文案 */
  placeholder?: string
  className?: string
  disabled?: boolean
}

/** 浮层位置（视口坐标，fixed 定位） */
interface PopupPosition {
  left: number
  top: number
  width: number
  maxHeight: number
}

/** 浮层最小宽度：触发器很窄时（如工具条内的选择器）也要放得下选项文字 */
const MIN_POPUP_WIDTH = 180

/** 第一个可用项下标 */
function firstEnabled(options: SelectOption[]): number {
  return options.findIndex((o) => !o.disabled)
}

/** 最后一个可用项下标 */
function lastEnabled(options: SelectOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i].disabled) return i
  }
  return -1
}

/** 从 start 出发按 step 找下一个可用项；start < 0 时取首/尾可用项 */
function nextEnabled(options: SelectOption[], start: number, step: number): number {
  const n = options.length
  if (n === 0) return -1
  if (start < 0) return step > 0 ? firstEnabled(options) : lastEnabled(options)
  for (let i = 1; i <= n; i++) {
    const idx = (start + step * i + n * 2) % n
    if (!options[idx].disabled) return idx
  }
  return -1
}

function ChevronIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function CheckIcon(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-focus"
    >
      <path d="m5 13 4 4 10-10" />
    </svg>
  )
}

/**
 * 自研下拉框（不使用原生 select，原生控件在 Windows 上观感与交互都不达标）。
 *
 * - 触发器与输入框同款外观；浮层用 fixed 定位，由触发器 getBoundingClientRect 计算，
 *   不受父级 overflow-hidden 裁剪；窗口 resize/scroll 时关闭。
 * - 键盘：Enter/Space 打开，↑/↓ 移动高亮，Enter 选中，Esc 关闭。
 */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = '请选择',
  className,
  disabled = false,
}: SelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<PopupPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const selectedIndex = options.findIndex((o) => o.value === value)
  const displayText = selectedIndex >= 0 ? options[selectedIndex].label : placeholder

  const optionId = useCallback(
    (index: number): string => `${listboxId}-option-${index}`,
    [listboxId],
  )

  const computePosition = useCallback((rect: DOMRect): PopupPosition => {
    const gap = 8
    const width = Math.max(rect.width, MIN_POPUP_WIDTH)
    return {
      left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
      top: rect.bottom + gap,
      width,
      maxHeight: 320,
    }
  }, [])

  /** 浮层渲染后按实际高度贴合触发器：下方放不下就上翻 */
  const reposition = useCallback((): void => {
    const trigger = triggerRef.current
    const popup = popupRef.current
    if (!trigger || !popup) return
    const rect = trigger.getBoundingClientRect()
    const gap = 8
    const spaceBelow = window.innerHeight - rect.bottom - gap
    const spaceAbove = rect.top - gap
    // jsdom 等无布局环境拿不到 offsetHeight，退化为按选项数估算
    const estimated = options.length * 34 + 10
    const measured = popup.offsetHeight
    const needed = measured > 0 ? measured : estimated
    const flip = needed > spaceBelow && spaceAbove > spaceBelow
    const maxHeight = Math.max(60, Math.min(320, flip ? spaceAbove : spaceBelow))
    const height = Math.min(needed, maxHeight)
    const width = Math.max(rect.width, MIN_POPUP_WIDTH)
    setPosition({
      left: Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)),
      top: flip ? rect.top - gap - height : rect.bottom + gap,
      width,
      maxHeight,
    })
  }, [options.length])

  const openMenu = useCallback(
    (rect: DOMRect, direction: 1 | -1 = 1): void => {
      const active =
        selectedIndex >= 0
          ? selectedIndex
          : direction > 0
            ? firstEnabled(options)
            : lastEnabled(options)
      setPosition(computePosition(rect))
      setActiveIndex(active)
      setOpen(true)
    },
    [computePosition, options, selectedIndex],
  )

  const closeMenu = useCallback((): void => {
    setOpen(false)
    setPosition(null)
  }, [])

  const choose = useCallback(
    (option: SelectOption): void => {
      if (option.disabled) return
      onChange(option.value)
      closeMenu()
      triggerRef.current?.focus()
    },
    [closeMenu, onChange],
  )

  // 浮层渲染后按实际高度贴合触发器（下方放不下则上翻）
  useLayoutEffect(() => {
    if (!open) return
    reposition()
  }, [open, options.length, reposition])

  // 高亮项滚入可视区
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const el = document.getElementById(optionId(activeIndex))
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open, optionId])

  // 点击浮层外部关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      closeMenu()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [closeMenu, open])

  // 视口尺寸变化或滚动时关闭，避免浮层与触发器错位
  useEffect(() => {
    if (!open) return
    const onViewportChange = (): void => closeMenu()
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [closeMenu, open])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        if (!open) {
          openMenu(event.currentTarget.getBoundingClientRect(), step)
          return
        }
        setActiveIndex((cur) => nextEnabled(options, cur, step))
        return
      }
      case 'Home':
      case 'End': {
        if (!open) return
        event.preventDefault()
        setActiveIndex(event.key === 'Home' ? firstEnabled(options) : lastEnabled(options))
        return
      }
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault()
        if (!open) {
          openMenu(event.currentTarget.getBoundingClientRect())
          return
        }
        const option = options[activeIndex]
        if (option) choose(option)
        return
      }
      case 'Escape': {
        if (!open) return
        event.preventDefault()
        closeMenu()
        return
      }
      case 'Tab': {
        if (open) closeMenu()
        return
      }
      default:
    }
  }

  const popup =
    open && position
      ? createPortal(
          <div
            ref={popupRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: 'fixed',
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            className="z-50 animate-rise overflow-y-auto rounded-xl border border-line-strong/50 bg-surface/95 p-1 shadow-[0_24px_60px_-24px_rgb(0_0_0/85%)] backdrop-blur-xl"
          >
            {options.map((option, index) => {
              const selected = option.value === value
              const active = index === activeIndex
              return (
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled ? true : undefined}
                  // 阻止默认行为，避免鼠标点击选项时焦点离开触发器（键盘导航随之失效）
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(option)}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150',
                    option.disabled
                      ? 'cursor-not-allowed text-ink-faint opacity-50'
                      : cn(
                          'cursor-pointer text-ink-dim hover:bg-white/[0.06] hover:text-ink',
                          active && 'bg-white/[0.06] text-ink',
                          selected && 'text-ink',
                        ),
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {selected && <CheckIcon />}
                </div>
              )
            })}
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        // 与原生 select 一致：触发器上暴露当前选中项的 value
        value={value}
        disabled={disabled}
        onClick={(event) => {
          if (open) {
            closeMenu()
            return
          }
          openMenu(event.currentTarget.getBoundingClientRect())
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-black/25 px-3 text-left text-sm text-ink',
          'transition-colors duration-200 outline-none hover:border-line-strong focus:border-focus/70 focus:bg-black/35',
          'disabled:cursor-not-allowed disabled:opacity-40',
          className,
        )}
      >
        <span className={cn('truncate', selectedIndex < 0 && 'text-ink-faint')}>{displayText}</span>
        <ChevronIcon
          className={cn(
            'shrink-0 text-ink-faint transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>
      {popup}
    </>
  )
}
