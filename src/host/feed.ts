/**
 * 事实推送（M5 D7）：提交后把「发生了什么」批量推给 renderer。
 *
 * - 事实批次：`{kind:'facts', seq, types}`；`seq` = 批内最后一条事实的 seq，
 *   `types` 去重。批次上限 500 条事实或 16 ms，先到者（SPEC-host「续传顺序」）。
 * - 聊天流：`stream` / `stream-end` 即时旁路，不进批次（只影响实时显示，事实仍是数据源）。
 * - 订阅者异常互相隔离：一个窗口崩了不影响其它窗口，更不影响写路径。
 */
import type { FactsEvent, KernelEvent } from '../protocol/ipc'
import type { FactType } from '../protocol/facts'
import type { Fact } from '../kernel/core/types'

/** 批次上限：超过立即 flush（与 SPEC-host 的 500 条一致）。 */
export const MAX_FACTS_PER_BATCH = 500
/** 批次窗口：16 ms。 */
export const BATCH_WINDOW_MS = 16

export interface FactFeedOptions {
  /** 定时器注入（测试用假时钟）；默认宿主 setTimeout/clearTimeout。 */
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** 批次窗口毫秒；默认 16。 */
  windowMs?: number
  /** 单批事实上限；默认 500。 */
  maxPerBatch?: number
}

export interface FactFeed {
  /** 提交后调用：事实进批次（异步 flush）。 */
  publish(facts: readonly Fact[]): void
  /** 聊天流旁路：立即推送。 */
  stream(event: KernelEvent): void
  /** 订阅推送；返回退订。 */
  subscribe(listener: (event: KernelEvent) => void): () => void
  /** 立即 flush 未发送的批次（测试与退出前用）。 */
  flush(): void
  /** 停表并清空订阅。 */
  stop(): void
}

export function createFactFeed(options: FactFeedOptions = {}): FactFeed {
  const windowMs = options.windowMs ?? BATCH_WINDOW_MS
  const maxPerBatch = options.maxPerBatch ?? MAX_FACTS_PER_BATCH
  const schedule =
    options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const cancel =
    options.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const listeners = new Set<(event: KernelEvent) => void>()
  let pendingSeq = 0
  let pendingCount = 0
  const pendingTypes = new Set<FactType>()
  let timer: unknown = null

  const deliver = (event: KernelEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // 订阅者异常隔离（窗口销毁/渲染进程失效都不影响其它订阅者）
      }
    }
  }

  const flush = (): void => {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
    if (pendingCount === 0) return
    const event: FactsEvent = {
      kind: 'facts',
      seq: pendingSeq,
      types: [...pendingTypes],
    }
    pendingSeq = 0
    pendingCount = 0
    pendingTypes.clear()
    deliver(event)
  }

  const arm = (): void => {
    if (timer !== null) return
    timer = schedule(() => {
      timer = null
      flush()
    }, windowMs)
  }

  return {
    publish: (facts) => {
      if (facts.length === 0) return
      for (const fact of facts) {
        pendingCount += 1
        pendingSeq = fact.seq
        pendingTypes.add(fact.type)
      }
      if (pendingCount >= maxPerBatch) flush()
      else arm()
    },
    stream: deliver,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    flush,
    stop: () => {
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
      listeners.clear()
      pendingCount = 0
      pendingSeq = 0
      pendingTypes.clear()
    },
  }
}
