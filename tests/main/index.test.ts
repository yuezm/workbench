// @vitest-environment node
/**
 * 主进程入口（src/main/index.ts）的装配补测：只覆盖两处此前未触达的装配分支。
 *
 * 入口是单例、副作用多，测试沿用 `tests/host/boot.test.ts` 的“mock electron + 各宿主模块”
 * 思路，但这里只保留最小能力面，验证：
 * ① 默认工作目录解析失败时，装配根注入的日志回调把原因交给 `console.warn`；
 * ② 宿主视图 `run.approvals` 缺 `runId` 参数时按空串兜底并抛可读错误。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const windows: unknown[] = []
  class BrowserWindowMock {
    static getAllWindows = (): unknown[] => windows
    navigationHandlers: Array<(event: { preventDefault(): void }, url: string) => void> = []
    windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null
    webContents = {
      send: (): void => undefined,
      on: (
        event: string,
        handler: (event: { preventDefault(): void }, url: string) => void,
      ): void => {
        if (event === 'will-navigate') this.navigationHandlers.push(handler)
      },
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }): void => {
        this.windowOpenHandler = handler
      },
    }
    on = (): void => undefined
    show = (): void => undefined
    hide = (): void => undefined
    focus = (): void => undefined
    loadURL = (): void => undefined
    loadFile = (): void => undefined
    constructor() {
      windows.push(this)
    }
  }
  const storeQuery = (table: string): unknown => {
    if (table === 'plugins.settings') return { version: 0, replacedAt: null, settings: [] }
    if (table === 'run.byId') return null
    return []
  }
  const storeMock = {
    ensureProjection: (): { rebuilt: boolean } => ({ rebuilt: false }),
    query: vi.fn(storeQuery),
    nextWakeAt: (): null => null,
    dispatch: (): { facts: unknown[] } => ({ facts: [] }),
  }
  const routerMock = {
    dispatch: vi.fn(async (): Promise<unknown> => ({ facts: [], value: null })),
    query: vi.fn(async (): Promise<unknown> => null),
  }
  const feedMock = {
    publish: (): void => undefined,
    stream: (): void => undefined,
    subscribe: (): void => undefined,
    flush: (): void => undefined,
    stop: (): void => undefined,
  }
  const channelsMock = {
    startAll: vi.fn(async (): Promise<void> => undefined),
    stopAll: vi.fn(async (): Promise<void> => undefined),
    dispatch: (): void => undefined,
    answer: vi.fn(async (): Promise<void> => undefined),
  }
  const sourcesMock = {
    startAll: vi.fn(async (): Promise<void> => undefined),
    stopAll: vi.fn(async (): Promise<void> => undefined),
    statuses: (): unknown[] => [],
  }
  const schedulerMock = {
    wake: (): void => undefined,
    start: (): void => undefined,
    cancel: (): void => undefined,
    cancelAll: (): void => undefined,
    active: (): unknown[] => [],
    idle: vi.fn(async (): Promise<void> => undefined),
  }
  const clockMock = {
    start: (): void => undefined,
    stop: (): void => undefined,
    wake: (): void => undefined,
    rearm: (): void => undefined,
    nextAt: (): null => null,
  }
  const effectsMock = {
    dispatch: (): { facts: unknown[] } => ({ facts: [] }),
    afterCommit: (): void => undefined,
  }
  const pluginExecutors = [
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
      plugin: { run: (): void => undefined },
    },
  ]
  const registryEntries: unknown[] = []
  return {
    windows,
    BrowserWindowMock,
    storeMock,
    routerMock,
    feedMock,
    channelsMock,
    sourcesMock,
    schedulerMock,
    clockMock,
    effectsMock,
    pluginExecutors,
    registryEntries,
    // 捕获 resolveWorkdir 注入的日志回调
    workdirLog: { value: null as null | ((line: string) => void) },
    appMock: {
      whenReady: (): Promise<void> => Promise.resolve(),
      setAppUserModelId: (): void => undefined,
      getPath: (): string => `${process.env.TEMP ?? '.'}/wb-index-cov`,
      requestSingleInstanceLock: (): boolean => true,
      on: (): void => undefined,
      quit: (): void => undefined,
      isPackaged: false,
      getAppPath: (): string => '/app',
    },
    safeStorageMock: {
      isEncryptionAvailable: (): boolean => true,
      encryptString: (): Buffer => Buffer.from('cipher'),
      decryptString: (): string => 'plain',
    },
    shellMock: { openExternal: vi.fn() },
    createFactFeedMock: vi.fn(() => feedMock),
    createCommandRouterMock: vi.fn((_deps: unknown) => routerMock),
    createChannelsMock: vi.fn(() => channelsMock),
    createSourcesMock: vi.fn(() => sourcesMock),
    createSchedulerMock: vi.fn(() => schedulerMock),
    createClockMock: vi.fn(() => clockMock),
    createEffectsMock: vi.fn(() => effectsMock),
    openDatabaseMock: vi.fn(() => ({})),
    createStoreMock: vi.fn(() => storeMock),
    importLegacyMock: vi.fn(() => ({ imported: false, counts: {} })),
    createNetCapabilityMock: vi.fn(() => ({
      fetch: (): Promise<never> => Promise.reject(new Error('no net')),
      listen: (): Promise<never> => Promise.reject(new Error('no net')),
      verifyHmacSha256: (): boolean => true,
    })),
    discoverExternalPluginsMock: vi.fn(async () => ({
      entries: [],
      rejections: [],
      missingRoot: true,
    })),
    createPluginSecretsMock: vi.fn(() => ({
      listSecretKeys: (): string[] => [],
      hasSecret: (): boolean => false,
      readSecrets: (): Record<string, string> => ({}),
      setSecret: (): void => undefined,
      removeSecret: (): void => undefined,
    })),
    resolvePluginConfigMock: vi.fn(() => ({})),
    createExternalChannelPluginMock: vi.fn(() => ({ start: (): void => undefined })),
    createExternalSourcePluginMock: vi.fn(() => ({ start: (): void => undefined })),
    createSdkHostMock: vi.fn(() => ({
      log: (): void => undefined,
      now: (): number => 0,
      paths: { sessionRoot: null },
      config: (): Record<string, unknown> => ({}),
      process: {},
    })),
    createExecutorRegistryMock: vi.fn(() => ({ forRuntime: (): undefined => undefined })),
    createProcessRegistryMock: vi.fn(() => ({
      begin: (): void => undefined,
      attachPid: (): void => undefined,
      remove: (): void => undefined,
      list: (): unknown[] => [],
      clear: (): void => undefined,
    })),
    reconcileMock: vi.fn(() => ({ killed: 0, cleared: 0, facts: 0 })),
    killPidTreeMock: vi.fn(() => true),
    defaultSpawnMock: vi.fn(),
    registerIpcHandlersMock: vi.fn(),
    createTrayMock: vi.fn(),
    notifyMock: vi.fn(() => true),
    detectAllMock: vi.fn(async () => []),
    channelByIdMock: vi.fn(() => registryEntries[0]),
    sourceByIdMock: vi.fn(() => registryEntries[0]),
  }
})

vi.mock('electron', () => ({
  app: mocks.appMock,
  BrowserWindow: mocks.BrowserWindowMock,
  safeStorage: mocks.safeStorageMock,
  shell: mocks.shellMock,
}))
vi.mock('../../src/main/tray', () => ({ createTray: mocks.createTrayMock }))
vi.mock('../../src/main/ipc', () => ({ registerIpcHandlers: mocks.registerIpcHandlersMock }))
vi.mock('../../src/main/notify', () => ({ notify: mocks.notifyMock }))
vi.mock('../../src/main/workdir', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workdir')>()
  return {
    ...actual,
    resolveWorkdir: (_input: unknown, log?: (line: string) => void): string => {
      mocks.workdirLog.value = log ?? null
      return 'C:/mock-workdir'
    },
  }
})
vi.mock('../../src/host/feed', () => ({ createFactFeed: mocks.createFactFeedMock }))
vi.mock('../../src/host/commands', () => ({ createCommandRouter: mocks.createCommandRouterMock }))
vi.mock('../../src/host/db', () => ({ openDatabase: mocks.openDatabaseMock }))
vi.mock('../../src/plugins/registry', () => ({
  executors: mocks.pluginExecutors,
  channels: [],
  sources: [],
  channelById: mocks.channelByIdMock,
  sourceById: mocks.sourceByIdMock,
  detectAll: mocks.detectAllMock,
}))
vi.mock('../../src/host/net', () => ({ createNetCapability: mocks.createNetCapabilityMock }))
vi.mock('../../src/host/plugins/discover', () => ({
  discoverExternalPlugins: mocks.discoverExternalPluginsMock,
}))
vi.mock('../../src/host/plugins/settings', () => ({
  createPluginSecrets: mocks.createPluginSecretsMock,
  resolvePluginConfig: mocks.resolvePluginConfigMock,
}))
vi.mock('../../src/host/plugins/adapters', () => ({
  createExternalChannelPlugin: mocks.createExternalChannelPluginMock,
  createExternalSourcePlugin: mocks.createExternalSourcePluginMock,
}))
vi.mock('../../src/host/sources', () => ({ createSources: mocks.createSourcesMock }))
vi.mock('../../src/host/sdk-host', () => ({ createSdkHost: mocks.createSdkHostMock }))
vi.mock('../../src/host/executor-registry', () => ({
  createExecutorRegistry: mocks.createExecutorRegistryMock,
}))
vi.mock('../../src/host/store/index', () => ({
  createStore: mocks.createStoreMock,
  DEFAULT_LIMITS: {},
}))
vi.mock('../../src/host/store/import', () => ({ importLegacyIfNeeded: mocks.importLegacyMock }))
vi.mock('../../src/host/scheduler', () => ({ createScheduler: mocks.createSchedulerMock }))
vi.mock('../../src/host/effects', () => ({ createEffects: mocks.createEffectsMock }))
vi.mock('../../src/host/channels', () => ({ createChannels: mocks.createChannelsMock }))
vi.mock('../../src/host/clock', () => ({ createClock: mocks.createClockMock }))
vi.mock('../../src/host/process', () => ({
  killPidTree: mocks.killPidTreeMock,
  defaultSpawn: mocks.defaultSpawnMock,
}))
vi.mock('../../src/host/process-registry', () => ({
  createProcessRegistry: mocks.createProcessRegistryMock,
}))
vi.mock('../../src/host/reconcile', () => ({ reconcile: mocks.reconcileMock }))

async function loadEntry(): Promise<void> {
  vi.resetModules()
  await import('../../src/main/index')
  await vi.waitFor(() => expect(mocks.registerIpcHandlersMock).toHaveBeenCalled())
}

describe('主进程入口装配补测', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.windows.length = 0
    mocks.workdirLog.value = null
    delete process.env['ELECTRON_RENDERER_URL']
  })

  it('默认工作目录解析失败：注入的日志回调把原因交给 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await loadEntry()

      expect(typeof mocks.workdirLog.value).toBe('function')
      mocks.workdirLog.value?.('默认工作目录不可用：boom')
      expect(warn).toHaveBeenCalledWith('默认工作目录不可用：boom')
    } finally {
      warn.mockRestore()
    }
  })

  it('宿主视图 run.approvals 缺 runId：按空串兜底查 run.byId 并抛「运行不存在」', async () => {
    await loadEntry()
    const deps = mocks.createCommandRouterMock.mock.calls[0][0] as {
      hostView: (view: string, params?: Record<string, string>) => unknown
    }

    expect(() => deps.hostView('run.approvals')).toThrow('运行不存在: ')
    expect(mocks.storeMock.query).toHaveBeenCalledWith('run.byId', { runId: '' })
  })

  it('窗口安全：导航只留在应用自身，外部链接仅 http/https 交给系统', async () => {
    await loadEntry()
    const win = mocks.windows[0] as {
      navigationHandlers: Array<(event: { preventDefault(): void }, url: string) => void>
      windowOpenHandler: ((details: { url: string }) => { action: string }) | null
    }
    expect(win.navigationHandlers).toHaveLength(1)
    const navigate = win.navigationHandlers[0]

    const allowed = { preventDefault: vi.fn() }
    navigate(allowed, 'file:///app/renderer/index.html')
    expect(allowed.preventDefault).not.toHaveBeenCalled()

    const blocked = { preventDefault: vi.fn() }
    navigate(blocked, 'https://evil.example/x')
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1)

    const open = win.windowOpenHandler
    expect(open).not.toBeNull()
    expect(open?.({ url: 'https://example.com/doc' })).toEqual({ action: 'deny' })
    expect(mocks.shellMock.openExternal).toHaveBeenCalledWith('https://example.com/doc')
    expect(open?.({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(open?.({ url: 'not a url' })).toEqual({ action: 'deny' })
    expect(mocks.shellMock.openExternal).toHaveBeenCalledTimes(1)
  })

  it('dev 模式导航只放行 ELECTRON_RENDERER_URL', async () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://127.0.0.1:5173'
    try {
      await loadEntry()
      const win = mocks.windows[0] as {
        navigationHandlers: Array<(event: { preventDefault(): void }, url: string) => void>
      }
      const allowed = { preventDefault: vi.fn() }
      win.navigationHandlers[0](allowed, 'http://127.0.0.1:5173/#/x')
      expect(allowed.preventDefault).not.toHaveBeenCalled()

      const blocked = { preventDefault: vi.fn() }
      win.navigationHandlers[0](blocked, 'https://evil.example')
      expect(blocked.preventDefault).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env['ELECTRON_RENDERER_URL']
    }
  })
})
