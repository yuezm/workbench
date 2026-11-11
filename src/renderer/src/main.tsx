import React from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from './components/ui/error-boundary'
import { StartupFailure } from './shell/components/StartupFailure'
import { Workbench } from './shell/Workbench'
import { configureKernel } from './shell/kernelStore'
import { pushOpenTarget } from './shell/openTarget'
import { initTheme } from './lib/theme'
import type { WorkbenchApi } from '../../shared/workbench-api'
import './shell/styles/global.css'

// M5：IPC 只暴露三动词 + notify；store 在挂载前装配，先订阅后取快照（断线重连同一路径）。
const bridge = (window as unknown as { workbench?: WorkbenchApi }).workbench
const container = document.getElementById('root') as HTMLElement
const root = ReactDOM.createRoot(container)

// 主题先落地再渲染：`<html>` 上的 light/dark 类要在首帧前挂好，避免闪一下默认主题。
initTheme()

if (bridge === undefined) {
  // 不能直接 throw：React 还没挂载，用户只会看到白窗口。渲染一页能读懂的错误。
  root.render(<StartupFailure />)
} else {
  configureKernel(bridge)
  // 系统通知点击的落点：**渲染前**订阅——`onOpenTarget` 是一次性推送，注册晚了就丢
  // （主进程接住点击后立刻推，窗口加载期间的那一次点击也得进得来）。
  // 落点先进 shell store，由 `Workbench` 切 app、目标 app 继续消费；返回值是退订函数，
  // 窗口整个生命周期都在用，不存在需要退订的时刻。
  bridge.onOpenTarget(pushOpenTarget)
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <Workbench />
      </ErrorBoundary>
    </React.StrictMode>,
  )
}
