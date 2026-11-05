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
  /** 让某个视图查询失败（错误文案透传到 useKernelViewState().error） */
  failView(view: ViewId, params: ViewParams<ViewId> | undefined, message: string): void
  /** 恢复正常查询（清除失败注入并按最新值重取） */
  clearFailure(view: ViewId, params: ViewParams<ViewId> | undefined): void
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
  const failures = new Map<string, string>()
  const dispatched: Command[] = []
  let seq = 0
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
      const key = viewKey(view, params as ViewParams<ViewId> | undefined)
      const failure = failures.get(key)
      if (failure !== undefined) return Promise.reject(new Error(failure))
      if (view === 'kernel.seq') return Promise.resolve(seq as ViewResult<T>)
      return Promise.resolve(viewValues.get(key) as ViewResult<T>)
    },
    subscribe: () => () => {},
  }

  const store = configureKernel(transport)

  const emitFacts = (types: FactType[]): void => {
    seq += 1
    const event: KernelEvent = { kind: 'facts', seq, types }
    // store.applyEvent 就是 transport 订阅回调本身：只投递一次，避免事实/流被重复应用
    store.applyEvent(event)
  }

  return {
    store,
    setView: (view, params, value) => {
      viewValues.set(viewKey(view, params as ViewParams<ViewId> | undefined), value)
      emitFacts(['snapshot.imported'])
    },
    failView: (view, params, message) => {
      failures.set(viewKey(view, params), message)
      emitFacts(['snapshot.imported'])
    },
    clearFailure: (view, params) => {
      failures.delete(viewKey(view, params))
      emitFacts(['snapshot.imported'])
    },
    pushFacts: emitFacts,
    pushStream: (event) => {
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
