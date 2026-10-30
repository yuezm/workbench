import { app, Menu, nativeImage, Tray } from 'electron'

export function createTray(iconPath: string, onShow: () => void): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    console.warn(`[tray] 托盘图标加载失败: ${iconPath}`)
  }
  const tray = new Tray(icon)
  tray.setToolTip('工作台')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示工作台', click: onShow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  )
  tray.on('click', onShow)
  return tray
}
