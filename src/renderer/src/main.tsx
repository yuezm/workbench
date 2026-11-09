import React from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from './components/ui/error-boundary'
import { StartupFailure } from './shell/components/StartupFailure'
import { Workbench } from './shell/Workbench'
import { configureKernel } from './shell/kernelStore'
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
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <Workbench />
      </ErrorBoundary>
    </React.StrictMode>,
  )
}
