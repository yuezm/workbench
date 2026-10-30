import { app, Menu, nativeImage, Tray } from 'electron'

export function createTray(iconPath: string, onShow: () => void): Tray {
  const tray = new Tray(nativeImage.createFromPath(iconPath))
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
