import { app, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { decide } from '../kernel/decide'
import { nextWakeAt } from '../kernel/next-wake'
import { project } from '../kernel/project'
import { viewSpec } from '../kernel/view-spec'
import type { KernelPort } from '../kernel/types'
import { createClock } from '../host/clock'
import { createEffects } from '../host/effects'
import { killPidTree } from '../host/process'
import { createProcessRegistry } from '../host/process-registry'
import { reconcile } from '../host/reconcile'
import { createScheduler, type Scheduler } from '../host/scheduler'
import { createStore, DEFAULT_LIMITS } from '../host/store/index'
import { importLegacyIfNeeded } from '../host/store/import'
import { registerIpcHandlers } from './ipc'
import { createTray } from './tray'
import { openDb } from './ai-workflow/db'
import { Repository } from './ai-workflow/repository'
import { registerAiWorkflowIpc } from './ai-workflow/ipc'
import { ChatService } from './ai-workflow/chat'
import { createRuntimeExecutors } from './ai-workflow/executor-port'
import { createRuntimeBackend, type RuntimeBackend } from './ai-workflow/runtime/registry'
import type { RuntimeProtocolFamily } from '../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANGED, AI_WORKFLOW_CHAT } from '../shared/ai-workflow-api'

let quitting = false
let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16161e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win?.show())

  // 点 X 隐藏到托盘而不是退出，真正退出走托盘菜单（before-quit 里置位）
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win?.hide()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// 单实例：锁必须在 whenReady 之前判断。已有实例在跑时，本进程直接退出，
// 不建窗口、不注册托盘、不开库、不注册 IPC，全部装配都留给第一个实例。
if (app.requestSingleInstanceLock()) {
  // 第二次启动：已有窗口就唤到前台，窗口全关了则重建
  app.on('second-instance', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      return
    }
    win?.show()
    win?.focus()
  })

  app.whenReady().then(() => {
    // Windows 通知归属需要 AppUserModelId
    app.setAppUserModelId('com.workbench.desktop')
    registerIpcHandlers()

    // ai-workflow：打开本地 SQLite，注册 RPC 与运行队列；变更广播给所有窗口
    const broadcastChanged = (): void => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(AI_WORKFLOW_CHANGED)
    }
    const userData = app.getPath('userData')
    const db = openDb(path.join(userData, 'ai-workflow.db'))
    // 内核门面：decide / project / viewSpec / nextWakeAt 是纯函数，store 与 clock 只依赖这个端口。
    const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }
    const store = createStore({ db, kernel })
    // 启动顺序：先把 v2 存量导成事实导入根，再对账投影（指纹失配/seq 落后则从事实重建）。
    // 先导入更安全：空事实 + 存量投影时不会因为指纹失配把存量当投影清掉。
    importLegacyIfNeeded(db, kernel)
    store.ensureProjection()
    const aiRepo = new Repository(db)
    // 协议后端：dsh 会话持久化放在 userData 下，聊天才能跨轮续接；
    // 目录必须先存在（dsh profile 会直接在 session root 下写会话/spill 文件）。
    const sessionsDir = path.join(userData, 'ai-workflow', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const runtimeDeps = { sessionRoot: sessionsDir }
    const backendFor = (family: RuntimeProtocolFamily): RuntimeBackend =>
      createRuntimeBackend(family, runtimeDeps)
    // 执行器端口：调度器只认 `ExecutorPort`（host/executor），具体 dsh 实现在这里装配
    const executors = createRuntimeExecutors(runtimeDeps)
    // 启动对账（T13）：先按 process_registry 的残留 pid 终止上次崩溃留下的进程树、清登记，
    // 再 dispatch clock.tick 回收超租约（run.abandoned / executor_lost）与超时（timeout）的 run。
    // 此刻 scheduler 还没装配：直接走 store.dispatch（启动期没有订阅者），随后的
    // scheduler.wake() 会接住被重排回 queued 的 run。
    const registry = createProcessRegistry(db)
    const reconciled = reconcile({
      registry,
      dispatch: (input) => store.dispatch(input),
      // 投影里的 run 状态；run 已随任务/工作流删除时视为缺失（只清登记行）
      runStatus: (runId) => {
        try {
          return aiRepo.runGet(runId).status
        } catch {
          return null
        }
      },
      killPid: killPidTree,
    })
    // 摘要只用于诊断：残留进程与回收数量非零时留一条 warn（不建 UI 通道）
    if (reconciled.killed > 0 || reconciled.facts > 0) {
      console.warn(
        `[reconcile] 终止残留进程 ${reconciled.killed} 个、清理登记 ${reconciled.cleared} 行、回收事实 ${reconciled.facts} 条`,
      )
    }
    // 写入口与提交后分发：effects.dispatch 是 IPC / scheduler / clock 的唯一写路径；
    // effects 先建、scheduler 后建，靠闭包惰性取（getter 首次调用发生在装配完成之后）
    const effects = createEffects({
      store,
      scheduler: () => scheduler,
      notifyChanged: broadcastChanged,
    })
    const scheduler: Scheduler = createScheduler({
      dispatch: (input) => effects.dispatch(input),
      runtimes: () => store.query('runtimes.all'),
      executors,
      limits: DEFAULT_LIMITS,
      // 重启后重跑同一 run 时帧 seq 继续全局单调（T12 会把这里换成投影内的最大 seq）
      lastFrameSeq: (runId) => aiRepo.runEventsList(runId).at(-1)?.seq ?? 0,
      registry,
    })
    const chat = new ChatService({
      repo: aiRepo,
      backendFor,
      emit: (event) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send(AI_WORKFLOW_CHAT, event)
      },
    })
    registerAiWorkflowIpc({
      store,
      dispatch: (input) => effects.dispatch(input),
      repo: aiRepo,
      chat,
      backendFor,
    })
    // 启动：对账已在上方完成（残留进程已清、超租约已回收），这里先领取遗留 queued run，
    // 再挂唯一定时器（周期回收走 nextWakeAt + clock.tick，不再单独轮询）
    scheduler.wake()
    const clock = createClock({
      store: {
        dispatch: (input) => effects.dispatch(input),
        nextWakeAt: (at) => store.nextWakeAt(at),
      },
      now: () => new Date().toISOString(),
      onTick: () => scheduler.wake(),
    })
    clock.start()

    createWindow()

    const trayIconDir = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'resources')
    createTray(trayIconDir, () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      win?.show()
      win?.focus()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else win?.show()
    })
  })
} else {
  app.quit()
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
