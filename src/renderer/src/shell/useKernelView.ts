import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ViewId, ViewParams, ViewResult } from '../../../protocol/views'
import { getKernelStore } from './kernelStore'

/**
 * 订阅一个内核视图（M5 D8）：组件不自己拼派生状态、不轮询、不重复订阅。
 *
 * - 首次挂载触发一次查询，事实批次到达后按失效表自动重取；
 * - `params` 用稳定键（JSON）比较，避免每次渲染都重新订阅；
 * - 未就绪时返回 `undefined`，组件按空态处理。
 */
export function useKernelView<T extends ViewId>(
  view: T,
  params?: ViewParams<T>,
): ViewResult<T> | undefined {
  const store = getKernelStore()
  const key = params === undefined ? '' : JSON.stringify(params)
  const stableParams = useMemo<ViewParams<T> | undefined>(
    () => (key === '' ? undefined : (JSON.parse(key) as ViewParams<T>)),
    [key],
  )

  const subscribe = useCallback(
    (onChange: () => void) => store.watch(view, stableParams, onChange),
    [store, view, stableParams],
  )
  const getSnapshot = useCallback(() => store.peek(view, stableParams), [store, view, stableParams])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
