/**
 * kernelStore（M5 D8）：
 *
 * - 启动顺序 = 先订阅、后取 `kernel.seq` 快照、再回放 `seq >` 快照的缓冲批次；
 * - 同一窗口只建立一个 transport 订阅；
 * - 事实批次只做失效，视图订阅者按需重取；流事件走旁路；
 * - 写命令补 `commandId`（缺省时），成功后不乐观更新。
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { Command } from '../../../../src/protocol/commands'
import type { KernelEvent } from '../../../../src/protocol/ipc'
import {
  VIEW_IDS,
  type ViewId,
  type ViewParams,
  type ViewResult,
} from '../../../../src/protocol/views'
import {
  configureKernel,
  createKernelStore,
  getKernelStore,
  resetKernelForTest,
  viewKey,
  type KernelStore,
  type KernelTransport,
} from '../../../../src/renderer/src/shell/kernelStore'
import { useKernelView, useKernelViewState } from '../../../../src/renderer/src/shell/useKernelView'
import { installFakeKernel, stopFakeKernel } from '../../shell/fake-kernel'

interface FakeTransport {
  transport: KernelTransport
  emit(event: KernelEvent): void
  subscribed: number
  unsubscribed: number
  queries: Array<{ view: ViewId; params: unknown }>
  dispatchSpy: ReturnType<typeof vi.fn>
}

/** 内存 transport：`kernel.seq` 返回当前水位，视图值从初始表取。 */
function fakeTransport(initialViews: Partial<Record<ViewId, unknown>> = {}): FakeTransport {
  const views = new Map<string, unknown>(Object.entries(initialViews))
  const seq = 0
  let handler: ((event: KernelEvent) => void) | null = null
  const state = {
    subscribed: 0,
    unsubscribed: 0,
    queries: [] as Array<{ view: ViewId; params: unknown }>,
    dispatchSpy: vi.fn(),
  }

  const transport: KernelTransport = {
    dispatch: <C extends Command>(command: C) => {
      state.dispatchSpy(command)
      return Promise.resolve({ facts: [], value: null })
    },
    query: <T extends ViewId>(view: T, params?: ViewParams<T>) => {
      state.queries.push({ view, params })
      if (view === 'kernel.seq') return Promise.resolve(seq as ViewResult<T>)
      const value = views.get(viewKey(view, params as ViewParams<ViewId> | undefined))
      return Promise.resolve(value as ViewResult<T>)
    },
    subscribe: (cb) => {
      state.subscribed += 1
      handler = cb
      return () => {
        state.unsubscribed += 1
        handler = null
      }
    },
  }

  return {
    transport,
    emit: (event) => handler?.(event),
    get subscribed() {
      return state.subscribed
    },
    get unsubscribed() {
      return state.unsubscribed
    },
    get queries() {
      return state.queries
    },
    get dispatchSpy() {
      return state.dispatchSpy
    },
  }
}

/** 包装成可手动控制快照返回的版本（测试里只用于续传用例）。 */
function controlledTransport(): FakeTransport & { release(value: number): void; hold(): void } {
  const base = fakeTransport()
  let release: ((value: number) => void) | null = null
  let held = false
  const original = base.transport.query
  const transport: KernelTransport = {
    dispatch: base.transport.dispatch,
    subscribe: base.transport.subscribe,
    query: <T extends ViewId>(view: T, params?: ViewParams<T>) => {
      if (view === 'kernel.seq' && held) {
        return new Promise<number>((resolve) => {
          release = (value) => resolve(value)
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    },
  }
  return {
    transport,
    emit: base.emit,
    get subscribed() {
      return base.subscribed
    },
    get unsubscribed() {
      return base.unsubscribed
    },
    get queries() {
      return base.queries
    },
    get dispatchSpy() {
      return base.dispatchSpy
    },
    hold: () => {
      held = true
    },
    release: (value) => {
      held = false
      release?.(value)
    },
  }
}
async function started(store: KernelStore): Promise<void> {
  await store.start()
}

describe('renderer/shell/kernelStore', () => {
  it('启动顺序：先订阅、再取快照、最后回放快照之后的事实', async () => {
    const fake = controlledTransport()
    fake.hold()
    const store = createKernelStore(fake.transport)
    void store.start()

    expect(fake.subscribed).toBe(1)
    // 快照未回：先到达的批次进入缓冲，不失效
    fake.emit({ kind: 'facts', seq: 4, types: ['task.created'] })

    fake.release(2)
    await store.start()

    // 快照 seq=2，缓冲批次 seq=4 要回放 → 视图重取
    const watched: Array<number> = []
    const off = store.watch('tasks.byWorkflow', { workflowId: 'wf-1' }, () => watched.push(1))
    await Promise.resolve()
    expect(store.seq).toBe(4)
    expect(watched.length).toBeGreaterThan(0)
    off()
  })

  it('快照之前的缓冲批次被丢弃（seq 不大于快照）', async () => {
    const fake = controlledTransport()
    fake.hold()
    const store = createKernelStore(fake.transport)
    void store.start()
    fake.emit({ kind: 'facts', seq: 1, types: ['task.created'] })
    fake.release(5)
    await store.start()
    expect(store.seq).toBe(5)
    const off = store.watch('agents.all', undefined, () => {})
    await Promise.resolve()
    await Promise.resolve()
    // 只加载订阅的视图一次：被丢弃的批次没有触发额外失效重取
    expect(fake.queries.filter((entry) => entry.view === 'agents.all')).toHaveLength(1)
    off()
  })

  it('同一窗口只订阅一次；两个视图共用一个 IPC 订阅', async () => {
    const fake = fakeTransport({ 'agents.all': [], 'tasks.executing': [] })
    const store = createKernelStore(fake.transport)
    await started(store)

    const offA = store.watch('agents.all', undefined, () => {})
    const offB = store.watch('tasks.executing', undefined, () => {})
    fake.emit({ kind: 'facts', seq: 1, types: ['agent.created'] })
    await Promise.resolve()
    await Promise.resolve()

    expect(fake.subscribed).toBe(1)
    expect(
      fake.queries.filter((entry) => entry.view === 'agents.all').length,
    ).toBeGreaterThanOrEqual(2)
    expect(fake.queries.filter((entry) => entry.view === 'tasks.executing').length).toBe(1)
    offA()
    offB()
  })

  it('事实批次按失效表重取；流事件不触发视图查询', async () => {
    const fake = fakeTransport({ 'cards.open': [], 'run.events': [] })
    const store = createKernelStore(fake.transport)
    await started(store)
    const offCard = store.watch('cards.open', undefined, () => {})
    const offEvents = store.watch('run.events', { runId: 'run-1' }, () => {})
    await Promise.resolve()

    const before = fake.queries.length
    fake.emit({ kind: 'facts', seq: 2, types: ['card.opened'] })
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.queries.length).toBeGreaterThan(before)
    const afterFacts = fake.queries.length

    fake.emit({
      kind: 'stream',
      runId: 'run-1',
      conversationId: 'cv-1',
      event: { seq: 1, type: 'text', text: 'hi' },
    } as KernelEvent)
    await Promise.resolve()
    expect(fake.queries.length).toBe(afterFacts)
    offCard()
    offEvents()
  })

  it('缓存键包含参数：不同 taskId 各自缓存，重复订阅同一键不再查询', async () => {
    const fake = fakeTransport()
    const store = createKernelStore(fake.transport)
    await started(store)
    const offA = store.watch('runs.byTask', { taskId: 't-1' }, () => {})
    const offB = store.watch('runs.byTask', { taskId: 't-2' }, () => {})
    const offC = store.watch('runs.byTask', { taskId: 't-1' }, () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.queries.filter((entry) => entry.view === 'runs.byTask')).toHaveLength(2)
    offA()
    offB()
    offC()
  })

  it('dispatch：缺 commandId 时补一个幂等键，已有时原样透传', async () => {
    const fake = fakeTransport()
    const store = createKernelStore(fake.transport)
    await started(store)

    await store.dispatch({ type: 'task.complete', id: 't-1' } as Command)
    const first = fake.dispatchSpy.mock.calls[0][0] as Command
    expect(first.commandId).toBeTruthy()

    await store.dispatch({ type: 'task.complete', id: 't-1', commandId: 'fixed' } as Command)
    const second = fake.dispatchSpy.mock.calls[1][0] as Command
    expect(second.commandId).toBe('fixed')
  })

  it('stop：退订 transport 并清空监听', async () => {
    const fake = fakeTransport()
    const store = createKernelStore(fake.transport)
    await started(store)
    const listener = vi.fn()
    store.watch('agents.all', undefined, listener)
    await Promise.resolve()
    await Promise.resolve()
    const before = listener.mock.calls.length
    store.stop()
    expect(fake.unsubscribed).toBe(1)
    fake.emit({ kind: 'facts', seq: 9, types: ['agent.created'] })
    expect(listener).toHaveBeenCalledTimes(before)
  })

  it('onStream 收到聊天流事件，facts 不进入流旁路', async () => {
    const fake = fakeTransport()
    const store = createKernelStore(fake.transport)
    await started(store)
    const streamed: KernelEvent[] = []
    const off = store.onStream((event) => streamed.push(event))
    fake.emit({ kind: 'facts', seq: 1, types: ['run.queued'] })
    fake.emit({ kind: 'stream-end', runId: 'run-1', conversationId: 'cv-1' })
    expect(streamed.map((event) => event.kind)).toEqual(['stream-end'])
    off()
  })
})

/** useKernelView：视图值变化驱动重渲染（不轮询、不重复订阅）。 */
function Probe({ view }: { view: 'agents.all' }): ReactElement {
  const value = useKernelView(view)
  return <div data-testid="probe">{value === undefined ? 'loading' : String(value.length)}</div>
}

describe('renderer/shell/useKernelView', () => {
  it('先渲染 loading，快照就绪后展示视图；失效后自动重取', async () => {
    const fake = fakeTransport({ 'agents.all': [] })
    configureKernel(fake.transport)
    render(<Probe view="agents.all" />)
    expect(screen.getByTestId('probe').textContent).toBe('loading')
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('probe').textContent).toBe('0')

    fake.emit({ kind: 'facts', seq: 1, types: ['agent.created'] })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('probe').textContent).toBe('0')
    resetKernelForTest()
  })

  it('VIEW_IDS 数量与视图缓存键无关；键函数稳定', () => {
    expect(viewKey('runs.byTask', { taskId: 't-1' })).toBe('runs.byTask|{"taskId":"t-1"}')
    expect(viewKey('agents.all')).toBe('agents.all')
    expect(VIEW_IDS.length).toBeGreaterThan(0)
  })
})

/** 读错误：`useKernelViewState` 暴露 transport 的错误文案，恢复后回到数据。 */
function StateProbe(): ReactElement {
  const state = useKernelViewState('agents.all')
  if (state.error !== null) return <div data-testid="state">{state.error}</div>
  return (
    <div data-testid="state">
      {state.data === undefined ? 'loading' : String(state.data.length)}
    </div>
  )
}

describe('renderer/shell/useKernelViewState', () => {
  it('查询失败展示错误；清除失败后按最新值恢复', async () => {
    const kernel = installFakeKernel()
    kernel.setView('agents.all', undefined, [])
    render(<StateProbe />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('state').textContent).toBe('0')

    kernel.failView('agents.all', undefined, '视图查询失败')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('state').textContent).toBe('视图查询失败')

    kernel.clearFailure('agents.all', undefined)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('state').textContent).toBe('0')
    stopFakeKernel()
  })
})
/** params=null：暂不订阅（id 未选），不发查询、返回空态。 */
function DisabledProbe(): ReactElement {
  const state = useKernelViewState('runs.byTask', null)
  return (
    <div data-testid="disabled">
      {state.loading ? 'loading' : (state.error ?? 'ready')}:
      {state.data === undefined ? 'none' : String(state.data)}
    </div>
  )
}

describe('renderer/shell/useKernelView：params=null 暂不订阅', () => {
  it('不发查询、不返回 loading、无错误', async () => {
    const fake = fakeTransport()
    configureKernel(fake.transport)
    render(<DisabledProbe />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fake.queries.some((entry) => entry.view === 'runs.byTask')).toBe(false)
    expect(screen.getByTestId('disabled').textContent).toBe('ready:none')
    resetKernelForTest()
  })
})
/** 手动控制查询返回的 transport（验证迟到响应 / 快照失败 / 流缓冲）。 */
function manualTransport(): {
  transport: KernelTransport
  resolveQuery(view: ViewId, value: unknown): void
  rejectQuery(view: ViewId, error: Error): void
  pending(): ViewId[]
} {
  const pendingResolvers: Array<{
    view: ViewId
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }> = []
  const transport: KernelTransport = {
    dispatch: <C extends Command>(_command: C) => Promise.resolve({ facts: [], value: null }),
    query: <T extends ViewId>(view: T): Promise<ViewResult<T>> =>
      new Promise<ViewResult<T>>((resolve, reject) => {
        pendingResolvers.push({
          view,
          resolve: (value) => resolve(value as ViewResult<T>),
          reject,
        })
      }),
    subscribe: () => () => {},
  }
  return {
    transport,
    resolveQuery: (view, value) => {
      const index = pendingResolvers.findIndex((entry) => entry.view === view)
      if (index < 0) throw new Error('没有待返回的查询: ' + view)
      pendingResolvers.splice(index, 1)[0]!.resolve(value)
    },
    rejectQuery: (view, error) => {
      const index = pendingResolvers.findIndex((entry) => entry.view === view)
      if (index < 0) throw new Error('没有待返回的查询: ' + view)
      pendingResolvers.splice(index, 1)[0]!.reject(error)
    },
    pending: () => pendingResolvers.map((entry) => entry.view),
  }
}

describe('renderer/shell/kernelStore：边界路径', () => {
  it('加载期间到达事实：迟到响应丢弃并重取一次', async () => {
    const manual = manualTransport()
    const store = createKernelStore(manual.transport)
    void store.start()
    manual.resolveQuery('kernel.seq', 0)
    await store.start()

    const values: unknown[] = []
    const off = store.watch('agents.all', undefined, () => values.push(store.peek('agents.all')))
    expect(manual.pending()).toEqual(['agents.all'])

    // 第一次查询未返回时来了事实：标记 stale，等响应后重取
    store.applyEvent({ kind: 'facts', seq: 1, types: ['agent.created'] })
    manual.resolveQuery('agents.all', ['旧值'])
    await Promise.resolve()
    await Promise.resolve()
    expect(manual.pending()).toEqual(['agents.all'])

    manual.resolveQuery('agents.all', ['新值'])
    await Promise.resolve()
    await Promise.resolve()
    expect(store.peek('agents.all')).toEqual(['新值'])
    expect(values.length).toBeGreaterThan(0)
    off()
  })

  it('快照查询失败：缓冲批次按到达顺序应用（不阻塞 UI）', async () => {
    const manual = manualTransport()
    const store = createKernelStore(manual.transport)
    const started = store.start()
    store.applyEvent({ kind: 'facts', seq: 7, types: ['agent.created'] })
    manual.rejectQuery('kernel.seq', new Error('库忙'))
    await started
    expect(store.seq).toBe(7)
  })

  it('流事件即时送达，不参与快照缓冲', async () => {
    const manual = manualTransport()
    const store = createKernelStore(manual.transport)
    void store.start()
    const streamed: string[] = []
    store.onStream((event) => streamed.push(event.kind))
    store.applyEvent({ kind: 'stream-end', runId: 'run-1', conversationId: 'cv-1' })
    expect(streamed).toEqual(['stream-end'])
    manual.resolveQuery('kernel.seq', 0)
    await store.start()
    expect(streamed).toEqual(['stream-end'])
  })

  it('没有 WebCrypto 时补时间戳幂等键', async () => {
    const fake = fakeTransport()
    const store = createKernelStore(fake.transport)
    await store.start()
    vi.stubGlobal('crypto', {})
    try {
      await store.dispatch({ type: 'task.complete', id: 't-1' } as Command)
      const command = fake.dispatchSpy.mock.calls[0][0] as Command
      expect(command.commandId).toMatch(/^cmd-/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('未装配时取 store 明确报错；reset 后再取仍报错', () => {
    resetKernelForTest()
    expect(() => getKernelStore()).toThrow('kernelStore 未装配（先调用 configureKernel）')
  })
})
describe('renderer/shell/kernelStore：错误文案', () => {
  it('查询失败为非 Error 值时转成字符串', async () => {
    const fake = fakeTransport()
    const original = fake.transport.query
    fake.transport.query = <T extends ViewId>(view: T, params?: ViewParams<T>) => {
      if (view === 'agents.all') return Promise.reject('桥接字符串错误')
      return original(view, params)
    }
    const store = createKernelStore(fake.transport)
    await store.start()
    const off = store.watch('agents.all', undefined, () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(store.peekState('agents.all')).toMatchObject({
      data: undefined,
      error: '桥接字符串错误',
      loading: false,
    })
    off()
  })
})
