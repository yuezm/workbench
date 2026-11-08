import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../../../../src/renderer/src/components/ui/error-boundary'

/** 渲染期必炸的组件（ErrorBoundary 只能捕获渲染期错误） */
function Boom(): never {
  throw new Error('视图数据形状不合预期')
}

/** 只在 `armed` 时抛：用于验证边界重置后能重新渲染 */
let armed = true
function SometimesBoom(): null {
  if (armed) throw new Error('第一次就炸')
  return null
}

describe('ErrorBoundary', () => {
  it('正常子组件原样渲染，不加任何外壳', () => {
    render(
      <ErrorBoundary>
        <p>正常内容</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('正常内容')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('子组件渲染抛错：给 role=alert 的兜底文案，不外溢成白屏', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('界面出错了')
    expect(alert).toHaveTextContent('视图数据形状不合预期')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    error.mockRestore()
  })

  it('自定义标题可覆盖兜底标题', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary title="任务面板崩了">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('任务面板崩了')
    error.mockRestore()
  })

  it('抛出的不是 Error 时按字符串兜底', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function ThrowsString(): never {
      throw '纯文本异常'
    }
    render(
      <ErrorBoundary>
        <ThrowsString />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('纯文本异常')
    error.mockRestore()
  })

  it('点「重新加载」调用 location.reload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    })
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(reload).toHaveBeenCalledTimes(1)
    Object.defineProperty(window, 'location', { configurable: true, value: original })
    error.mockRestore()
  })

  it('换 key 重建边界后恢复正常渲染（切换 app 可继续用）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    armed = true
    const { rerender } = render(
      <ErrorBoundary key="a">
        <SometimesBoom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    armed = false
    rerender(
      <ErrorBoundary key="b">
        <SometimesBoom />
      </ErrorBoundary>,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    armed = true
    error.mockRestore()
  })
})
