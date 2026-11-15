import { useEffect, useSyncExternalStore, type ReactElement } from 'react'
import { cn } from '../../lib/cn'

/**
 * 轻提示（覆盖层组件，SPEC-ui §4）：动作做完后浮一句、约 2.4 秒自己消失，不看它也不耽误事。
 *
 * 为什么不复用 `FormError`：那是 `role="alert"` 的红色错误条。拿它报成功有三处不对——
 * 颜色说「出错了」、读屏以打断方式朗读一句「已保存 1 条连接」、而且只有点 × 才消失，
 * 于是一次已经做完的动作反倒要人再处理一次。成功 / 知会属于 M12 口径里的 `notice`：
 * 看一眼就过，不阻塞任何后续动作。错误仍然就地留在出错的地方（§11），不进这里。
 */

/** 语气：只分「做成了」与「就是知会一声」，不按主题/场景再开颜色 */
export type ToastTone = 'success' | 'info'

export interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

/** 停留时长：够读完一句话，又不至于在界面上赖着 */
const TOAST_MS = 2400

let seq = 0
let items: readonly ToastItem[] = []
const listeners = new Set<() => void>()

const emit = (next: readonly ToastItem[]): void => {
  items = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 快照身份必须稳定（`useSyncExternalStore` 每帧比对引用），所以只换数组、不重算 */
const snapshot = (): readonly ToastItem[] => items

/** 弹一条轻提示；返回 id，需要提前收掉时交给 `dismissToast`。空文案不弹（没有可告知的事）。 */
export function toast(text: string, tone: ToastTone = 'success'): number {
  seq += 1
  const id = seq
  const trimmed = text.trim()
  if (trimmed === '') return id
  emit([...items, { id, text: trimmed, tone }])
  return id
}

/** 收起一条（到点自动收，或调用方提前收）；id 不在列表里就什么都不做 */
export function dismissToast(id: number): void {
  emit(items.filter((item) => item.id !== id))
}

/** 清空：`ToastHost` 卸载时调用，免得模块级 store 把上一棵树的提示带到下一棵（测试之间也不互相带） */
function clearToasts(): void {
  if (items.length > 0) emit([])
}

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

const checkIcon = (
  <svg {...iconProps}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const infoIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </svg>
)

/** 语气 → 图标与着色；底色与正文一律用中性 token，靠图标说话（§3 主色只出现在强调位） */
const TONE: Record<ToastTone, { icon: typeof checkIcon; cls: string }> = {
  success: { icon: checkIcon, cls: 'text-success' },
  info: { icon: infoIcon, cls: 'text-info' },
}

function ToastRow({ item }: { item: ToastItem }): ReactElement {
  // 计时放组件里而不是 `toast()` 里：卸载时随 cleanup 一起清掉，不留孤立的定时器
  useEffect(() => {
    const timer = setTimeout(() => {
      dismissToast(item.id)
    }, TOAST_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [item.id])

  const tone = TONE[item.tone]

  return (
    <div
      role="status"
      className="flex max-w-[min(28rem,calc(100vw-3rem))] animate-rise items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-lg"
    >
      <span className={cn('shrink-0', tone.cls)}>{tone.icon}</span>
      <span className="min-w-0 break-words">{item.text}</span>
    </div>
  )
}

/**
 * 轻提示的落点：挂在 shell 根上一次（`Workbench`），所有 app 共用一条队列。
 *
 * 容器常驻而条目才增删——`aria-live` 的空区域之后插入文本才会被读屏播报；
 * 容器跟着条目一起挂载的话，第一条提示经常不会被读出来。
 */
export function ToastHost(): ReactElement {
  const current = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => clearToasts, [])
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2"
    >
      {current.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>
  )
}
