import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ViewId, ViewParams, ViewResult } from '../../../protocol/views'
import { getKernelStore, type KernelViewState } from './kernelStore'

/** 未订阅状态：引用稳定，避免 useSyncExternalStore 每次渲染都拿到新对象。 */
const PENDING_STATE: KernelViewState<ViewId> = { data: undefined, error: null, loading: true }
const DISABLED_STATE: KernelViewState<ViewId> = { data: undefined, error: null, loading: false }

/**
 * 参数归一（M5）：`undefined` = 无参数视图；`null` = **暂不订阅**（id 还没选好）。
 * 用稳定键（JSON）比较，避免每次渲染都重新订阅。
 */
function useStableParams<T extends ViewId>(
  params?: ViewParams<T> | null,
): {
  enabled: boolean
  stableParams: ViewParams<T> | undefined
} {
  const enabled = params !== null
  const key = params === undefined || params === null ? '' : JSON.stringify(params)
  const stableParams = useMemo<ViewParams<T> | undefined>(
    () => (key === '' ? undefined : (JSON.parse(key) as ViewParams<T>)),
    [key],
  )
  return { enabled, stableParams }
}

/** 暂不订阅时的退订函数（引用稳定）。 */
const NOOP_UNSUBSCRIBE = (): void => {}

/**
 * 订阅一个内核视图（M5 D8）：组件不自己拼派生状态、不轮询、不重复订阅。
 *
 * - 首次挂载触发一次查询，事实批次到达后按失效表自动重取；
 * - `params` 传 `null` 表示「暂不订阅」（如尚未选中工作流），返回 `undefined`、不发查询；
 * - 未就绪时返回 `undefined`，组件按空态处理。
 */
export function useKernelView<T extends ViewId>(
  view: T,
  params?: ViewParams<T> | null,
): ViewResult<T> | undefined {
  const store = getKernelStore()
  const { enabled, stableParams } = useStableParams(params)
  const subscribe = useCallback(
    (onChange: () => void) =>
      enabled ? store.watch(view, stableParams, onChange) : NOOP_UNSUBSCRIBE,
    [store, view, stableParams, enabled],
  )
  const getSnapshot = useCallback(
    () => (enabled ? store.peek(view, stableParams) : undefined),
    [store, view, stableParams, enabled],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 带状态的内核视图订阅：`data` / `error` / `loading` 一起返回。
 *
 * 需要展示「读失败」的组件用这个（错误文案来自 transport，如命令/视图参数非法）；
 * 返回的 state 对象由 store 持有，同一状态重复渲染引用不变。
 * `params` 传 `null` 表示「暂不订阅」：返回空态（`loading=false`、无 error）。
 */
export function useKernelViewState<T extends ViewId>(
  view: T,
  params?: ViewParams<T> | null,
): KernelViewState<T> {
  const store = getKernelStore()
  const { enabled, stableParams } = useStableParams(params)
  const subscribe = useCallback(
    (onChange: () => void) =>
      enabled ? store.watch(view, stableParams, onChange) : NOOP_UNSUBSCRIBE,
    [store, view, stableParams, enabled],
  )
  const getSnapshot = useCallback(
    () =>
      enabled
        ? (store.peekState(view, stableParams) ?? (PENDING_STATE as KernelViewState<T>))
        : (DISABLED_STATE as KernelViewState<T>),
    [store, view, stableParams, enabled],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
