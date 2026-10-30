import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { registerIpcHandlers } from './ipc'
import { createTray } from './tray'

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

app.whenReady().then(() => {
  // Windows 通知归属需要 AppUserModelId
  app.setAppUserModelId('com.workbench.desktop')
  registerIpcHandlers()

  createWindow()

  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'resources', 'icon.png')
  createTray(trayIconPath, () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    win?.show()
    win?.focus()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win?.show()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
