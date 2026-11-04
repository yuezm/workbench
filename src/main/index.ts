import { app, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { decide } from '../kernel/decide'
import { nextWakeAt } from '../kernel/next-wake'
import { project } from '../kernel/project'
import { viewSpec } from '../kernel/view-spec'
import type { KernelPort } from '../kernel/types'
import { createStore } from '../host/store/index'
import { importLegacyIfNeeded } from '../host/store/import'
import { registerIpcHandlers } from './ipc'
import { createTray } from './tray'
import { openDb } from './ai-workflow/db'
import { Repository } from './ai-workflow/repository'
import { registerAiWorkflowIpc } from './ai-workflow/ipc'
import { ChatService } from './ai-workflow/chat'
import { Runner } from './ai-workflow/runner'
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
    const runner = new Runner({
      repo: aiRepo,
      store,
      notifyChanged: broadcastChanged,
      backendFor,
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
      repo: aiRepo,
      notifyChanged: broadcastChanged,
      onQueue: (runId) => runner.enqueue(runId),
      chat,
      backendFor,
    })
    runner.resumeQueued()

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
