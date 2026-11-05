/**
 * 宿主唯一定时器（SPEC-host「clock」）：只挂一个 `setTimeout`，按内核 `nextWakeAt` 排期。
 *
 * - `start()`：按 `store.nextWakeAt(now)` 排下一跳；到点 `dispatch({type:'clock.tick'})`
 *   后重新排期。
 * - `wake()`：effects / 调度器可提前唤醒：立即跑一次 tick 再重排。
 * - `rearm()`：不 tick、只按最新视图重排——调度器在 run 领取 / 收尾 / 取消后调用，
 *   把新出现的租约与超时纳入唯一定时器。
 * - `stop()`：取消定时器（退出 / 测试）。
 * - `nextAt()`：诊断用，返回当前已排期的目标时刻（未排期 null）。
 *
 * 每次 tick（dispatch 之后）都调用注入的 `onTick`，**即使本轮零事实**：退避到期的
 * `queued` run 不需要内核产事实，但调度器必须被唤醒去领取（T10 接 scheduler.wake）。
 *
 * 窗口不可见不降频：本模块不感知窗口状态，托盘常驻时照常排期。
 * 定时器与当前时刻都可注入，测试用假时钟推进。
 */
import type { Iso } from '../kernel/types'
import type { Store } from './store/index'

/** 定时器抽象：默认系统 `setTimeout` / `clearTimeout`，测试注入假实现。 */
export interface ClockTimer {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** clock 只依赖 store 的这两个方法（真实 `Store` 结构上满足）。 */
export type ClockStore = Pick<Store, 'dispatch' | 'nextWakeAt'>

export interface ClockOptions {
  store: ClockStore
  /** 当前时刻（ISO）：与 store 注入的 `now` 保持一致，测试用假时钟。 */
  now: () => Iso
  /** 每次 tick 之后调用（即使零事实）：T10 接 `scheduler.wake()`。 */
  onTick: () => void
  /** 定时器注入；缺省用系统实现。 */
  timer?: ClockTimer
}

export interface Clock {
  start(): void
  stop(): void
  wake(): void
  /**
   * 只按当前视图重排下一跳，不立即 tick：run 领取 / 收尾 / 取消后由调度器调用，
   * 把新出现的 `leaseUntil` / `deadlineAt` / `notBefore` 纳入定时器；否则启动之后
   * 才出现的 run 永远等不到租约回收与超时。
   */
  rearm(): void
  nextAt(): Iso | null
}

const systemTimer: ClockTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createClock(options: ClockOptions): Clock {
  const { store, now, onTick } = options
  const timer = options.timer ?? systemTimer

  let started = false
  let handle: unknown = null
  let scheduledAt: Iso | null = null

  const cancel = (): void => {
    if (handle === null) return
    timer.clearTimeout(handle)
    handle = null
  }

  /** 一次 tick：dispatch 之后无论成败/是否有事实都回调 onTick。 */
  const tick = (): void => {
    try {
      store.dispatch({ type: 'clock.tick' })
    } finally {
      onTick()
    }
  }

  function fire(): void {
    handle = null
    try {
      tick()
    } finally {
      schedule()
    }
  }

  /** 计算并排下一跳；没有到期时刻就不挂定时器（不空转）。 */
  function schedule(): void {
    cancel()
    scheduledAt = null
    if (!started) return
    const current = now()
    const at = store.nextWakeAt(current)
    if (at === null) return
    scheduledAt = at
    handle = timer.setTimeout(fire, Math.max(0, Date.parse(at) - Date.parse(current)))
  }

  return {
    start: () => {
      started = true
      schedule()
    },
    stop: () => {
      started = false
      cancel()
      scheduledAt = null
    },
    wake: () => {
      // 提前唤醒：先取消旧排期，跑一次 tick，再按最新视图重排
      cancel()
      scheduledAt = null
      try {
        tick()
      } finally {
        schedule()
      }
    },
    rearm: () => {
      if (!started) return
      schedule()
    },
    nextAt: () => scheduledAt,
  }
}
