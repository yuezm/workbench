import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerInfoPanel } from '@workbench/client-app-ai-workflow/components/ServerInfoPanel'
import { resetServerInfoForTest, setServerInfo } from '@workbench/client-shell/server-info'
import { formatLocalDateTime } from '@workbench/client-ui-kit/time'

/** 设置 / 服务：只读展示服务状态与数据目录 */
describe('ServerInfoPanel', () => {
  afterEach(() => {
    resetServerInfoForTest()
  })

  it('还没取到服务信息时给一句说明，不编造读数', () => {
    render(<ServerInfoPanel />)
    expect(screen.getByText('还没有取到服务信息。')).toBeInTheDocument()
  })

  it('取到后展示版本、内核、数据目录、默认工作目录与进程号', () => {
    setServerInfo({
      name: 'workbench',
      version: '2.0.0',
      kernelVersion: 'M47.0.0',
      dataDir: '/var/lib/workbench',
      defaultWorkdir: '/work',
      startedAt: '2026-11-16T00:00:00.000Z',
      clients: 2,
      pid: 4242,
    })
    render(<ServerInfoPanel />)
    expect(screen.getByText('2.0.0')).toBeInTheDocument()
    expect(screen.getByText('M47.0.0')).toBeInTheDocument()
    expect(screen.getByText('/var/lib/workbench')).toBeInTheDocument()
    expect(screen.getByText('/work')).toBeInTheDocument()
    expect(screen.getByText('4242')).toBeInTheDocument()
    // 启动时间按本机时区展示（服务给的是 UTC ISO，直接渲染会显示成早了 8 小时）
    expect(screen.getByText(formatLocalDateTime('2026-11-16T00:00:00.000Z'))).toBeInTheDocument()
    expect(screen.queryByText('2026-11-16T00:00:00.000Z')).toBeNull()
    // 地址来自当前页面（服务与页面同源）
    expect(screen.getByText(window.location.origin)).toBeInTheDocument()
    // 只读：没有任何可编辑控件
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
