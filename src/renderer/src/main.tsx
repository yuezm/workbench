import React from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from './components/ui/error-boundary'
import { toast } from './components/ui/toast'
import { StartupFailure } from './shell/components/StartupFailure'
import { Workbench } from './shell/Workbench'
import { configureKernel } from './shell/kernelStore'
import { pushOpenTarget } from './shell/openTarget'
import { setServerInfo } from './shell/server-info'
import { createWebBridge } from './shared/bridge'
import { initTheme } from './lib/theme'
import './shell/styles/global.css'

/**
 * Web 入口：装配浏览器桥接，然后把页面挂起来。
 *
 * 与桌面形态的差别只在「桥接从哪来」：以前是 preload 注入 `window.workbench`，现在是
 * 本文件创建 HTTP/SSE 桥接并挂到同一个名字上（app 代码一行不用改）。
 *
 * 先探一次 `/api/info` 再渲染：服务没起来时页面拿到的是连续失败的视图请求，界面上只会
 * 是空白卡片；先探一下就能给一页人话（连的是哪个地址、进程起没起）。
 */
const container = document.getElementById('root') as HTMLElement
const root = ReactDOM.createRoot(container)
const bridge = createWebBridge()
window.workbench = bridge

// 主题先落地再渲染：`<html>` 上的 light/dark 类要在首帧前挂好，避免闪一下默认主题。
initTheme()

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function boot(): Promise<void> {
  try {
    // 探一次服务，并把读数存进 shell store：顶部栏的版本号与设置页的「服务」一栏都读它
    setServerInfo(await bridge.info())
  } catch (error) {
    root.render(<StartupFailure message={`无法连接工作台服务：${errorText(error)}`} />)
    return
  }

  configureKernel(bridge)
  // 知会（任务完成 / 运行失败 / 番茄钟）：弹轻提示；带落点的一条点一下就跳过去。
  // 订阅发生在渲染前，服务端在页面加载期间推来的知会也进得来。
  bridge.onNotice((notice) => {
    toast(notice.body === '' ? notice.title : `${notice.title}：${notice.body}`, 'info')
    if (notice.target !== undefined) pushOpenTarget(notice.target)
  })

  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <Workbench />
      </ErrorBoundary>
    </React.StrictMode>,
  )
}

void boot()
