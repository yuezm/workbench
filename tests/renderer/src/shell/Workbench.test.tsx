import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppPlugin } from '../../../../src/renderer/src/shell/types'
import { Workbench } from '../../../../src/renderer/src/shell/Workbench'

function FakeIcon(): null {
  return null
}

function makeApp(id: string, name: string, content: string): AppPlugin {
  return { id, name, icon: FakeIcon, component: () => <div>{content}</div> }
}

const fakeApps = [makeApp('app-a', '应用A', '内容A'), makeApp('app-b', '应用B', '内容B')]

describe('Workbench 外壳', () => {
  it('默认挂载第一个 app 的内容', () => {
    render(<Workbench apps={fakeApps} />)
    expect(screen.getByText('内容A')).toBeInTheDocument()
    expect(screen.queryByText('内容B')).not.toBeInTheDocument()
  })

  it('点击顶部标签切换内容区 app，且无整页刷新', async () => {
    render(<Workbench apps={fakeApps} />)
    await userEvent.click(screen.getByRole('button', { name: '应用B' }))
    expect(screen.getByText('内容B')).toBeInTheDocument()
    expect(screen.queryByText('内容A')).not.toBeInTheDocument()
  })
})

describe('Workbench 空清单', () => {
  it('没有注册 app：仍渲染外壳（无标签、内容区空）', () => {
    render(<Workbench apps={[]} />)
    // 应用导航里没有标签按钮（顶部栏右侧的主题切换器是全局控件，不算 app 入口）
    expect(screen.queryAllByRole('button', { name: /应用/ })).toHaveLength(0)
    expect(screen.getByRole('navigation', { name: '应用导航' })).toBeEmptyDOMElement()
    expect(screen.getByText('Workbench')).toBeInTheDocument()
  })
})

describe('Workbench 渲染兜底', () => {
  it('某个 app 渲染抛错：只有内容槽变成兜底，顶部栏仍可切到别的 app', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const boom: AppPlugin = {
      id: 'app-boom',
      name: '会炸的',
      icon: FakeIcon,
      component: () => {
        throw new Error('视图数据形状不对')
      },
    }
    const user = userEvent.setup()
    render(<Workbench apps={[boom, makeApp('app-ok', '正常的', '内容B')]} />)

    // 白窗换成 role=alert 的兜底：标题 + 异常文案
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('界面出错了')
    expect(alert).toHaveTextContent('视图数据形状不对')

    // 切到正常 app：边界按 app 重建，界面恢复
    await user.click(screen.getByRole('button', { name: '正常的' }))
    expect(screen.getByText('内容B')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    error.mockRestore()
  })
})
