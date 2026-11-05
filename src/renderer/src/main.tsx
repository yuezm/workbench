import React from 'react'
import ReactDOM from 'react-dom/client'
import { Workbench } from './shell/Workbench'
import { configureKernel } from './shell/kernelStore'
import type { WorkbenchApi } from '../../shared/workbench-api'
import './shell/styles/global.css'

// M5：IPC 只暴露三动词 + notify；store 在挂载前装配，先订阅后取快照（断线重连同一路径）。
const bridge = (window as unknown as { workbench?: WorkbenchApi }).workbench
if (bridge === undefined) throw new Error('window.workbench 未注入（preload 未加载）')
configureKernel(bridge)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Workbench />
  </React.StrictMode>,
)
