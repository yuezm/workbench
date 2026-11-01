import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import path from 'node:path'

/**
 * 加载托盘图标：1x 基底 + @2x 高清图。
 *
 * Windows 通知区域的托盘图标在 100% 缩放下只有 16px，只提供一张大图会被
 * 缩放发糊；注册 @2x 表示后，高 DPI 下系统会直接取 32px 那张。
 */
function loadTrayImage(iconDir: string): NativeImage {
  const image = nativeImage.createFromPath(path.join(iconDir, 'tray.png'))
  const retina = nativeImage.createFromPath(path.join(iconDir, 'tray@2x.png'))
  if (!retina.isEmpty()) {
    const { width, height } = retina.getSize()
    image.addRepresentation({
      scaleFactor: 2,
      width,
      height,
      dataURL: retina.toDataURL(),
    })
  }
  return image
}

export function createTray(iconDir: string, onShow: () => void): Tray {
  const icon = loadTrayImage(iconDir)
  if (icon.isEmpty()) {
    console.warn(`[tray] 托盘图标加载失败: ${iconDir}`)
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
