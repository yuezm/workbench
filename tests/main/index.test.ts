// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_WORKFLOW_CHANGED, AI_WORKFLOW_CHAT } from '../../src/shared/ai-workflow-api'

/**
 * 主进程入口只做装配：mock 掉 electron 与各模块，验证窗口/托盘/退出流程
 * 与 ai-workflow 的接线（聊天服务、变更广播），不起真实窗口与数据库。
 */
const {
  appMock,
  shellMock,
  windows,
  BrowserWindowMock,
  createTrayMock,
  registerIpcHandlersMock,
  registerAiWorkflowIpcMock,
  ChatServiceMock,
  ChatServiceImpl,
  RunnerMock,
  RunnerImpl,
  runnerInstances,
  openDbMock,
  RepositoryMock,
  RepositoryImpl,
  createStoreMock,
  storeMock,
  importLegacyMock,
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

  // 构造调用记录：真实 class 承载实例方法，外层 vi.fn 记录构造参数
  const ChatServiceMock = vi.fn()
  class ChatServiceImpl {
    send = vi.fn()
    cancel = vi.fn()
    constructor(deps: unknown) {
      ChatServiceMock(deps)
    }
  }
  const RunnerMock = vi.fn()
  const runnerInstances: RunnerImpl[] = []
  class RunnerImpl {
    enqueue = vi.fn()
    resumeQueued = vi.fn()
    constructor(deps: unknown) {
      RunnerMock(deps)
      runnerInstances.push(this)
    }
  }
  const RepositoryMock = vi.fn()
  class RepositoryImpl {
    constructor(...args: unknown[]) {
      RepositoryMock(...args)
    }
  }

  // store 门面：入口只用到 ensureProjection；其余方法由 IPC 使用，测试里不需要真实现。
  const storeMock = { ensureProjection: vi.fn(() => ({ rebuilt: false })) }
  const createStoreMock = vi.fn((_options: unknown) => storeMock)
  const importLegacyMock = vi.fn(() => ({
    imported: false,
    counts: { tasks: 0, workflows: 0, workflow_stages: 0, agents: 0, runtimes: 0 },
  }))
  /** 启动装配顺序：openDb → createStore → importLegacy → ensureProjection → Repository。 */
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
    ChatServiceMock,
    ChatServiceImpl,
    RunnerMock,
    RunnerImpl,
    runnerInstances,
    openDbMock: vi.fn(() => ({})),
    RepositoryMock,
    RepositoryImpl,
    createStoreMock,
    storeMock,
    importLegacyMock,
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
vi.mock('../../src/main/ai-workflow/chat', () => ({ ChatService: ChatServiceImpl }))
vi.mock('../../src/main/ai-workflow/db', () => ({ openDb: openDbMock }))
vi.mock('../../src/main/ai-workflow/repository', () => ({ Repository: RepositoryImpl }))
vi.mock('../../src/main/ai-workflow/runner', () => ({ Runner: RunnerImpl }))
vi.mock('../../src/host/store/index', () => ({ createStore: createStoreMock }))
vi.mock('../../src/host/store/import', () => ({ importLegacyIfNeeded: importLegacyMock }))

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
  notifyChanged: () => void
  onQueue: (runId: string) => void
  chat: unknown
  backendFor: (family: 'dsh') => {
    probe: unknown
    models: unknown
    execute: unknown
  }
}

function ipcDeps(): IpcDeps {
  return registerAiWorkflowIpcMock.mock.calls[0][0] as IpcDeps
}

describe('主进程入口装配', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    windows.length = 0
    runnerInstances.length = 0
    startupOrder.length = 0
    delete process.env['ELECTRON_RENDERER_URL']
    openDbMock.mockImplementation(() => {
      startupOrder.push('openDb')
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
    importLegacyMock.mockImplementation(() => {
      startupOrder.push('importLegacy')
      return {
        imported: false,
        counts: { tasks: 0, workflows: 0, workflow_stages: 0, agents: 0, runtimes: 0 },
      }
    })
    RepositoryMock.mockImplementation(() => {
      startupOrder.push('repository')
    })
  })

  it('创建窗口与托盘，并把聊天服务接进 ai-workflow IPC', async () => {
    await loadEntry()

    expect(registerIpcHandlersMock).toHaveBeenCalledTimes(1)
    expect(appMock.setAppUserModelId).toHaveBeenCalledWith('com.workbench.desktop')
    expect(windows).toHaveLength(1)
    expect(windows[0].loadFile).toHaveBeenCalledTimes(1)
    expect(createTrayMock).toHaveBeenCalledTimes(1)

    expect(ChatServiceMock).toHaveBeenCalledTimes(1)
    expect(ipcDeps().chat).toBeDefined()
    // 仓库实例与 runner 共享同一数据库连接，runner 接收变更广播函数
    expect(RepositoryMock).toHaveBeenCalledTimes(1)
    expect(RunnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: expect.anything(),
        store: storeMock,
        notifyChanged: expect.any(Function),
      }),
    )
    // IPC 也拿到同一个 store（唯一写入口）
    expect(ipcDeps().store).toBe(storeMock)
    expect(runnerInstances[0].resumeQueued).toHaveBeenCalledTimes(1)
    // 协议后端工厂接到 IPC，且能按协议族构造出真实后端
    const backend = ipcDeps().backendFor('dsh')
    expect(typeof backend.probe).toBe('function')
    expect(typeof backend.models).toBe('function')
    expect(typeof backend.execute).toBe('function')
  })

  it('启动顺序：开库 → 建 store → 导入存量 → 对账投影 → 建仓储', async () => {
    await loadEntry()

    expect(startupOrder).toEqual([
      'openDb',
      'createStore',
      'importLegacy',
      'ensureProjection',
      'repository',
    ])
    // store 拿到的是内核门面：decide / project / viewSpec 三个纯函数
    const options = createStoreMock.mock.calls[0][0] as {
      db: unknown
      kernel: { decide: unknown; project: unknown; viewSpec: unknown }
    }
    expect(options.db).toBeDefined()
    expect(typeof options.kernel.decide).toBe('function')
    expect(typeof options.kernel.project).toBe('function')
    expect(typeof options.kernel.viewSpec).toBe('function')
    // 导入接到同一个 db 与 kernel；先导入存量再对账投影（空库无事实时不会清表）
    expect(importLegacyMock).toHaveBeenCalledWith(options.db, options.kernel)
    expect(startupOrder.indexOf('importLegacy')).toBeLessThan(
      startupOrder.indexOf('ensureProjection'),
    )
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
    expect(openDbMock).not.toHaveBeenCalled()
    expect(createStoreMock).not.toHaveBeenCalled()
    expect(storeMock.ensureProjection).not.toHaveBeenCalled()
    expect(importLegacyMock).not.toHaveBeenCalled()
    expect(RepositoryMock).not.toHaveBeenCalled()
    expect(ChatServiceMock).not.toHaveBeenCalled()
    expect(RunnerMock).not.toHaveBeenCalled()
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

  it('before-quit 之后关窗不再拦截', async () => {
    await loadEntry()

    appHandler('before-quit')()
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

  it('变更与排队回调接到 runner / 窗口广播', async () => {
    await loadEntry()
    const deps = ipcDeps()

    deps.notifyChanged()
    expect(windows[0].webContents.send).toHaveBeenCalledWith(AI_WORKFLOW_CHANGED)

    deps.onQueue('run-1')
    expect(runnerInstances[0].enqueue).toHaveBeenCalledWith('run-1')
  })

  it('聊天流事件广播到所有窗口的 webContents', async () => {
    await loadEntry()

    const ctorArg = ChatServiceMock.mock.calls[0][0] as {
      emit: (event: { conversationId: string; type: 'end' }) => void
    }
    ctorArg.emit({ conversationId: 'c1', type: 'end' })
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
})
