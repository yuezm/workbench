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
import { Button, type ButtonProps } from './button'

/** 菜单里的一项：标题 + 可选徽标与第二行说明 */
export interface MenuItem {
  /** 渲染用的稳定键 */
  id: string
  label: string
  /** 第二行说明（次要文字） */
  description?: string
  /** 标题行尾的徽标（计数等） */
  badge?: string
  /** 无障碍名称；给了就替代「标题 + 徽标 + 说明」拼出的文本，便于表达动作语义 */
  ariaLabel?: string
  onSelect: () => void
}

export interface MenuSection {
  /** 分组标题（可省） */
  title?: string
  items: MenuItem[]
}

export interface MenuProps {
  /** 触发器文字 */
  label: string
  /** 触发器无障碍名称（默认同 `label`） */
  ariaLabel?: string
  variant?: ButtonProps['variant']
  sections: MenuSection[]
}

/** 浮层位置（视口坐标，fixed 定位） */
interface PopupPosition {
  left: number
  top: number
  width: number
  maxHeight: number
}

/** 菜单最小宽度：条目带说明文字，太窄会折成两行 */
const MIN_MENU_WIDTH = 280
/** 菜单最大高度：条目多时内部滚动（滚轮仍在菜单里，不能连带页面滚动） */
const MAX_MENU_HEIGHT = 480
/** 无布局环境（jsdom）下按行数估算高度用的单行高度与内边距 */
const ROW_HEIGHT = 56
const POPUP_PADDING = 16
/** 触发器与浮层之间的间距 */
const GAP = 8

function ChevronIcon({ open }: { open: boolean }): ReactElement {
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
      className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** 浮层宽度与水平位置：靠触发器右缘对齐，向左展开，不出视口 */
function placeLeft(rect: DOMRect, width: number): number {
  return Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
}

/**
 * 锚定在按钮上的下拉菜单。
 *
 * 用途是「一个按钮，多种建法」：点开先在条目里选要哪一种，选中即回调并收起。
 * - 浮层用 `fixed` 定位（由触发器 `getBoundingClientRect` 计算），不受父级 `overflow` 裁剪；
 *   渲染后再按实际高度决定是否上翻。窗口 resize / 滚动时关闭。
 * - 分组只影响视觉，键盘按扁平顺序走：↑/↓ 打开并移动高亮、Enter 选中、Esc/Tab 收起。
 * - 焦点留在触发器上（选项 `onMouseDown` 不让焦点跑掉），与 `Select` 一致。
 */
export function Menu({
  label,
  ariaLabel,
  variant = 'secondary',
  sections,
}: MenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  /** 当前高亮项在扁平列表里的下标；-1 = 无高亮（条目为空） */
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<PopupPosition | null>(null)
  /** 触发器外的包裹层：判断「点击在外部」时连按钮一起算进来 */
  const rootRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  /** 打开时的触发器矩形：浮层渲染后按它贴合（触发器是 Button，取不到 ref 就只能留住矩形） */
  const anchorRef = useRef<DOMRect | null>(null)
  const menuId = useId()

  const items = sections.flatMap((section) => section.items)
  const count = items.length
  const itemId = (index: number): string => `${menuId}-item-${index}`
  /** 打开时的初始高亮：有条目落在首项，没有条目即无高亮（-1） */
  const firstIndex = count > 0 ? 0 : -1
  const lastIndex = count - 1

  const closeMenu = useCallback((): void => {
    setOpen(false)
    setPosition(null)
    setActiveIndex(-1)
  }, [])

  /** 浮层渲染后按实际高度贴合触发器：下方放不下就上翻 */
  const reposition = useCallback((): void => {
    // 只在浮层打开时调用：anchorRef 由 openMenu 写入
    const rect = anchorRef.current as DOMRect
    const popup = popupRef.current as HTMLDivElement
    const spaceBelow = window.innerHeight - rect.bottom - GAP
    const spaceAbove = rect.top - GAP
    // jsdom 等无布局环境拿不到 offsetHeight，退化为按条目数估算
    const measured = popup.offsetHeight
    const needed = measured > 0 ? measured : count * ROW_HEIGHT + POPUP_PADDING
    const flip = needed > spaceBelow && spaceAbove > spaceBelow
    const maxHeight = Math.max(60, Math.min(MAX_MENU_HEIGHT, flip ? spaceAbove : spaceBelow))
    const height = Math.min(needed, maxHeight)
    const width = Math.max(rect.width, MIN_MENU_WIDTH)
    setPosition({
      left: placeLeft(rect, width),
      top: flip ? rect.top - GAP - height : rect.bottom + GAP,
      width,
      maxHeight,
    })
  }, [count])

  const openMenu = useCallback((active: number, rect: DOMRect): void => {
    const width = Math.max(rect.width, MIN_MENU_WIDTH)
    anchorRef.current = rect
    setActiveIndex(active)
    setPosition({
      left: placeLeft(rect, width),
      top: rect.bottom + GAP,
      width,
      maxHeight: MAX_MENU_HEIGHT,
    })
    setOpen(true)
  }, [])

  const choose = (index: number): void => {
    const item = items[index] as MenuItem | undefined
    if (item === undefined) return
    closeMenu()
    item.onSelect()
  }

  /**
   * 在扁平列表里移动高亮并环绕。打开时高亮一定落在 `[0, count-1]`（openMenu 落首/末项，
   * 鼠标悬停落具体项），所以不必再从 -1 起步；条目为空时没有可移动的目标。
   */
  const moveActive = (step: 1 | -1): void => {
    if (count === 0) return
    setActiveIndex((activeIndex + step + count) % count)
  }

  // 浮层渲染后按实际高度贴合触发器（下方放不下则上翻）
  useLayoutEffect(() => {
    if (!open) return
    reposition()
  }, [open, count, reposition])

  // 高亮项滚入可视区
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const el = document.getElementById(`${menuId}-item-${activeIndex}`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, menuId, open])

  // 点击浮层与触发器之外的区域关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || popupRef.current?.contains(target)) return
      closeMenu()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [closeMenu, open])

  // 视口尺寸变化或「浮层外」的滚动会让浮层与触发器错位，直接收起；
  // 浮层内部滚动（条目多于可视高度）必须放行——否则滚轮一动菜单就消失，选不到下面的条目。
  useEffect(() => {
    if (!open) return
    const onResize = (): void => closeMenu()
    const onScroll = (event: Event): void => {
      const target = event.target as Node | null
      if (target instanceof Node && popupRef.current?.contains(target)) return
      closeMenu()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [closeMenu, open])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        if (!open) {
          // 打开时高亮落在首项（↓）或末项（↑）
          openMenu(step > 0 ? firstIndex : lastIndex, event.currentTarget.getBoundingClientRect())
          return
        }
        moveActive(step)
        return
      }
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        // 收起状态交给按钮的默认点击行为（开/关），这里只管「已打开时选中」
        if (!open) return
        event.preventDefault()
        choose(activeIndex)
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

  // 分组只影响视觉：条目下标按「前面各组的条目数之和」偏移，键盘走同一套扁平顺序
  const groupStarts = sections.map((_, index) =>
    sections.slice(0, index).reduce((sum, section) => sum + section.items.length, 0),
  )

  const popup =
    open && position
      ? createPortal(
          <div
            ref={popupRef}
            id={menuId}
            role="menu"
            aria-label={ariaLabel ?? label}
            style={{
              position: 'fixed',
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            className="z-50 animate-rise overflow-y-auto overscroll-contain rounded-lg border border-line-strong/60 bg-surface p-1 shadow-[0_24px_60px_-24px_rgb(0_0_0/90%)]"
          >
            {sections.map((section, sectionIndex) => (
              <div
                key={section.title ?? `section-${sectionIndex}`}
                role="group"
                aria-label={section.title}
              >
                {section.title !== undefined && (
                  <div className="px-2.5 pt-2 pb-1 text-[11px] tracking-wide text-ink-faint">
                    {section.title}
                  </div>
                )}
                {section.items.map((item, offset) => {
                  const index = groupStarts[sectionIndex] + offset
                  return (
                    <div
                      key={item.id}
                      id={itemId(index)}
                      role="menuitem"
                      aria-label={item.ariaLabel}
                      aria-current={index === activeIndex ? true : undefined}
                      // 阻止默认行为，避免鼠标点击选项时焦点离开触发器（键盘导航随之失效）
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(index)}
                      className={cn(
                        'flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 transition-colors duration-150',
                        index === activeIndex ? 'bg-surface-3' : 'hover:bg-white/[0.06]',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{item.label}</span>
                        {item.badge !== undefined && (
                          <span className="shrink-0 rounded-sm bg-white/[0.07] px-1.5 py-0.5 text-[10px] text-ink-dim tabular-nums">
                            {item.badge}
                          </span>
                        )}
                      </span>
                      {item.description !== undefined && (
                        <span className="text-[11px] leading-relaxed text-ink-dim">
                          {item.description}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>,
          document.body,
        )
      : null

  return (
    <div ref={rootRef} className="inline-flex">
      <Button
        variant={variant}
        size="sm"
        aria-label={ariaLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? itemId(activeIndex) : undefined}
        onClick={(event) => {
          if (open) {
            closeMenu()
            return
          }
          openMenu(firstIndex, event.currentTarget.getBoundingClientRect())
        }}
        onKeyDown={handleKeyDown}
      >
        {label}
        <ChevronIcon open={open} />
      </Button>
      {popup}
    </div>
  )
}
