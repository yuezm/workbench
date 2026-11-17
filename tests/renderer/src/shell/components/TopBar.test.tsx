import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appPlugins } from '@workbench/client-shell/registry'
import { TopBar } from '@workbench/client-shell/components/TopBar'
import { resetServerInfoForTest, setServerInfo } from '@workbench/client-shell/server-info'

afterEach(() => {
  resetServerInfoForTest()
})

describe('TopBar', () => {
  it('渲染注册表中所有 app 标签', () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    for (const app of appPlugins) {
      expect(screen.getByRole('button', { name: app.name })).toBeInTheDocument()
    }
  })

  it('高亮当前选中的 app（aria-current）', () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    expect(screen.getByRole('button', { name: appPlugins[0]!.name })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('未选中的标签没有 aria-current', () => {
    render(<TopBar apps={appPlugins} activeId="不存在" onSelect={() => {}} />)
    for (const app of appPlugins) {
      expect(screen.getByRole('button', { name: app.name })).not.toHaveAttribute('aria-current')
    }
  })

  it('点击标签触发 onSelect 并携带 app id', async () => {
    const onSelect = vi.fn()
    render(<TopBar apps={appPlugins} activeId="" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: appPlugins[0]!.name }))
    expect(onSelect).toHaveBeenCalledWith(appPlugins[0]!.id)
  })

  it('右侧显示服务端版本号；取到之前不显示（不编一个假版本）', () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    expect(screen.queryByText(/^v/u)).toBeNull()

    act(() => {
      setServerInfo({
        name: 'workbench',
        version: '2.0.0',
        kernelVersion: 'M47.0.0',
        dataDir: '/data',
        defaultWorkdir: '/work',
        startedAt: 't',
        clients: 1,
        pid: 1,
      })
    })
    expect(screen.getByText('v2.0.0')).toBeInTheDocument()
  })

  it('右侧有主题切换器：全局入口，任何 app 都能切主题', async () => {
    render(<TopBar apps={appPlugins} activeId={appPlugins[0]!.id} onSelect={() => {}} />)
    const trigger = screen.getByRole('button', { name: /主题：/ })
    expect(trigger).toBeInTheDocument()
    // hover 展开三个选项：亮色 / 暗色 / 跟随系统
    await userEvent.hover(trigger)
    expect(await screen.findByRole('group', { name: '主题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '亮色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '暗色' })).toBeInTheDocument()
  })
})
