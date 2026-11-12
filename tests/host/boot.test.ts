// @vitest-environment node
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { receiptBlockHint } from '../../src/kernel/prompt'
import { CHAT_RECEIPT_KEYS } from '../../src/protocol/receipt-keys'
import { WORKBENCH_EVENT_CHANNEL } from '../../src/protocol/ipc'
import type { ExternalPluginEntry, ExternalPluginRejection } from '../../src/host/plugins/discover'

/**
 * 主进程入口只做装配：mock 掉 electron 与各模块，验证窗口/托盘/退出流程，
 * 以及 M5 三动词的接线（store → effects/scheduler/clock → 命令路由 → IPC、
 * 事实批次与聊天流旁路经 feed 推给所有窗口）。
 */
const {
  appMock,
  shellMock,
  windows,
  BrowserWindowMock,
  createTrayMock,
  ensureShortcutMock,
  registerIpcHandlersMock,
  createFactFeedMock,
  feedMock,
  createCommandRouterMock,
  routerMock,
  openDatabaseMock,
  createStoreMock,
  storeMock,
  storeQueryDefault,
  importLegacyMock,
  createSchedulerMock,
  schedulerMock,
  createEffectsMock,
  effectsMock,
  createChannelsMock,
  channelsMock,
  channelsEntriesMock,
  createSourcesMock,
  sourcesMock,
  createClockMock,
  clockMock,
  pluginEntriesMock,
  sourcesEntriesMock,
  sdkHostMock,
  createSdkHostMock,
  createExecutorRegistryMock,
  executorsMock,
  detectAllMock,
  createProcessRegistryMock,
  registryMock,
  reconcileMock,
  killPidTreeMock,
  defaultLimitsMock,
  startupOrder,
  createNetCapabilityMock,
  netMock,
  discoverExternalPluginsMock,
  createPluginSecretsMock,
  pluginSecretsMock,
  resolvePluginConfigMock,
  createExternalChannelPluginMock,
  createExternalSourcePluginMock,
  safeStorageMock,
} = vi.hoisted(() => {
  interface WindowMock {
    webContents: {
      send: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
    }
    on: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    isMinimized: ReturnType<typeof vi.fn>
    restore: ReturnType<typeof vi.fn>
    loadURL: ReturnType<typeof vi.fn>
    loadFile: ReturnType<typeof vi.fn>
    /** 构造参数（窗口图标等装配值在这里断言） */
    options: Record<string, unknown>
  }
  const windows: WindowMock[] = []
  class BrowserWindowMock {
    static getAllWindows = vi.fn((): WindowMock[] => windows)
    webContents = { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() }
    on = vi.fn()
    show = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    isMinimized = vi.fn(() => false)
    restore = vi.fn()
    options: Record<string, unknown>
    loadURL = vi.fn()
    loadFile = vi.fn()
    constructor(options: Record<string, unknown>) {
      this.options = options
      windows.push(this)
    }
  }

  // store 门面：入口用到 ensureProjection / query / nextWakeAt；其余由命令路由使用。
  const storeQueryDefault = (table: string, params?: unknown): unknown => {
    if (table === 'plugins.settings') return { version: 0, replacedAt: null, settings: [] }
    if (table === 'run.last-event-seq') return 0
    if (table === 'runs.waiting') {
      return [
        { runId: 'run-1', leaseId: null, turn: 1, hasOpenCard: true },
        { runId: 'run-2', leaseId: null, turn: 2, hasOpenCard: false },
      ]
    }
    if (table === 'run.byId') {
      const runId = (params as { runId?: string } | undefined)?.runId
      return runId === 'run-1' ? { id: 'run-1', status: 'running' } : null
    }
    return []
  }
  const storeMock = {
    ensureProjection: vi.fn(() => ({ rebuilt: false })),
    // M18：启动补齐内置阶段（待办 / 已阻塞 / 已完成 / 已取消），排在 ensureProjection 之后
    ensureBuiltinStages: vi.fn(() => ({ created: 0, updated: 0 })),
    query: vi.fn(storeQueryDefault),
    nextWakeAt: vi.fn(() => null),
    dispatch: vi.fn((_input: unknown) => ({ facts: [] })),
  }
  const createStoreMock = vi.fn((_options: unknown) => storeMock)
  const importLegacyMock = vi.fn(() => ({
    imported: false,
    counts: {
      tasks: 0,
      workflows: 0,
      workflow_stages: 0,
      agents: 0,
      runtimes: 0,
      runs: 0,
      run_events: 0,
      conversations: 0,
      messages: 0,
    },
  }))
  const defaultLimitsMock = { heartbeatMs: 30_000, runTimeoutMs: 1_800_000, maxFramesPerBatch: 500 }

  const schedulerMock = {
    wake: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    active: vi.fn(() => []),
    idle: vi.fn(async () => undefined),
  }
  const createSchedulerMock = vi.fn((_deps: unknown) => schedulerMock)
  const effectsMock = {
    dispatch: vi.fn((_input: unknown) => ({ facts: [] })),
    afterCommit: vi.fn(),
  }
  const createEffectsMock = vi.fn((_deps: unknown) => effectsMock)
  const channelsMock = {
    startAll: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    dispatch: vi.fn(),
    answer: vi.fn(async () => undefined),
  }
  const createChannelsMock = vi.fn((_deps: unknown) => channelsMock)
  /** 内置通道清单（T8 前为空；装配根原样注入 hub） */
  const channelsEntriesMock: unknown[] = []
  /** 内置来源清单（M7 前为空；装配根原样注入 source hub） */
  const sourcesEntriesMock: unknown[] = []
  const sourcesMock = {
    startAll: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    statuses: vi.fn((): unknown[] => []),
  }
  const createSourcesMock = vi.fn((_deps: unknown) => sourcesMock)
  /** M7 能力面 / 外部插件 / secret 的装配根注入（本用例只验证接线，不验实现） */
  const netMock = { fetch: vi.fn(), listen: vi.fn(), verifyHmacSha256: vi.fn(() => true) }
  const createNetCapabilityMock = vi.fn((_options?: unknown) => netMock)
  const discoverExternalPluginsMock = vi.fn(
    async (
      _options: unknown,
    ): Promise<{
      entries: ExternalPluginEntry[]
      rejections: ExternalPluginRejection[]
      missingRoot: boolean
    }> => ({
      entries: [],
      rejections: [],
      missingRoot: true,
    }),
  )
  const pluginSecretsMock = {
    listSecretKeys: vi.fn((): string[] => []),
    hasSecret: vi.fn(() => false),
    readSecrets: vi.fn((): Record<string, string> => ({})),
    setSecret: vi.fn(),
    removeSecret: vi.fn(),
  }
  const createPluginSecretsMock = vi.fn((_options: unknown) => pluginSecretsMock)
  const resolvePluginConfigMock = vi.fn((_manifest: unknown) => ({}) as Record<string, unknown>)
  const createExternalChannelPluginMock = vi.fn((_entry: unknown, _options: unknown) => ({
    start: vi.fn(),
  }))
  const createExternalSourcePluginMock = vi.fn((_entry: unknown, _options: unknown) => ({
    start: vi.fn(),
  }))
  const safeStorageMock = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(() => Buffer.from('cipher')),
    decryptString: vi.fn(() => 'plain'),
  }
  const clockMock = {
    start: vi.fn(),
    stop: vi.fn(),
    wake: vi.fn(),
    rearm: vi.fn(),
    nextAt: vi.fn(() => null),
  }
  const createClockMock = vi.fn((_deps: unknown) => clockMock)
  const executorsMock = { forRuntime: vi.fn() }
  /** 注册表项形状：manifest 的 config 默认值就是运行时表单默认值来源 */
  const pluginEntriesMock = [
    {
      key: 'dsh',
      label: 'DeepSeek Harness',
      manifest: {
        id: 'dsh',
        kind: 'executor',
        name: 'DeepSeek Harness',
        version: '1.0.0',
        capabilities: ['spawn'],
        config: [
          { key: 'command', label: '命令', type: 'text', default: 'dsh' },
          { key: 'profile', label: 'Profile', type: 'text', default: 'multica' },
        ],
      },
      plugin: { run: vi.fn() },
    },
  ]
  const sdkHostMock = {
    log: vi.fn(),
    now: vi.fn(() => 0),
    paths: { sessionRoot: '/tmp/workbench-entry-test/sessions' },
    config: vi.fn(() => ({})),
    process: {},
  }
  const createSdkHostMock = vi.fn((_options: unknown) => sdkHostMock)
  const createExecutorRegistryMock = vi.fn((_entries: unknown, _host: unknown) => executorsMock)
  /** detect 汇总走注册表：IPC 只拿一个函数，装配根把 sdkHost 注入 */
  const detectAllMock = vi.fn(async (_host: unknown): Promise<unknown[]> => [])
  const registryMock = {
    begin: vi.fn(),
    attachPid: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(() => []),
    clear: vi.fn(),
  }
  const createProcessRegistryMock = vi.fn((_db: unknown) => registryMock)
  const killPidTreeMock = vi.fn(() => true)
  const reconcileMock = vi.fn(
    (
      _deps: unknown,
    ): {
      killed: number
      cleared: number
      facts: number
      settledChats?: number
      settledWaitings?: number
    } => ({ killed: 0, cleared: 0, facts: 0 }),
  )

  /** 启动装配顺序：openDatabase → createStore → importLegacy → ensureProjection → 进程登记 → 对账 → … */
  const startupOrder: string[] = []

  /** 事实推送（M5）：批次与聊天流旁路都经它；订阅回调由用例取出后模拟推送。 */
  const feedMock = {
    publish: vi.fn(),
    stream: vi.fn(),
    subscribe: vi.fn(),
    flush: vi.fn(),
    stop: vi.fn(),
  }
  const createFactFeedMock = vi.fn(() => feedMock)
  /** 三动词的命令路由（宿主实现）：入口只把它交给 IPC，调用形态由 commands.test 覆盖。 */
  const routerMock = {
    dispatch: vi.fn(async (): Promise<unknown> => ({ facts: [], value: null })),
    query: vi.fn(async (): Promise<unknown> => null),
  }
  const createCommandRouterMock = vi.fn((_deps: unknown) => routerMock)

  return {
    appMock: {
      whenReady: vi.fn(async () => undefined),
      setAppUserModelId: vi.fn(),
      getPath: vi.fn(() => path.join(tmpdir(), 'workbench-entry-test')),
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      quit: vi.fn(),
      isPackaged: false,
      getAppPath: vi.fn(() => '/app'),
    },
    shellMock: { openExternal: vi.fn() },
    windows,
    BrowserWindowMock,
    createTrayMock: vi.fn(),
    ensureShortcutMock: vi.fn(),
    registerIpcHandlersMock: vi.fn(),
    createFactFeedMock,
    feedMock,
    createCommandRouterMock,
    routerMock,
    openDatabaseMock: vi.fn(() => ({})),
    createStoreMock,
    storeMock,
    storeQueryDefault,
    importLegacyMock,
    createSchedulerMock,
    schedulerMock,
    createEffectsMock,
    effectsMock,
    createChannelsMock,
    channelsMock,
    channelsEntriesMock,
    createSourcesMock,
    sourcesMock,
    createClockMock,
    clockMock,
    pluginEntriesMock,
    sourcesEntriesMock,
    sdkHostMock,
    createSdkHostMock,
    createExecutorRegistryMock,
    executorsMock,
    detectAllMock,
    createProcessRegistryMock,
    registryMock,
    reconcileMock,
    killPidTreeMock,
    defaultLimitsMock,
    startupOrder,
    createNetCapabilityMock,
    netMock,
    discoverExternalPluginsMock,
    createPluginSecretsMock,
    pluginSecretsMock,
    resolvePluginConfigMock,
    createExternalChannelPluginMock,
    createExternalSourcePluginMock,
    safeStorageMock,
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: BrowserWindowMock,
  shell: shellMock,
  safeStorage: safeStorageMock,
}))
vi.mock('../../src/main/tray', () => ({ createTray: createTrayMock }))
// 通知归属快捷方式会真的读写开始菜单：单测里换成 spy，只断言「装配根什么时候修」
vi.mock('../../src/main/shell-integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/shell-integration')>()
  return { ...actual, ensureNotificationShortcut: ensureShortcutMock }
})
vi.mock('../../src/main/ipc', () => ({ registerIpcHandlers: registerIpcHandlersMock }))
vi.mock('../../src/host/feed', () => ({ createFactFeed: createFactFeedMock }))
vi.mock('../../src/host/commands', () => ({ createCommandRouter: createCommandRouterMock }))
vi.mock('../../src/host/db', () => ({ openDatabase: openDatabaseMock }))
vi.mock('../../src/plugins/registry', () => ({
  executors: pluginEntriesMock,
  channels: channelsEntriesMock,
  sources: sourcesEntriesMock,
  channelById: vi.fn(() => channelsEntriesMock[0]),
  sourceById: vi.fn(() => sourcesEntriesMock[0]),
  detectAll: detectAllMock,
}))
vi.mock('../../src/host/net', () => ({ createNetCapability: createNetCapabilityMock }))
vi.mock('../../src/host/plugins/discover', () => ({
  discoverExternalPlugins: discoverExternalPluginsMock,
}))
vi.mock('../../src/host/plugins/settings', () => ({
  createPluginSecrets: createPluginSecretsMock,
  resolvePluginConfig: resolvePluginConfigMock,
}))
vi.mock('../../src/host/plugins/adapters', () => ({
  createExternalChannelPlugin: createExternalChannelPluginMock,
  createExternalSourcePlugin: createExternalSourcePluginMock,
}))
vi.mock('../../src/host/sources', () => ({ createSources: createSourcesMock }))
vi.mock('../../src/host/sdk-host', () => ({ createSdkHost: createSdkHostMock }))
vi.mock('../../src/host/executor-registry', () => ({
  createExecutorRegistry: createExecutorRegistryMock,
}))
vi.mock('../../src/host/store/index', () => ({
  createStore: createStoreMock,
  DEFAULT_LIMITS: defaultLimitsMock,
}))
vi.mock('../../src/host/store/import', () => ({ importLegacyIfNeeded: importLegacyMock }))
vi.mock('../../src/host/scheduler', () => ({ createScheduler: createSchedulerMock }))
vi.mock('../../src/host/effects', () => ({ createEffects: createEffectsMock }))
vi.mock('../../src/host/channels', () => ({ createChannels: createChannelsMock }))
vi.mock('../../src/host/clock', () => ({ createClock: createClockMock }))
vi.mock('../../src/host/process', () => ({
  killPidTree: killPidTreeMock,
  defaultSpawn: vi.fn(),
}))
vi.mock('../../src/host/process-registry', () => ({
  createProcessRegistry: createProcessRegistryMock,
}))
vi.mock('../../src/host/reconcile', () => ({ reconcile: reconcileMock }))

/** 入口是单例：每个用例重新加载一次，各自触发启动装配 */
async function importEntry(): Promise<void> {
  vi.resetModules()
  await import('../../src/main/index')
}

async function loadEntry(): Promise<void> {
  await importEntry()
  await vi.waitFor(() => expect(registerIpcHandlersMock).toHaveBeenCalled())
}

/** 取窗口上注册的事件回调 */
function windowHandler(name: string): (arg?: unknown) => void {
  const call = windows[0].on.mock.calls.find(([event]) => event === name)
  expect(call, `窗口应注册 ${name} 事件`).toBeDefined()
  return call?.[1] as (arg?: unknown) => void
}

/** 取 app 上注册的事件回调（可能存在多份，取第一份） */
function appHandler(name: string): () => void {
  const call = appMock.on.mock.calls.find(([event]) => event === name)
  expect(call, `app 应注册 ${name} 事件`).toBeDefined()
  return call?.[1] as () => void
}

/** feed 的订阅回调（装配根在启动时订阅一次）：推送由它广播到所有窗口。 */
function feedListener(): (event: unknown) => void {
  const call = feedMock.subscribe.mock.calls[0]
  expect(call, '启动装配应订阅事实推送').toBeDefined()
  return call?.[0] as (event: unknown) => void
}

type RouterDeps = {
  store: unknown
  dispatch: (input: unknown) => { facts: unknown[] }
  executors: { forRuntime: (runtime: { executorKey: string }) => unknown }
  executorDefaults: (key?: string) => { executorKey: string; command: string; profile: string }
  hostView: (view: string, params?: Record<string, string>) => unknown
  /** M7：插件设置编排依赖（entry / view / writeSecrets） */
  plugins?: {
    entry: (id: string) => unknown
    view: (id: string) => unknown
    writeSecrets: (id: string, patch: Record<string, string | null>) => void
  }
}

function routerDeps(): RouterDeps {
  return createCommandRouterMock.mock.calls[0][0] as RouterDeps
}

/** 装配根注入的宿主视图解析（插件注册表 / CLI 探测 / 执行器模型目录）。 */
function hostView(view: string, params?: Record<string, string>): unknown {
  return routerDeps().hostView(view, params)
}

/** IPC 只拿命令路由：三动词的宿主实现都在 router 背后。 */
function ipcDeps(): { router: unknown } {
  return registerIpcHandlersMock.mock.calls[0][0] as { router: unknown }
}

type SchedulerDeps = {
  dispatch: (input: unknown) => { facts: unknown[] }
  runtimes: () => unknown[]
  /** M27：执行配置在智能体上，调度器按 run.agentId 取整行 */
  agents: () => unknown[]
  executors: unknown
  limits: unknown
  lastFrameSeq: (runId: string) => number
  registry: unknown
  rearmClock?: () => void
  onChatStream?: (runId: string, conversationId: string, event: unknown) => void
  onChatStreamEnd?: (runId: string, conversationId: string) => void
  chatFallbackPrompt?: (run: unknown) => string | null
}

type ReconcileDeps = {
  registry: unknown
  dispatch: (input: unknown) => { facts: unknown[] }
  runStatus: (runId: string) => string | null
  staleChatRuns?: () => ReadonlyArray<{ id: string; leaseId: string | null; turn: number }>
  waitingRuns?: () => ReadonlyArray<{
    id: string
    leaseId: string | null
    turn: number
    hasOpenCard: boolean
  }>
  killPid: (pid: number) => boolean
}

function reconcileDeps(): ReconcileDeps {
  return reconcileMock.mock.calls[0][0] as ReconcileDeps
}

function schedulerDeps(): SchedulerDeps {
  return createSchedulerMock.mock.calls[0][0] as SchedulerDeps
}

type EffectsDeps = {
  store: unknown
  scheduler: () => unknown
  channels?: () => { dispatch: (facts: readonly unknown[]) => void }
  /** 提交后的事实观察钩子：装配根接成 feed.publish（批次推送） */
  onFacts?: (facts: readonly unknown[]) => void
}

function effectsDeps(): EffectsDeps {
  return createEffectsMock.mock.calls[0][0] as EffectsDeps
}

type ChannelsDeps = {
  store: unknown
  effects: unknown
  sdkHost: unknown
  entries?: unknown[]
  configOf?: (entry: unknown) => Record<string, unknown>
  isEnabled?: (entry: unknown) => boolean
}

function channelsDeps(): ChannelsDeps {
  return createChannelsMock.mock.calls[0][0] as ChannelsDeps
}

type ClockDeps = {
  store: { dispatch: (input: unknown) => unknown; nextWakeAt: (at: string) => unknown }
  onTick: () => void
}

function clockDeps(): ClockDeps {
  return createClockMock.mock.calls[0][0] as ClockDeps
}

describe('主进程入口装配', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    windows.length = 0
    startupOrder.length = 0
    delete process.env['ELECTRON_RENDERER_URL']
    // 打包态探针：`process.resourcesPath` 只有 Electron 主进程里才有，单测里补一个
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join('C:', 'Program Files', 'Workbench', 'resources'),
      configurable: true,
    })
    openDatabaseMock.mockImplementation(() => {
      startupOrder.push('openDatabase')
      return {}
    })
    createStoreMock.mockImplementation(() => {
      startupOrder.push('createStore')
      return storeMock
    })
    storeMock.ensureProjection.mockImplementation(() => {
      startupOrder.push('ensureProjection')
      return { rebuilt: false }
    })
    storeMock.ensureBuiltinStages.mockImplementation(() => {
      startupOrder.push('ensureBuiltinStages')
      return { created: 0, updated: 0 }
    })
    createExecutorRegistryMock.mockImplementation(() => {
      startupOrder.push('executors')
      return executorsMock
    })
    importLegacyMock.mockImplementation(() => {
      startupOrder.push('importLegacy')
      return {
        imported: false,
        counts: {
          tasks: 0,
          workflows: 0,
          workflow_stages: 0,
          agents: 0,
          runtimes: 0,
          runs: 0,
          run_events: 0,
          conversations: 0,
          messages: 0,
        },
      }
    })
    createProcessRegistryMock.mockImplementation(() => {
      startupOrder.push('registry')
      return registryMock
    })
    reconcileMock.mockImplementation(() => {
      startupOrder.push('reconcile')
      return { killed: 0, cleared: 0, facts: 0 }
    })
    createSchedulerMock.mockImplementation(() => {
      startupOrder.push('scheduler')
      return schedulerMock
    })
    createClockMock.mockImplementation(() => {
      startupOrder.push('clock')
      return clockMock
    })
    createChannelsMock.mockImplementation(() => {
      startupOrder.push('channels')
      return channelsMock
    })
    createFactFeedMock.mockImplementation(() => {
      startupOrder.push('feed')
      return feedMock
    })
    createCommandRouterMock.mockImplementation(() => {
      startupOrder.push('router')
      return routerMock
    })
    registerIpcHandlersMock.mockImplementation(() => {
      startupOrder.push('ipc')
    })
    // 每个用例重新装配：恢复默认查询与执行器工厂（上面的实现是跨用例保留的）
    storeMock.query.mockImplementation(storeQueryDefault)
    executorsMock.forRuntime.mockReset()
  })

  it('创建窗口与托盘，并把命令路由接进三动词 IPC', async () => {
    await loadEntry()

    expect(registerIpcHandlersMock).toHaveBeenCalledTimes(1)
    // IPC 只注册三动词的宿主实现：拿到的是装配好的同一个命令路由
    expect(ipcDeps()).toEqual({ router: routerMock })
    expect(appMock.setAppUserModelId).toHaveBeenCalledWith('com.workbench.desktop')
    expect(windows).toHaveLength(1)
    expect(windows[0].loadFile).toHaveBeenCalledTimes(1)
    expect(createTrayMock).toHaveBeenCalledTimes(1)
    // 通知归属：启动就修一遍开始菜单快捷方式（点通知才唤得回已运行的窗口）
    expect(ensureShortcutMock).toHaveBeenCalledTimes(1)
    // 窗口图标显式给：不传就走进程 exe 的资源，开发态（electron.exe）会显示 Electron 图标
    expect(windows[0].options.icon).toBe(path.join('/app', 'resources', 'icon.ico'))

    // 执行器装配：会话根注入 sdk，注册表把清单接成端口工厂
    expect(createSdkHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRoot: expect.stringContaining('sessions'),
        // 默认工作目录：未配置 WORKBENCH_WORKDIR 时落在 <home>/.workbench
        cwd: expect.stringContaining('.workbench'),
      }),
    )
    expect(createExecutorRegistryMock).toHaveBeenCalledWith(pluginEntriesMock, sdkHostMock)

    // 命令路由拿到同一个 store（唯一读入口）与统一写入口（effects.dispatch）
    expect(routerDeps().store).toBe(storeMock)
    routerDeps().dispatch({ type: 'task.remove', commandId: 'c', id: 't' })
    expect(effectsMock.dispatch).toHaveBeenCalledWith({
      type: 'task.remove',
      commandId: 'c',
      id: 't',
    })
    // 路由拿到的执行器工厂与调度器是同一份；默认值来自插件 manifest
    expect(routerDeps().executors.forRuntime).toBe(executorsMock.forRuntime)
    expect(routerDeps().executorDefaults()).toEqual({
      executorKey: 'dsh',
      command: 'dsh',
      profile: 'multica',
    })
    // 宿主视图：运行时表单下拉与 detect 汇总同样来自注册表；detect 由装配根注入 sdkHost
    expect(hostView('runtimes.executors')).toEqual([
      { key: 'dsh', label: 'DeepSeek Harness', command: 'dsh', profile: 'multica' },
    ])
    await expect(Promise.resolve(hostView('runtimes.detected'))).resolves.toEqual([])
    expect(detectAllMock).toHaveBeenCalledWith(sdkHostMock)

    // 事实推送先于开库装配，并订阅到窗口广播
    expect(createFactFeedMock).toHaveBeenCalledTimes(1)
    expect(feedMock.subscribe).toHaveBeenCalledTimes(1)
  })

  it('宿主视图 runtimes.models：走执行器端口，缺运行时给可读错误', async () => {
    await loadEntry()
    storeMock.query.mockImplementation((table: string) =>
      table === 'runtimes.all' ? [{ id: 'rt-1', executorKey: 'dsh' }] : [],
    )

    executorsMock.forRuntime.mockReturnValue({})
    await expect(
      Promise.resolve(hostView('runtimes.models', { runtimeId: 'rt-1' })),
    ).resolves.toEqual([])

    executorsMock.forRuntime.mockReturnValue({ models: async () => [{ id: 'model-1' }] })
    await expect(
      Promise.resolve(hostView('runtimes.models', { runtimeId: 'rt-1' })),
    ).resolves.toEqual([{ id: 'model-1' }])

    // 运行时不存在：可读错误由 IPC 应答信封转给 renderer
    expect(() => hostView('runtimes.models', { runtimeId: 'ghost' })).toThrow('运行时不存在: ghost')
    // 缺参数同样给可读错误（空 runtimeId）
    expect(() => hostView('runtimes.models', undefined)).toThrow('运行时不存在: ')
  })

  it('宿主视图 run.approvals：按 run 的会话 id 读日志，缺运行时给可读错误', async () => {
    await loadEntry()
    storeMock.query.mockImplementation((view: string) =>
      view === 'run.byId' ? { id: 'run-1', sessionId: 'sess-1' } : [],
    )
    // 会话根下没有该会话的日志：降级为空数组，不把任务详情拖垮
    await expect(Promise.resolve(hostView('run.approvals', { runId: 'run-1' }))).resolves.toEqual(
      [],
    )

    storeMock.query.mockImplementation(() => null)
    expect(() => hostView('run.approvals', { runId: 'ghost' })).toThrow('运行不存在: ghost')
  })

  it('宿主视图 runtimes.default-workdir：返回解析后的默认工作目录', async () => {
    await loadEntry()
    const value = hostView('runtimes.default-workdir')
    expect(typeof value).toBe('string')
    expect(value).toContain('.workbench')
  })

  it('executorDefaults：manifest 缺字段 / 非字符串 default 回退空串，未知 key 抛可读错误', async () => {
    type Entry = (typeof pluginEntriesMock)[number]
    const baseManifest = pluginEntriesMock[0].manifest
    // 一个没有 config 清单、一个有 config 但缺 default / default 不是字符串
    const plainEntry = {
      key: 'plain',
      label: 'Plain',
      manifest: { ...baseManifest, id: 'plain', config: undefined },
      plugin: { run: vi.fn() },
    } as unknown as Entry
    const partialEntry = {
      key: 'partial',
      label: 'Partial',
      manifest: {
        ...baseManifest,
        id: 'partial',
        config: [
          { key: 'command', label: '命令', type: 'text' },
          { key: 'profile', label: 'Profile', type: 'text', default: 7 },
        ],
      },
      plugin: { run: vi.fn() },
    } as unknown as Entry
    pluginEntriesMock.push(plainEntry, partialEntry)
    try {
      await loadEntry()
      const defaults = routerDeps().executorDefaults

      expect(defaults()).toEqual({ executorKey: 'dsh', command: 'dsh', profile: 'multica' })
      // 指定已注册 key：走 find 分支，结果与缺省首项一致
      expect(defaults('dsh')).toEqual({
        executorKey: 'dsh',
        command: 'dsh',
        profile: 'multica',
      })
      // manifest 没有 config / 缺 default / default 不是字符串：都回退空串
      expect(defaults('plain')).toEqual({ executorKey: 'plain', command: '', profile: '' })
      expect(defaults('partial')).toEqual({ executorKey: 'partial', command: '', profile: '' })
      expect(() => defaults('nope')).toThrow('执行器插件未注册: nope')
    } finally {
      pluginEntriesMock.splice(1)
    }
  })

  it('启动顺序：事实推送 → 开库 → 建 store → 导入存量 → 对账投影 → 补内置阶段 → 建仓储 → 清崩溃残留 → 通道 → clock → scheduler → 命令路由 → IPC', async () => {
    await loadEntry()

    expect(startupOrder).toEqual([
      'feed',
      'openDatabase',
      'createStore',
      'importLegacy',
      'ensureProjection',
      'ensureBuiltinStages',
      'executors',
      'registry',
      'reconcile',
      'channels',
      'clock',
      'scheduler',
      'router',
      'ipc',
    ])
    // M18：内置阶段补齐读的是投影，必须排在 ensureProjection 之后
    expect(startupOrder.indexOf('ensureBuiltinStages')).toBe(
      startupOrder.indexOf('ensureProjection') + 1,
    )
    expect(storeMock.ensureBuiltinStages).toHaveBeenCalledTimes(1)
    // 事实推送（feed）先建：effects.onFacts / 聊天流旁路在装配期就接到它
    expect(createFactFeedMock).toHaveBeenCalledTimes(1)
    // store 拿到的是内核门面：decide / project / viewSpec / nextWakeAt 纯函数
    const options = createStoreMock.mock.calls[0][0] as {
      db: unknown
      kernel: { decide: unknown; project: unknown; viewSpec: unknown; nextWakeAt: unknown }
    }
    expect(options.db).toBeDefined()
    expect(typeof options.kernel.decide).toBe('function')
    expect(typeof options.kernel.project).toBe('function')
    expect(typeof options.kernel.viewSpec).toBe('function')
    expect(typeof options.kernel.nextWakeAt).toBe('function')
    // 导入接到同一个 db 与 kernel；先导入存量再对账投影（空库无事实时不会清表）
    expect(importLegacyMock).toHaveBeenCalledWith(options.db, options.kernel)
  })

  it('执行链装配：scheduler 走 effects.dispatch，clock 到点唤醒 scheduler，启动先领一次', async () => {
    await loadEntry()

    // scheduler 的写入口包了 effects.dispatch
    schedulerDeps().dispatch({ type: 'run.claim' })
    expect(effectsMock.dispatch).toHaveBeenCalledWith({ type: 'run.claim' })
    // 执行器工厂与 limits 都注入到 scheduler；运行时从 store 读
    expect(schedulerDeps().executors).toBe(executorsMock)
    expect(schedulerDeps().limits).toBe(defaultLimitsMock)
    schedulerDeps().runtimes()
    expect(storeMock.query).toHaveBeenCalledWith('runtimes.all')
    // M27：智能体从同一仓储读（模型 / 思考强度 / 环境变量在它上面）
    schedulerDeps().agents()
    expect(storeMock.query).toHaveBeenCalledWith('agents.all')
    // 帧 seq 从仓储读（重启后续接全局单调）
    expect(schedulerDeps().lastFrameSeq('run-1')).toBe(0)
    // 帧 seq 从 run_events 投影的 MAX(seq) 视图读（不再走仓储 SQL）
    expect(storeMock.query).toHaveBeenCalledWith('run.last-event-seq', { runId: 'run-1' })

    // effects：调度器惰性解析 + 提交后的事实交给 feed 批次推送
    expect(effectsDeps().scheduler()).toBe(schedulerMock)
    const committed = [{ seq: 1, type: 'task.created' }]
    effectsDeps().onFacts?.(committed)
    expect(feedMock.publish).toHaveBeenCalledWith(committed)

    // clock：dispatch 也走 effects；onTick 唤醒调度器；nextWakeAt 透传 store
    clockDeps().store.dispatch({ type: 'clock.tick' })
    expect(effectsMock.dispatch).toHaveBeenCalledWith({ type: 'clock.tick' })
    clockDeps().store.nextWakeAt('2026-01-01T00:00:00.000Z')
    expect(storeMock.nextWakeAt).toHaveBeenCalledWith('2026-01-01T00:00:00.000Z')
    clockDeps().onTick()
    expect(schedulerMock.wake).toHaveBeenCalled()
    // 时钟取真实毫秒时间戳（内核只认注入的 now，不读系统时钟）
    expect(typeof (createClockMock.mock.calls[0][0] as { now: () => string }).now()).toBe('string')

    // 启动：先主动领一次，再挂定时器
    expect(schedulerMock.wake).toHaveBeenCalled()
    expect(clockMock.start).toHaveBeenCalledTimes(1)
    expect(startupOrder).not.toContain('runner')

    // 调度器领取 / 收尾后重排时钟：启动之后才出现的租约与超时靠这条接线排期
    schedulerDeps().rearmClock?.()
    expect(clockMock.rearm).toHaveBeenCalledTimes(1)
  })

  it('通道装配：effects 之后 startAll、再起 clock/scheduler；effects 惰性拿到同一个 hub', async () => {
    await loadEntry()

    // hub 拿到同一个 store / effects / 注册表清单 / sdkHost（通道只能经 effects 写库）
    expect(createChannelsMock).toHaveBeenCalledTimes(1)
    const deps = channelsDeps()
    expect(deps.store).toBe(storeMock)
    expect(deps.effects).toBe(effectsMock)
    // M7：装配根把内置 + 用户目录（此处为空）合并后的清单传进来；空清单语义等价于空数组
    expect(deps.entries).toEqual([])
    expect(deps.sdkHost).toBe(sdkHostMock)
    // M7：通道按插件设置决定启停与配置（回调由装配根注入，hub 不读库）
    expect(typeof deps.configOf).toBe('function')
    expect(typeof deps.isEnabled).toBe('function')

    // 启动即 startAll（补投 pending 卡片）；顺序在 effects 之后、clock/scheduler 之前
    expect(channelsMock.startAll).toHaveBeenCalledTimes(1)
    expect(startupOrder.indexOf('reconcile')).toBeLessThan(startupOrder.indexOf('channels'))
    expect(startupOrder.indexOf('channels')).toBeLessThan(startupOrder.indexOf('clock'))
    expect(startupOrder.indexOf('channels')).toBeLessThan(startupOrder.indexOf('scheduler'))
    expect(startupOrder.indexOf('channels')).toBeLessThan(startupOrder.indexOf('ipc'))

    // effects 的通道 getter 惰性解析到同一个 hub
    expect(effectsDeps().channels?.()).toBe(channelsMock)
  })

  it('M7 装配：net / 用户插件目录 / secret 存储 / 来源 hub / 插件命令依赖接线', async () => {
    await loadEntry()

    // 能力面：net 原件注入 sdkHost（插件按 manifest 声明门控）
    expect(createNetCapabilityMock).toHaveBeenCalledTimes(1)
    expect(createSdkHostMock.mock.calls[0][0]).toMatchObject({ net: netMock })

    // 用户目录扫描：根 = <userData>/plugins，内置清单来自注册表（executors/channels/sources）
    expect(discoverExternalPluginsMock).toHaveBeenCalledTimes(1)
    const discoverOptions = discoverExternalPluginsMock.mock.calls[0][0] as {
      pluginsRoot: string
      builtins: Array<{ kind: string; id: string }>
    }
    expect(discoverOptions.pluginsRoot.endsWith('plugins')).toBe(true)
    expect(discoverOptions.builtins).toEqual([{ kind: 'executor', id: 'dsh' }])

    // secret 存储：cipher 由装配根注入（safeStorage 适配），启动不写任何 secret
    expect(createPluginSecretsMock).toHaveBeenCalledTimes(1)
    expect(pluginSecretsMock.setSecret).not.toHaveBeenCalled()

    // 来源 hub：通道之后启动；退出先停来源再停通道（见 before-quit 用例）
    expect(createSourcesMock).toHaveBeenCalledTimes(1)
    const sourcesDeps = createSourcesMock.mock.calls[0][0] as {
      entries: unknown[]
      effects: unknown
      sdkHost: unknown
      configOf: (entry: unknown) => Record<string, unknown>
      isEnabled: (entry: unknown) => boolean
      log: (line: string) => void
    }
    expect(sourcesDeps.entries).toEqual([])
    expect(sourcesDeps.effects).toBe(effectsMock)
    expect(sourcesDeps.sdkHost).toBe(sdkHostMock)
    expect(typeof sourcesDeps.configOf).toBe('function')
    expect(typeof sourcesDeps.isEnabled).toBe('function')
    // 来源日志汇到宿主日志通道
    sourcesDeps.log('来源诊断')
    expect(sdkHostMock.log).toHaveBeenCalledWith('来源诊断')
    expect(sourcesMock.startAll).toHaveBeenCalledTimes(1)
    expect(sourcesMock.startAll.mock.invocationCallOrder[0]).toBeGreaterThan(
      channelsMock.startAll.mock.invocationCallOrder[0] as number,
    )

    // 命令路由拿到插件编排依赖：磁盘条目 / 视图行 / secret 写入
    const plugins = routerDeps().plugins
    expect(plugins).toBeDefined()
    expect(plugins?.entry('dsh')).toEqual({
      manifest: pluginEntriesMock[0].manifest,
      builtin: true,
    })
    expect(plugins?.entry('missing')).toBeNull()
  })

  it('hub 尚未挂上时取 effects 的通道 getter：给可读错误而不是 undefined', async () => {
    let caught: unknown = null
    // 在 createChannels 构造过程中（holder 还没赋值）访问 getter
    createChannelsMock.mockImplementationOnce(() => {
      try {
        effectsDeps().channels?.()
      } catch (error) {
        caught = error
      }
      startupOrder.push('channels')
      return channelsMock
    })

    await loadEntry()

    expect((caught as Error).message).toBe('通道 hub 尚未装配')
  })

  it('启动对账：读 process_registry 清崩溃残留（registry → reconcile），再接 scheduler/clock', async () => {
    await loadEntry()

    expect(createProcessRegistryMock).toHaveBeenCalledTimes(1)
    expect(reconcileMock).toHaveBeenCalledTimes(1)
    const deps = reconcileDeps()
    expect(deps.registry).toBe(registryMock)
    expect(deps.killPid).toBe(killPidTreeMock)
    // 启动期 scheduler 还没装配：对账直接写库；run 状态缺失归 null（只清登记行）
    deps.dispatch({ type: 'clock.tick' })
    expect(storeMock.dispatch).toHaveBeenCalledWith({ type: 'clock.tick' })
    expect(deps.runStatus('run-1')).toBe('running')
    expect(deps.runStatus('ghost')).toBeNull()
    // 崩溃时中断的聊天 run 由对账落兜底终态（查询来自仓储的投影读）
    expect(deps.staleChatRuns?.()).toEqual([])
    expect(storeMock.query).toHaveBeenCalledWith('runs.stale-chat')
    // M4 D13：waiting run + 是否有 open 卡由 runs.waiting 视图给出（宿主读路径 join）
    expect(deps.waitingRuns?.()).toEqual([
      { id: 'run-1', leaseId: null, turn: 1, hasOpenCard: true },
      { id: 'run-2', leaseId: null, turn: 2, hasOpenCard: false },
    ])
    expect(storeMock.query).toHaveBeenCalledWith('runs.waiting')
    // run 状态读投影（run.byId），缺失即 null
    expect(storeMock.query).toHaveBeenCalledWith('run.byId', { runId: 'ghost' })
    // 登记表与 scheduler 共用同一实例（执行期 begin/attachPid/remove 才接得上）
    expect(schedulerDeps().registry).toBe(registryMock)
    // 顺序：对账在 scheduler 装配、IPC 注册与定时器之前
    expect(startupOrder.indexOf('reconcile')).toBeLessThan(startupOrder.indexOf('scheduler'))
    expect(startupOrder.indexOf('reconcile')).toBeLessThan(startupOrder.indexOf('ipc'))
    expect(startupOrder.indexOf('reconcile')).toBeLessThan(startupOrder.indexOf('clock'))
  })
  it('对账有回收结果：留一条 warn 诊断（不建 UI 通道）', async () => {
    reconcileMock.mockReturnValueOnce({ killed: 2, cleared: 1, facts: 3 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await loadEntry()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('[reconcile]')
      expect(String(warn.mock.calls[0]?.[0])).toContain('终止残留进程 2 个')
    } finally {
      warn.mockRestore()
    }
  })

  it('对账兜底了无卡 waiting：同样留一条 warn 诊断', async () => {
    reconcileMock.mockReturnValueOnce({
      killed: 0,
      cleared: 0,
      settledChats: 0,
      settledWaitings: 1,
      facts: 0,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await loadEntry()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('[reconcile]')
    } finally {
      warn.mockRestore()
    }
  })

  it('拿到单实例锁：不退出，正常装配窗口与 IPC', async () => {
    await loadEntry()

    expect(appMock.requestSingleInstanceLock).toHaveBeenCalledTimes(1)
    expect(appMock.quit).not.toHaveBeenCalled()
    expect(windows).toHaveLength(1)
    expect(registerIpcHandlersMock).toHaveBeenCalledTimes(1)
  })

  it('未拿到单实例锁：立即退出，不装配窗口/托盘/数据库/IPC', async () => {
    appMock.requestSingleInstanceLock.mockReturnValueOnce(false)
    await importEntry()

    expect(appMock.quit).toHaveBeenCalledTimes(1)
    expect(appMock.whenReady).not.toHaveBeenCalled()
    expect(appMock.on).not.toHaveBeenCalledWith('second-instance', expect.any(Function))
    expect(registerIpcHandlersMock).not.toHaveBeenCalled()
    expect(createFactFeedMock).not.toHaveBeenCalled()
    expect(createCommandRouterMock).not.toHaveBeenCalled()
    expect(createTrayMock).not.toHaveBeenCalled()
    expect(openDatabaseMock).not.toHaveBeenCalled()
    expect(createStoreMock).not.toHaveBeenCalled()
    expect(storeMock.ensureProjection).not.toHaveBeenCalled()
    expect(storeMock.ensureBuiltinStages).not.toHaveBeenCalled()
    expect(importLegacyMock).not.toHaveBeenCalled()
    expect(createProcessRegistryMock).not.toHaveBeenCalled()
    expect(reconcileMock).not.toHaveBeenCalled()
    expect(killPidTreeMock).not.toHaveBeenCalled()
    expect(createSchedulerMock).not.toHaveBeenCalled()
    expect(createEffectsMock).not.toHaveBeenCalled()
    expect(createChannelsMock).not.toHaveBeenCalled()
    expect(createClockMock).not.toHaveBeenCalled()
    expect(createExecutorRegistryMock).not.toHaveBeenCalled()
    expect(windows).toHaveLength(0)
  })

  it('注入给插件的 notify：弹之前先修一遍通知归属快捷方式（Electron 是首次弹通知时才补自己那条）', async () => {
    await loadEntry()
    const deps = createSdkHostMock.mock.calls[0][0] as {
      notify: (title: string, body: string, target?: { cardId?: string }) => boolean
    }
    ensureShortcutMock.mockClear()

    deps.notify('番茄时钟', '已进入短休息')

    expect(ensureShortcutMock).toHaveBeenCalledTimes(1)
  })

  it('second-instance：有窗口时唤出（最小化的先还原），窗口都没了则重建', async () => {
    await loadEntry()
    const secondInstance = appHandler('second-instance')

    secondInstance()
    expect(windows[0].isMinimized).toHaveBeenCalled()
    expect(windows[0].restore).not.toHaveBeenCalled()
    expect(windows[0].show).toHaveBeenCalledTimes(1)
    expect(windows[0].focus).toHaveBeenCalledTimes(1)

    // 最小化时只 show() 不会弹回来（点系统通知落到这里的那条路径）
    windows[0].isMinimized.mockReturnValue(true)
    secondInstance()
    expect(windows[0].restore).toHaveBeenCalledTimes(1)

    windows.length = 0
    secondInstance()
    expect(windows).toHaveLength(1)
  })

  it('开发服务器地址存在时加载 URL', async () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://127.0.0.1:5173'
    await loadEntry()

    expect(windows[0].loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173')
    expect(windows[0].loadFile).not.toHaveBeenCalled()
  })

  it('窗口事件：就绪显示、关窗隐藏、外链拦截', async () => {
    await loadEntry()

    windowHandler('ready-to-show')()
    expect(windows[0].show).toHaveBeenCalledTimes(1)

    // 点 X：未退出时隐藏而不是关闭
    const event = { preventDefault: vi.fn() }
    windowHandler('close')(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(windows[0].hide).toHaveBeenCalledTimes(1)

    // 外链交给系统浏览器，窗口内拒绝打开
    const handler = windows[0].webContents.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string
    }) => { action: string }
    expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(shellMock.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('M7 插件目录合并：用户覆盖内置 / 跨 kind 撞 id 拒绝 / 内置通道与来源走注册表', async () => {
    const builtinChannel = {
      key: 'webhook-channel',
      label: 'Webhook 通道',
      manifest: {
        id: 'webhook-channel',
        kind: 'channel',
        name: 'Webhook 通道',
        version: '1.0.0',
        capabilities: ['net'],
      },
      plugin: { start: vi.fn() },
    }
    const builtinSource = {
      key: 'webhook',
      label: 'Webhook 来源',
      manifest: {
        id: 'webhook',
        kind: 'source',
        name: 'Webhook 来源',
        version: '1.0.0',
        capabilities: ['net'],
      },
      plugin: { start: vi.fn() },
    }
    channelsEntriesMock.push(builtinChannel)
    sourcesEntriesMock.push(builtinSource)
    const overrideEntry: ExternalPluginEntry = {
      kind: 'channel',
      id: 'webhook-channel',
      manifest: {
        id: 'webhook-channel',
        kind: 'channel',
        name: '覆盖版 Webhook 通道',
        version: '2.0.0',
        capabilities: ['net'],
      },
      dir: '/plugins/channel/webhook-channel',
      entry: '/plugins/channel/webhook-channel/plugin.mjs',
      overridesBuiltin: true,
    }
    const duplicateEntry: ExternalPluginEntry = {
      kind: 'source',
      id: 'dsh',
      manifest: {
        id: 'dsh',
        kind: 'source',
        name: '撞 id 的来源',
        version: '1.0.0',
        capabilities: [],
      },
      dir: '/plugins/source/dsh',
      entry: '/plugins/source/dsh/plugin.mjs',
      overridesBuiltin: false,
    }
    discoverExternalPluginsMock.mockResolvedValueOnce({
      entries: [overrideEntry, duplicateEntry],
      rejections: [],
      missingRoot: false,
    })
    try {
      await loadEntry()

      // 用户目录同 kind+id 覆盖内置：内置通道不被启动，改由外部适配器提供
      expect(createExternalChannelPluginMock).toHaveBeenCalledWith(
        overrideEntry,
        expect.objectContaining({ execPath: expect.any(String) }),
      )
      const channelEntries = channelsDeps().entries as Array<{ key: string }>
      expect(channelEntries).toHaveLength(1)
      expect(channelEntries[0]?.key).toBe('webhook-channel')

      // 内置来源走 registry（不经适配器）
      const sourceEntries = createSourcesMock.mock.calls[0][0] as {
        entries: Array<{ key: string }>
      }
      expect(sourceEntries.entries.map((entry) => entry.key)).toEqual(['webhook'])

      // 跨 kind 撞 id：保留内置 executor，外部 source 以 manifest_error 出现
      const views = hostView('plugins.all') as Array<Record<string, unknown>>
      expect(views.filter((view) => view.id === 'dsh')).toHaveLength(2)
      expect(
        views.find((view) => view.id === 'dsh' && view.status === 'manifest_error'),
      ).toMatchObject({
        error: '插件 id 已被占用: dsh',
      })
      expect(views.find((view) => view.id === 'webhook-channel')).toMatchObject({
        builtin: false,
        version: '2.0.0',
      })
    } finally {
      channelsEntriesMock.pop()
      sourcesEntriesMock.pop()
    }
  })

  it('M7 插件设置页分支：停用/未授权/拒绝项 kind 兜底；cipher 与适配器日志走宿主原件', async () => {
    const externalChannel: ExternalPluginEntry = {
      kind: 'channel',
      id: 'ext-channel',
      manifest: {
        id: 'ext-channel',
        kind: 'channel',
        name: '外部通道',
        version: '1.0.0',
        capabilities: ['net'],
      },
      dir: '/plugins/channel/ext-channel',
      entry: '/plugins/channel/ext-channel/plugin.mjs',
      overridesBuiltin: false,
    }
    const externalSource: ExternalPluginEntry = {
      kind: 'source',
      id: 'ext-source',
      manifest: {
        id: 'ext-source',
        kind: 'source',
        name: '外部来源',
        version: '1.0.0',
        capabilities: ['net'],
      },
      dir: '/plugins/source/ext-source',
      entry: '/plugins/source/ext-source/plugin.mjs',
      overridesBuiltin: false,
    }
    discoverExternalPluginsMock.mockResolvedValueOnce({
      entries: [externalChannel, externalSource],
      rejections: [
        {
          path: 'unknown-dir',
          kind: null,
          id: null,
          reason: 'manifest_invalid',
          detail: '未知目录',
        },
      ],
      missingRoot: false,
    })
    // 停用但已授权 → disabled；来源运行中 → ready
    sourcesMock.statuses.mockReturnValue([{ key: 'ext-source', state: 'running', error: null }])
    storeMock.query.mockImplementation((view: string) => {
      if (view === 'plugins.settings') {
        return {
          version: 1,
          replacedAt: '2026-11-05T00:00:00.000Z',
          settings: [
            { id: 'ext-channel', kind: 'channel', enabled: false, granted: ['net'], config: {} },
            { id: 'ext-source', kind: 'source', enabled: true, granted: ['net'], config: {} },
          ],
        }
      }
      return storeQueryDefault(view)
    })
    await loadEntry()

    const views = hostView('plugins.all') as Array<Record<string, unknown>>
    expect(views.find((view) => view.id === 'ext-channel')?.status).toBe('disabled')
    expect(views.find((view) => view.id === 'ext-source')?.status).toBe('ready')
    // kind 缺失的拒绝项按 source 兜底展示
    expect(views.find((view) => view.id === 'unknown-dir')).toMatchObject({
      kind: 'source',
      status: 'manifest_error',
    })

    // cipher 适配包住 safeStorage；适配器的 log 汇到 sdkHost
    const secretsOptions = createPluginSecretsMock.mock.calls[0][0] as {
      cipher: {
        available(): boolean
        encrypt(plain: string): string
        decrypt(value: string): string
      }
      log: (line: string) => void
    }
    expect(secretsOptions.cipher.available()).toBe(true)
    expect(secretsOptions.cipher.encrypt('x')).toBe(Buffer.from('cipher').toString('base64'))
    expect(secretsOptions.cipher.decrypt('Y2lwaGVy')).toBe('plain')
    secretsOptions.log('诊断')
    expect(sdkHostMock.log).toHaveBeenCalledWith('诊断')
    const adapterOptions = createExternalChannelPluginMock.mock.calls[0][1] as {
      log: (line: string) => void
    }
    adapterOptions.log('适配器日志')
    expect(sdkHostMock.log).toHaveBeenCalledWith('适配器日志')
  })

  it('M7 插件视图：内置 + 外部插件 + manifest 拒绝项 + 来源错误状态', async () => {
    const externalChannel: ExternalPluginEntry = {
      kind: 'channel',
      id: 'ext-channel',
      manifest: {
        id: 'ext-channel',
        kind: 'channel',
        name: '外部通道',
        version: '1.0.0',
        capabilities: ['net'],
      },
      dir: '/plugins/channel/ext-channel',
      entry: '/plugins/channel/ext-channel/plugin.mjs',
      overridesBuiltin: false,
    }
    const externalSource: ExternalPluginEntry = {
      kind: 'source',
      id: 'ext-source',
      manifest: {
        id: 'ext-source',
        kind: 'source',
        name: '外部来源',
        version: '1.0.0',
        capabilities: ['net'],
      },
      dir: '/plugins/source/ext-source',
      entry: '/plugins/source/ext-source/plugin.mjs',
      overridesBuiltin: false,
    }
    discoverExternalPluginsMock.mockResolvedValueOnce({
      entries: [externalChannel, externalSource],
      rejections: [
        {
          path: 'source/bad',
          kind: 'source',
          id: 'bad',
          reason: 'manifest_invalid',
          detail: '坏清单',
        },
      ],
      missingRoot: false,
    })
    sourcesMock.statuses.mockReturnValue([{ key: 'ext-source', state: 'error', error: '端口占用' }])
    // 外部来源已启用且授权：覆盖 pluginEnabled/pluginAuthorized 的 true 分支
    storeMock.query.mockImplementation((view: string) => {
      if (view === 'plugins.settings') {
        return {
          version: 1,
          replacedAt: '2026-11-05T00:00:00.000Z',
          settings: [
            {
              id: 'ext-source',
              kind: 'source',
              enabled: true,
              granted: ['net'],
              config: { port: 1 },
            },
          ],
        }
      }
      return storeQueryDefault(view)
    })
    await loadEntry()

    // 外部插件适配器按合并后的清单组装（granted / config 由设置与授权决定）
    expect(createExternalChannelPluginMock).toHaveBeenCalledWith(
      externalChannel,
      expect.objectContaining({ granted: [], config: {} }),
    )
    expect(createExternalSourcePluginMock).toHaveBeenCalledWith(
      externalSource,
      expect.objectContaining({ granted: ['net'], config: {} }),
    )
    const channelEntries = channelsDeps().entries as Array<{ key: string }>
    const sourceEntries = createSourcesMock.mock.calls[0][0] as {
      entries: Array<{ key: string }>
    }
    expect(channelEntries.map((entry) => entry.key)).toContain('ext-channel')
    expect(sourceEntries.entries.map((entry) => entry.key)).toContain('ext-source')

    // 宿主视图：内置 ready / 外部未授权 / 已启用来源 error（带原因）/ 清单拒绝项
    const views = hostView('plugins.all') as Array<Record<string, unknown>>
    expect(views.find((view) => view.id === 'dsh')).toMatchObject({
      builtin: true,
      status: 'ready',
    })
    expect(views.find((view) => view.id === 'ext-channel')).toMatchObject({
      builtin: false,
      status: 'unauthorized',
    })
    expect(views.find((view) => view.id === 'ext-source')).toMatchObject({
      status: 'error',
      error: '端口占用',
      granted: ['net'],
    })
    expect(views.find((view) => view.id === 'bad')).toMatchObject({
      status: 'manifest_error',
      error: '坏清单',
    })

    // 通道 / 来源的启停与配置回调按插件 id 查目录（未知 id 有兜底）
    const channelDeps = channelsDeps()
    expect(channelDeps.configOf?.({ key: 'unknown' } as never)).toEqual({})
    expect(channelDeps.isEnabled?.({ key: 'unknown' } as never)).toBe(true)
    const sourceDeps = createSourcesMock.mock.calls[0][0] as {
      configOf: (entry: { key: string }) => Record<string, unknown>
      isEnabled: (entry: { key: string }) => boolean
    }
    expect(sourceDeps.configOf({ key: 'unknown' })).toEqual({})
    expect(sourceDeps.isEnabled({ key: 'unknown' })).toBe(true)
  })

  it('M7 插件命令依赖：entry / view / writeSecrets（含安全存储不可用拒绝）', async () => {
    await loadEntry()
    const plugins = routerDeps().plugins
    expect(plugins).toBeDefined()
    expect(plugins?.view('dsh')).toMatchObject({ id: 'dsh', builtin: true })
    expect(plugins?.view('missing')).toBeNull()

    plugins?.writeSecrets('dsh', { secret: 'v', other: null })
    expect(pluginSecretsMock.setSecret).toHaveBeenCalledWith('dsh', 'secret', 'v')
    expect(pluginSecretsMock.removeSecret).toHaveBeenCalledWith('dsh', 'other')

    pluginSecretsMock.setSecret.mockImplementationOnce(() => {
      throw new Error('secret_cipher_unavailable: 宿主未提供安全存储')
    })
    expect(() => plugins?.writeSecrets('dsh', { secret: 'v' })).toThrow(
      '无法保存插件 secret：secret_cipher_unavailable',
    )
    // 非 Error 抛出：文案用 String 兜底
    pluginSecretsMock.setSecret.mockImplementationOnce(() => {
      throw 'boom'
    })
    expect(() => plugins?.writeSecrets('dsh', { secret: 'v' })).toThrow('无法保存插件 secret：boom')
  })

  it('M7 内置通道/来源仍走注册表（无用户覆盖）且拒绝项路径为空时有兜底名称', async () => {
    const builtinChannel = {
      key: 'webhook-channel',
      label: 'Webhook 通道',
      manifest: {
        id: 'webhook-channel',
        kind: 'channel',
        name: 'Webhook 通道',
        version: '1.0.0',
        capabilities: ['net'],
      },
      plugin: { start: vi.fn() },
    }
    const builtinSource = {
      key: 'webhook',
      label: 'Webhook 来源',
      manifest: {
        id: 'webhook',
        kind: 'source',
        name: 'Webhook 来源',
        version: '1.0.0',
        capabilities: ['net'],
      },
      plugin: { start: vi.fn() },
    }
    channelsEntriesMock.push(builtinChannel)
    sourcesEntriesMock.push(builtinSource)
    discoverExternalPluginsMock.mockResolvedValueOnce({
      entries: [],
      rejections: [
        { path: '', kind: 'channel', id: null, reason: 'entry_missing', detail: '缺入口' },
      ],
      missingRoot: false,
    })
    try {
      await loadEntry()

      const channelDeps = channelsDeps()
      const channelEntries = channelDeps.entries as Array<{ key: string }>
      expect(channelEntries).toEqual([builtinChannel])
      // 已知通道：找到目录项；未知通道：兜底空配置 / 默认启用
      expect(channelDeps.configOf?.({ key: 'webhook-channel' } as never)).toEqual({})
      expect(channelDeps.isEnabled?.({ key: 'webhook-channel' } as never)).toBe(true)
      expect(channelDeps.configOf?.({ key: 'missing' } as never)).toEqual({})
      expect(channelDeps.isEnabled?.({ key: 'missing' } as never)).toBe(true)

      const sourceDeps = createSourcesMock.mock.calls[0][0] as {
        entries: Array<{ key: string }>
        configOf: (entry: { key: string }) => Record<string, unknown>
        isEnabled: (entry: { key: string }) => boolean
      }
      expect(sourceDeps.entries).toEqual([builtinSource])
      expect(sourceDeps.configOf({ key: 'webhook' })).toEqual({})
      expect(sourceDeps.isEnabled({ key: 'webhook' })).toBe(true)
      expect(sourceDeps.configOf({ key: 'missing' })).toEqual({})
      expect(sourceDeps.isEnabled({ key: 'missing' })).toBe(true)

      // 拒绝项 path 为空 → 名称兜底「插件目录」，id 空时用 path（空串）作 id
      const views = hostView('plugins.all') as Array<Record<string, unknown>>
      expect(views.find((view) => view.status === 'manifest_error')).toMatchObject({
        id: '',
        name: '插件目录',
        kind: 'channel',
      })
    } finally {
      channelsEntriesMock.pop()
      sourcesEntriesMock.pop()
    }
  })

  it('before-quit：关窗不再拦截，活跃 run best-effort 取消、通道 stopAll、推送停表', async () => {
    await loadEntry()

    appHandler('before-quit')()
    // 退出前取消活跃 run（T15）：不等待回执，直接 cancelAll
    expect(schedulerMock.cancelAll).toHaveBeenCalledTimes(1)
    // 通道 abort + best-effort dispose（D9）：异步、不阻塞退出
    expect(channelsMock.stopAll).toHaveBeenCalledTimes(1)
    // M7：来源先停（不再接收外部事件），再停通道
    expect(sourcesMock.stopAll).toHaveBeenCalledTimes(1)
    // 推送停表：退出后不再排批次（已入账的事实仍完整）
    expect(feedMock.stop).toHaveBeenCalledTimes(1)
    const event = { preventDefault: vi.fn() }
    windowHandler('close')(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('托盘点击与 activate：无窗口时重建，有窗口时唤出', async () => {
    await loadEntry()
    const trayClick = createTrayMock.mock.calls[0][1] as () => void

    // 有窗口：直接唤出
    trayClick()
    expect(windows[0].show).toHaveBeenCalled()
    expect(windows[0].focus).toHaveBeenCalled()

    // 没有窗口：重建后再唤出
    windows.length = 0
    trayClick()
    expect(windows).toHaveLength(1)

    // activate：无窗口重建，有窗口显示
    appHandler('activate')()
    expect(windows[0].show).toHaveBeenCalled()
    windows.length = 0
    appHandler('activate')()
    expect(windows).toHaveLength(1)
  })

  it('聊天流经 scheduler 旁路交给 feed，再由订阅广播到所有窗口', async () => {
    await loadEntry()

    const deps = schedulerDeps()
    expect(deps.onChatStream).toBeTypeOf('function')
    expect(deps.onChatStreamEnd).toBeTypeOf('function')
    const frame = { seq: 1, type: 'text', text: '你好' }
    deps.onChatStream?.('run-1', 'c1', frame)
    deps.onChatStreamEnd?.('run-1', 'c1')

    // scheduler → feed.stream：旁路事件带 kind 与 runId / conversationId
    expect(feedMock.stream).toHaveBeenCalledWith({
      kind: 'stream',
      runId: 'run-1',
      conversationId: 'c1',
      event: frame,
    })
    expect(feedMock.stream).toHaveBeenCalledWith({
      kind: 'stream-end',
      runId: 'run-1',
      conversationId: 'c1',
    })

    // feed 订阅者把同一事件推给所有窗口（新开的窗口也经订阅拿到）
    const second = new BrowserWindowMock({})
    const event = { kind: 'stream-end', runId: 'run-1', conversationId: 'c1' }
    feedListener()(event)
    expect(windows[0].webContents.send).toHaveBeenCalledWith(WORKBENCH_EVENT_CHANNEL, event)
    expect(second.webContents.send).toHaveBeenCalledWith(WORKBENCH_EVENT_CHANNEL, event)
  })

  it('window-all-closed 在非 macOS 退出应用', async () => {
    await loadEntry()

    appHandler('window-all-closed')()
    expect(appMock.quit).toHaveBeenCalledTimes(1)
  })

  it('chatFallbackPrompt：续接被拒时用完整历史 prompt；非 chat / 缺配置返回 null', async () => {
    await loadEntry()

    const fallback = schedulerDeps().chatFallbackPrompt as (run: unknown) => string | null
    const agent = {
      id: 'ag-1',
      systemPrompt: '你是助手。',
      name: '助手',
      description: '',
      runtimeId: 'rt-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const messages = [
      { id: 'm1', conversationId: 'cv-1', role: 'user', content: '早' },
      { id: 'm2', conversationId: 'cv-1', role: 'assistant', content: '早呀' },
    ]
    const run = { id: 'run-1', purpose: 'chat', conversationId: 'cv-1', agentId: 'ag-1' }

    storeMock.query.mockImplementation((table: string) =>
      table === 'agents.all' ? [agent] : messages,
    )
    expect(fallback(run)).toBe(
      `你是助手。\n\n# 对话记录\n\n用户：早\n助手：早呀\n\n请回答最后一条用户消息。\n\n${receiptBlockHint(CHAT_RECEIPT_KEYS)}`,
    )

    // 非聊天 run / 没有对话：回退不适用
    expect(fallback({ ...run, purpose: 'stage' })).toBeNull()
    expect(fallback({ ...run, conversationId: null })).toBeNull()

    // 智能体不存在：不拼 prompt
    storeMock.query.mockImplementation((table: string) => (table === 'agents.all' ? [] : messages))
    expect(fallback(run)).toBeNull()

    // 对话还没有消息：不拼 prompt
    storeMock.query.mockImplementation((table: string) => (table === 'agents.all' ? [agent] : []))
    expect(fallback(run)).toBeNull()
  })

  it('事实推送：窗口 webContents 已销毁时丢弃该窗口，不打断其它窗口', async () => {
    await loadEntry()

    const event = { kind: 'stream', runId: 'run-1', conversationId: null, event: { seq: 1 } }
    windows[0].webContents.send.mockImplementationOnce(() => {
      throw new Error('webContents 已销毁')
    })

    expect(() => feedListener()(event)).not.toThrow()
    // 下一次推送不受影响（隔离在单个窗口的 try/catch 内）
    feedListener()(event)
    expect(windows[0].webContents.send).toHaveBeenCalledTimes(2)
  })

  it('打包态：托盘图标取 process.resourcesPath', async () => {
    appMock.isPackaged = true
    try {
      await loadEntry()
      expect(createTrayMock.mock.calls[0]?.[0]).toBe(process.resourcesPath)
    } finally {
      appMock.isPackaged = false
    }
  })

  it('window-all-closed 在 macOS 不退出应用', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      await loadEntry()
      appHandler('window-all-closed')()
      expect(appMock.quit).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })
})
