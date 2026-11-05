// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_WORKFLOW_CHANGED, AI_WORKFLOW_CHAT } from '../../src/shared/ai-workflow-api'

/**
 * 主进程入口只做装配：mock 掉 electron 与各模块，验证窗口/托盘/退出流程，
 * 以及 ai-workflow 的接线（store → effects/scheduler/clock → IPC、聊天广播）。
 */
const {
  appMock,
  shellMock,
  windows,
  BrowserWindowMock,
  createTrayMock,
  registerIpcHandlersMock,
  registerAiWorkflowIpcMock,
  openDatabaseMock,
  createStoreMock,
  storeMock,
  importLegacyMock,
  createSchedulerMock,
  schedulerMock,
  createEffectsMock,
  effectsMock,
  createClockMock,
  clockMock,
  pluginEntriesMock,
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
} = vi.hoisted(() => {
  interface WindowMock {
    webContents: { send: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn> }
    on: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    loadURL: ReturnType<typeof vi.fn>
    loadFile: ReturnType<typeof vi.fn>
  }
  const windows: WindowMock[] = []
  class BrowserWindowMock {
    static getAllWindows = vi.fn((): WindowMock[] => windows)
    webContents = { send: vi.fn(), setWindowOpenHandler: vi.fn() }
    on = vi.fn()
    show = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    loadURL = vi.fn()
    loadFile = vi.fn()
    constructor() {
      windows.push(this)
    }
  }

  // store 门面：入口用到 ensureProjection / query / nextWakeAt；其余由 IPC 使用。
  const storeMock = {
    ensureProjection: vi.fn(() => ({ rebuilt: false })),
    query: vi.fn((table: string, params?: unknown): unknown => {
      if (table === 'run.last-event-seq') return 0
      if (table === 'run.byId') {
        const runId = (params as { runId?: string } | undefined)?.runId
        return runId === 'run-1' ? { id: 'run-1', status: 'running' } : null
      }
      return []
    }),
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
  const reconcileMock = vi.fn((_deps: unknown) => ({ killed: 0, cleared: 0, facts: 0 }))

  /** 启动装配顺序：openDatabase → createStore → importLegacy → ensureProjection → 进程登记 → 对账 → … */
  const startupOrder: string[] = []

  return {
    appMock: {
      whenReady: vi.fn(async () => undefined),
      setAppUserModelId: vi.fn(),
      getPath: vi.fn(() => '/tmp/workbench-entry-test'),
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
    registerIpcHandlersMock: vi.fn(),
    registerAiWorkflowIpcMock: vi.fn(),
    openDatabaseMock: vi.fn(() => ({})),
    createStoreMock,
    storeMock,
    importLegacyMock,
    createSchedulerMock,
    schedulerMock,
    createEffectsMock,
    effectsMock,
    createClockMock,
    clockMock,
    pluginEntriesMock,
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
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: BrowserWindowMock,
  shell: shellMock,
}))
vi.mock('../../src/main/tray', () => ({ createTray: createTrayMock }))
vi.mock('../../src/main/ipc', () => ({ registerIpcHandlers: registerIpcHandlersMock }))
vi.mock('../../src/main/ai-workflow/ipc', () => ({
  registerAiWorkflowIpc: registerAiWorkflowIpcMock,
}))
vi.mock('../../src/host/db', () => ({ openDatabase: openDatabaseMock }))
vi.mock('../../src/plugins/registry', () => ({
  executors: pluginEntriesMock,
  detectAll: detectAllMock,
}))
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
vi.mock('../../src/host/clock', () => ({ createClock: createClockMock }))
vi.mock('../../src/host/process', () => ({ killPidTree: killPidTreeMock }))
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
  await vi.waitFor(() => expect(registerAiWorkflowIpcMock).toHaveBeenCalled())
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

type IpcDeps = {
  store: unknown
  dispatch: (input: unknown) => { facts: unknown[] }
  executors: { forRuntime: (runtime: { executorKey: string }) => unknown }
  executorDefaults: (key?: string) => { executorKey: string; command: string; profile: string }
  executorChoices: () => Array<{ key: string; label: string; command: string; profile: string }>
  detect: () => Promise<unknown[]>
}

function ipcDeps(): IpcDeps {
  return registerAiWorkflowIpcMock.mock.calls[0][0] as IpcDeps
}

type SchedulerDeps = {
  dispatch: (input: unknown) => { facts: unknown[] }
  runtimes: () => unknown[]
  executors: unknown
  limits: unknown
  lastFrameSeq: (runId: string) => number
  registry: unknown
  rearmClock?: () => void
  onChatStream?: (conversationId: string, event: unknown) => void
  onChatStreamEnd?: (conversationId: string) => void
  chatFallbackPrompt?: (run: unknown) => string | null
}

type ReconcileDeps = {
  registry: unknown
  dispatch: (input: unknown) => { facts: unknown[] }
  runStatus: (runId: string) => string | null
  staleChatRuns?: () => ReadonlyArray<{ id: string; leaseId: string | null; turn: number }>
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
  notifyChanged: () => void
}

function effectsDeps(): EffectsDeps {
  return createEffectsMock.mock.calls[0][0] as EffectsDeps
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
    registerAiWorkflowIpcMock.mockImplementation(() => {
      startupOrder.push('ipc')
    })
  })

  it('创建窗口与托盘，并把执行链接进 ai-workflow IPC', async () => {
    await loadEntry()

    expect(registerIpcHandlersMock).toHaveBeenCalledTimes(1)
    expect(appMock.setAppUserModelId).toHaveBeenCalledWith('com.workbench.desktop')
    expect(windows).toHaveLength(1)
    expect(windows[0].loadFile).toHaveBeenCalledTimes(1)
    expect(createTrayMock).toHaveBeenCalledTimes(1)

    // 执行器装配：会话根注入 sdk，注册表把清单接成端口工厂
    expect(createSdkHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionRoot: expect.stringContaining('sessions') }),
    )
    expect(createExecutorRegistryMock).toHaveBeenCalledWith(pluginEntriesMock, sdkHostMock)
    // IPC 拿到同一个 store（唯一读入口）与统一写入口（effects.dispatch）
    expect(ipcDeps().store).toBe(storeMock)
    ipcDeps().dispatch({ type: 'task.remove', commandId: 'c', id: 't' })
    expect(effectsMock.dispatch).toHaveBeenCalledWith({
      type: 'task.remove',
      commandId: 'c',
      id: 't',
    })
    // IPC 拿到的执行器工厂与调度器是同一份；默认值来自插件 manifest
    expect(ipcDeps().executors.forRuntime).toBe(executorsMock.forRuntime)
    expect(ipcDeps().executorDefaults()).toEqual({
      executorKey: 'dsh',
      command: 'dsh',
      profile: 'multica',
    })
    // 运行时表单下拉与 detect 汇总同样来自注册表；detect 由装配根注入 sdkHost
    expect(ipcDeps().executorChoices()).toEqual([
      { key: 'dsh', label: 'DeepSeek Harness', command: 'dsh', profile: 'multica' },
    ])
    await expect(ipcDeps().detect()).resolves.toEqual([])
    expect(detectAllMock).toHaveBeenCalledWith(sdkHostMock)
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
      const defaults = ipcDeps().executorDefaults

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

  it('启动顺序：开库 → 建 store → 导入存量 → 对账投影 → 建仓储 → 清崩溃残留 → clock → scheduler → IPC', async () => {
    await loadEntry()

    expect(startupOrder).toEqual([
      'openDatabase',
      'createStore',
      'importLegacy',
      'ensureProjection',
      'executors',
      'registry',
      'reconcile',
      'clock',
      'scheduler',
      'ipc',
    ])
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
    // 帧 seq 从仓储读（重启后续接全局单调）
    expect(schedulerDeps().lastFrameSeq('run-1')).toBe(0)
    // 帧 seq 从 run_events 投影的 MAX(seq) 视图读（不再走仓储 SQL）
    expect(storeMock.query).toHaveBeenCalledWith('run.last-event-seq', { runId: 'run-1' })

    // effects：调度器惰性解析 + 变更广播接到窗口
    expect(effectsDeps().scheduler()).toBe(schedulerMock)
    effectsDeps().notifyChanged()
    expect(windows[0].webContents.send).toHaveBeenCalledWith(AI_WORKFLOW_CHANGED)

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
    expect(registerAiWorkflowIpcMock).not.toHaveBeenCalled()
    expect(createTrayMock).not.toHaveBeenCalled()
    expect(openDatabaseMock).not.toHaveBeenCalled()
    expect(createStoreMock).not.toHaveBeenCalled()
    expect(storeMock.ensureProjection).not.toHaveBeenCalled()
    expect(importLegacyMock).not.toHaveBeenCalled()
    expect(createProcessRegistryMock).not.toHaveBeenCalled()
    expect(reconcileMock).not.toHaveBeenCalled()
    expect(killPidTreeMock).not.toHaveBeenCalled()
    expect(createSchedulerMock).not.toHaveBeenCalled()
    expect(createEffectsMock).not.toHaveBeenCalled()
    expect(createClockMock).not.toHaveBeenCalled()
    expect(createExecutorRegistryMock).not.toHaveBeenCalled()
    expect(windows).toHaveLength(0)
  })

  it('second-instance：有窗口时唤出，窗口都没了则重建', async () => {
    await loadEntry()
    const secondInstance = appHandler('second-instance')

    secondInstance()
    expect(windows[0].show).toHaveBeenCalledTimes(1)
    expect(windows[0].focus).toHaveBeenCalledTimes(1)

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

  it('before-quit：关窗不再拦截，并对活跃 run best-effort 取消', async () => {
    await loadEntry()

    appHandler('before-quit')()
    // 退出前取消活跃 run（T15）：不等待回执，直接 cancelAll
    expect(schedulerMock.cancelAll).toHaveBeenCalledTimes(1)
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

  it('聊天流事件经 scheduler 旁路广播到所有窗口的 webContents', async () => {
    await loadEntry()

    const deps = schedulerDeps()
    expect(deps.onChatStream).toBeTypeOf('function')
    expect(deps.onChatStreamEnd).toBeTypeOf('function')
    ;(() => deps.onChatStream?.('c1', { seq: 1, type: 'text', text: '你好' }))()
    ;(() => deps.onChatStreamEnd?.('c1'))()

    expect(windows[0].webContents.send).toHaveBeenCalledWith(AI_WORKFLOW_CHAT, {
      conversationId: 'c1',
      type: 'event',
      event: { seq: 1, type: 'text', text: '你好' },
    })
    expect(windows[0].webContents.send).toHaveBeenCalledWith(AI_WORKFLOW_CHAT, {
      conversationId: 'c1',
      type: 'end',
    })
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
      '你是助手。\n\n# 对话记录\n\n用户：早\n助手：早呀\n\n请回答最后一条用户消息。',
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

  it('聊天流旁路：窗口 webContents 已销毁时丢弃推送，不打断其它窗口', async () => {
    await loadEntry()

    const deps = schedulerDeps()
    windows[0].webContents.send.mockImplementationOnce(() => {
      throw new Error('webContents 已销毁')
    })

    expect(() => deps.onChatStream?.('c1', { seq: 1, type: 'text', text: 'x' })).not.toThrow()
    // 下一次推送不受影响
    deps.onChatStream?.('c1', { seq: 2, type: 'text', text: 'y' })
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
