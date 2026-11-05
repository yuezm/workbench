import type { Command } from '../../../src/protocol/commands'
import type { CommandDispatchResult, KernelEvent } from '../../../src/protocol/ipc'
import type { FactType } from '../../../src/protocol/facts'
import type { ViewId, ViewParams, ViewResult } from '../../../src/protocol/views'
import {
  configureKernel,
  resetKernelForTest,
  viewKey,
  type KernelStore,
  type KernelTransport,
} from '../../../src/renderer/src/shell/kernelStore'

/**
 * renderer 组件测试的内核替身（M5）：
 *
 * - 内存视图表 + 单订阅；`setView` 后按事实批次失效，组件经 `useKernelView` 重取；
 * - `dispatch` 默认零事实成功，可注入按命令返回的事实/实体；
 * - 每个用例结束调用 `stopFakeKernel()`（或 beforeEach 重新装）。
 */
export interface FakeKernel {
  store: KernelStore
  /** 更新一个视图值并广播一次「未知事实」批次（全量失效，测试里最省心） */
  setView<T extends ViewId>(view: T, params: ViewParams<T> | undefined, value: ViewResult<T>): void
  /** 直接推一个事实批次（按 types 走失效表） */
  pushFacts(types: FactType[]): void
  /** 推一条聊天流事件 */
  pushStream(event: KernelEvent): void
  /** 注入 dispatch 行为；缺省零事实成功 */
  onDispatch(
    handler: <C extends Command>(
      command: C,
    ) => Promise<CommandDispatchResult<C>> | CommandDispatchResult<C>,
  ): void
  /** 记录的 dispatch 调用（按顺序） */
  dispatched: Command[]
}

export function installFakeKernel(): FakeKernel {
  const viewValues = new Map<string, unknown>()
  const dispatched: Command[] = []
  let seq = 0
  let handler: ((event: KernelEvent) => void) | null = null
  let dispatchHandler:
    | (<C extends Command>(
        command: C,
      ) => Promise<CommandDispatchResult<C>> | CommandDispatchResult<C>)
    | null = null

  const transport: KernelTransport = {
    dispatch: <C extends Command>(command: C): Promise<CommandDispatchResult<C>> => {
      dispatched.push(command)
      const result = dispatchHandler
        ? dispatchHandler(command)
        : ({
            facts: [],
            value: null,
          } as CommandDispatchResult<C>)
      return Promise.resolve(result) as Promise<CommandDispatchResult<C>>
    },
    query: <T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>> => {
      if (view === 'kernel.seq') return Promise.resolve(seq as ViewResult<T>)
      return Promise.resolve(
        viewValues.get(viewKey(view, params as ViewParams<ViewId>)) as ViewResult<T>,
      )
    },
    subscribe: (cb) => {
      handler = cb
      return () => {
        handler = null
      }
    },
  }

  const store = configureKernel(transport)

  const emitFacts = (types: FactType[]): void => {
    seq += 1
    const event: KernelEvent = { kind: 'facts', seq, types }
    handler?.(event)
    store.applyEvent(event)
  }

  return {
    store,
    setView: (view, params, value) => {
      viewValues.set(viewKey(view, params as ViewParams<ViewId> | undefined), value)
      emitFacts(['snapshot.imported'])
    },
    pushFacts: emitFacts,
    pushStream: (event) => {
      handler?.(event)
      store.applyEvent(event)
    },
    onDispatch: (next) => {
      dispatchHandler = next
    },
    dispatched,
  }
}

/** 用例之间清理（不装新内核时也要清）。 */
export function stopFakeKernel(): void {
  resetKernelForTest()
}
