import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPlugin } from '../../../../src/renderer/src/shell/types'
import { Workbench } from '../../../../src/renderer/src/shell/Workbench'
import {
  clearOpenTarget,
  pushOpenTarget,
  resetOpenTargetForTest,
} from '../../../../src/renderer/src/shell/openTarget'

function FakeIcon(): null {
  return null
}

function makeApp(id: string, name: string, content: string): AppPlugin {
  return { id, name, icon: FakeIcon, component: () => <div>{content}</div> }
}

const fakeApps = [makeApp('app-a', '应用A', '内容A'), makeApp('app-b', '应用B', '内容B')]

// 落点是模块级同步 store：每个用例从「没有落点」开始，避免上一个用例的点击串到下一个
beforeEach(() => {
  resetOpenTargetForTest()
})

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

/**
 * 落点第一跳（M27）：系统通知 / 通知条点进来，先由 shell 切到目标 app。
 * shell 只负责「切到哪」，落点本身**不清空**——任务 / 会话 / 卡片由 app 自己接着消费。
 */
describe('Workbench 消费落点', () => {
  it('挂载前就有待打开落点：直接打开目标 app', () => {
    pushOpenTarget({ appId: 'app-b', taskId: 't1', cardId: 'card-1' })
    render(<Workbench apps={fakeApps} />)

    expect(screen.getByText('内容B')).toBeInTheDocument()
    expect(screen.queryByText('内容A')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用B' })).toHaveAttribute('aria-current', 'page')
  })

  it('渲染后落点才到达（窗口已开着时点系统通知）：同样切过去', () => {
    render(<Workbench apps={fakeApps} />)
    expect(screen.getByText('内容A')).toBeInTheDocument()

    act(() => pushOpenTarget({ appId: 'app-b' }))
    expect(screen.getByText('内容B')).toBeInTheDocument()
  })

  it('appId 不在注册表：回落到第一个 app，不白屏（坏落点最多是没切过去）', () => {
    render(<Workbench apps={fakeApps} />)
    act(() => pushOpenTarget({ appId: 'app-ghost' }))

    expect(screen.getByText('内容A')).toBeInTheDocument()
    expect(screen.queryByText('内容B')).not.toBeInTheDocument()
  })

  it('shell 不消费落点，也不因为落点被清空而回弹（当前 app 与落点分开记）', async () => {
    const user = userEvent.setup()
    render(<Workbench apps={fakeApps} />)
    act(() => pushOpenTarget({ appId: 'app-b' }))
    expect(screen.getByText('内容B')).toBeInTheDocument()

    // 落点由 app 消费（`clearOpenTarget`）：清空只清落点，当前 app 由导航 store 单独记着
    act(() => clearOpenTarget())
    expect(screen.getByText('内容B')).toBeInTheDocument()

    // 用户自己点标签照常切（走 selectApp，与落点无关）
    await user.click(screen.getByRole('button', { name: '应用A' }))
    expect(screen.getByText('内容A')).toBeInTheDocument()
  })
})
