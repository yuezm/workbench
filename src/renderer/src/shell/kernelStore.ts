import type { Command } from '../../../protocol/commands'
import type { CommandDispatchResult, KernelEvent } from '../../../protocol/ipc'
import type { ViewId, ViewParams, ViewResult } from '../../../protocol/views'

/**
 * renderer 侧的内核 store（M5 D8）：
 *
 * - **快照 + seq**：启动先 subscribe 并缓冲，再 `query('kernel.seq')` 取水位，
 *   最后回放 `seq > 水位` 的批次（断线重连/刷新窗口同一条路径）。
 * - **按需取视图**：订阅者只声明视图；收到 facts 只做失效，视图在失效后重取。
 * - **单订阅**：整个窗口只有一个 `transport.subscribe`，由本模块统一转发。
 * - **不做乐观更新**：写命令成功后等事实批次回来，再按失效表重取。
 */
export interface KernelTransport {
  dispatch<C extends Command>(command: C): Promise<CommandDispatchResult<C>>
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  subscribe(handler: (event: KernelEvent) => void): () => void
}

/** 视图缓存键：视图 id + 参数的稳定序列化。 */
export function viewKey(view: ViewId, params?: ViewParams<ViewId>): string {
  return params === undefined || params === null ? view : `${view}|${JSON.stringify(params)}`
}

interface ViewEntry {
  view: ViewId
  params: ViewParams<ViewId> | undefined
  value: unknown
  ready: boolean
  stale: boolean
  request: number
  loading: boolean
  listeners: Set<() => void>
}

export interface KernelStore {
  /** 最近一次已知的事实水位（启动快照 + 收到的事实批次）。 */
  readonly seq: number
  /** 先订阅后取快照；重复调用只启动一次。 */
  start(): Promise<void>
  /** 唯一写入口；缺 `commandId` 时补一个（幂等键，base 由 transport 保证）。 */
  dispatch<C extends Command>(command: C): Promise<CommandDispatchResult<C>>
  /** 单次查询（不经缓存；启动快照也走它）。 */
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  /** 已缓存且已就绪的视图值；未就绪返回 undefined（供 useSyncExternalStore 取快照）。 */
  peek<T extends ViewId>(view: T, params?: ViewParams<T>): ViewResult<T> | undefined
  /** 订阅一个视图：首次订阅触发加载，事实失效后自动重取；返回退订函数。 */
  watch(view: ViewId, params: ViewParams<ViewId> | undefined, listener: () => void): () => void
  /** 聊天流旁路（实时显示用；事实仍是数据源）。 */
  onStream(listener: (event: KernelEvent) => void): () => void
  /** 应用一条推送（transport 订阅回调与测试注入共用）。 */
  applyEvent(event: KernelEvent): void
  stop(): void
}

/**
 * 事实类型 → 需要失效的视图。前缀匹配；未知类型全量失效兜底
 * （新事实没登记时宁可多取，也不留旧数据）。
 */
const INVALIDATION: ReadonlyArray<{ prefix: string; views: readonly ViewId[] }> = [
  { prefix: 'workflow.', views: ['workflows.all', 'tasks.byWorkflow', 'task.byId'] },
  { prefix: 'stage.', views: ['workflows.all', 'tasks.byWorkflow'] },
  { prefix: 'agent.', views: ['agents.all', 'workflows.all'] },
  { prefix: 'runtime.', views: ['runtimes.all', 'runtimes.statuses'] },
  { prefix: 'task.', views: ['tasks.byWorkflow', 'task.byId', 'tasks.executing'] },
  {
    prefix: 'run.',
    views: [
      'tasks.executing',
      'runtimes.statuses',
      'runs.byTask',
      'run.byId',
      'run.events',
      'run.last-event-seq',
      'runs.active-by-task',
      'runs.active-by-conversation',
    ],
  },
  { prefix: 'card.', views: ['cards.open', 'cards.byRun'] },
  { prefix: 'conversation.', views: ['conversations.all', 'messages.byConversation'] },
  { prefix: 'message.', views: ['messages.byConversation', 'conversations.all'] },
  { prefix: 'event.', views: [] },
]

/** 一次事实批次要失效的视图 id 集合；有未知类型时返回 null（调用方全量失效）。 */
function invalidatedViews(types: readonly string[]): Set<ViewId> | null {
  const affected = new Set<ViewId>()
  for (const type of types) {
    const rule = INVALIDATION.find((entry) => type.startsWith(entry.prefix))
    if (rule === undefined) return null
    for (const view of rule.views) affected.add(view)
  }
  return affected
}

/** 幂等键：renderer 侧随机；没有 WebCrypto 时退化为时间戳 + 计数（仅测试环境）。 */
let fallbackId = 0
function nextCommandId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  fallbackId += 1
  return `cmd-${Date.now()}-${fallbackId}`
}

export function createKernelStore(transport: KernelTransport): KernelStore {
  const entries = new Map<string, ViewEntry>()
  const streamListeners = new Set<(event: KernelEvent) => void>()
  let seq = 0
  let started: Promise<void> | null = null
  let unsubscribeTransport: (() => void) | null = null
  const buffered: KernelEvent[] = []
  let snapshotReady = false

  const entryFor = (view: ViewId, params: ViewParams<ViewId> | undefined): ViewEntry => {
    const key = viewKey(view, params)
    const existing = entries.get(key)
    if (existing) return existing
    const created: ViewEntry = {
      view,
      params,
      value: undefined,
      ready: false,
      stale: false,
      request: 0,
      loading: false,
      listeners: new Set(),
    }
    entries.set(key, created)
    return created
  }

  const notify = (entry: ViewEntry): void => {
    for (const listener of entry.listeners) listener()
  }

  const fetchEntry = (entry: ViewEntry): void => {
    if (entry.loading) return
    entry.loading = true
    entry.stale = false
    entry.request += 1
    const request = entry.request
    transport
      .query(entry.view, entry.params)
      .then((value) => {
        if (request !== entry.request) return
        entry.value = value
        entry.ready = true
        entry.loading = false
        notify(entry)
        // 请求期间到达了相关事实：再取一次，避免把旧值当最新
        if (entry.stale) fetchEntry(entry)
      })
      .catch(() => {
        if (request !== entry.request) return
        entry.loading = false
        // 查询失败保留旧值（若有）；下次失效或订阅会再试
      })
  }

  const invalidate = (views: Set<ViewId> | null): void => {
    for (const entry of entries.values()) {
      if (views !== null && !views.has(entry.view)) continue
      entry.stale = true
      if (entry.listeners.size > 0) fetchEntry(entry)
    }
  }

  const handleEvent = (event: KernelEvent): void => {
    if (event.kind !== 'facts') {
      for (const listener of streamListeners) listener(event)
      return
    }
    if (!snapshotReady) {
      buffered.push(event)
      return
    }
    if (event.seq > seq) seq = event.seq
    invalidate(invalidatedViews(event.types))
  }

  const start = (): Promise<void> => {
    if (started) return started
    // 先订阅再取快照：窗口加载期间的增量先入缓冲，快照回来后按 seq 续传。
    unsubscribeTransport = transport.subscribe(handleEvent)
    started = transport
      .query('kernel.seq')
      .then((value) => {
        seq = value
        snapshotReady = true
        for (const event of buffered) {
          if (event.kind === 'facts') {
            if (event.seq > seq) {
              seq = event.seq
              invalidate(invalidatedViews(event.types))
            }
            continue
          }
          for (const listener of streamListeners) listener(event)
        }
        buffered.length = 0
      })
      .catch(() => {
        // 快照失败：保持缓冲，后续事实批次按到达顺序应用（不阻塞 UI）
        snapshotReady = true
        for (const event of buffered) handleEvent(event)
        buffered.length = 0
      })
    return started
  }

  return {
    get seq() {
      return seq
    },
    start,
    dispatch: <C extends Command>(command: C): Promise<CommandDispatchResult<C>> => {
      const withId =
        command.commandId === undefined || command.commandId === ''
          ? ({ ...command, commandId: nextCommandId() } as C)
          : command
      return transport.dispatch(withId)
    },
    query: <T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>> =>
      transport.query(view, params),
    peek: <T extends ViewId>(view: T, params?: ViewParams<T>): ViewResult<T> | undefined => {
      const entry = entries.get(viewKey(view, params as ViewParams<ViewId> | undefined))
      return entry?.ready === true ? (entry.value as ViewResult<T>) : undefined
    },
    watch: (view, params, listener) => {
      const entry = entryFor(view, params)
      entry.listeners.add(listener)
      if (!entry.ready || entry.stale) fetchEntry(entry)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    onStream: (listener) => {
      streamListeners.add(listener)
      return () => {
        streamListeners.delete(listener)
      }
    },
    applyEvent: handleEvent,
    stop: () => {
      unsubscribeTransport?.()
      unsubscribeTransport = null
      streamListeners.clear()
      for (const entry of entries.values()) entry.listeners.clear()
      entries.clear()
      started = null
      snapshotReady = false
      buffered.length = 0
    },
  }
}

let current: KernelStore | null = null

/** 装配 renderer store（main.tsx 与测试共用）；重复调用会先停掉旧的。 */
export function configureKernel(transport: KernelTransport): KernelStore {
  current?.stop()
  current = createKernelStore(transport)
  void current.start()
  return current
}

/** 取当前 store；未装配时明确报错（preload 未加载或测试未装替身）。 */
export function getKernelStore(): KernelStore {
  if (current === null) throw new Error('kernelStore 未装配（先调用 configureKernel）')
  return current
}

/** 仅在测试里重置，避免用例之间互相污染。 */
export function resetKernelForTest(): void {
  current?.stop()
  current = null
}
