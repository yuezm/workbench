import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Controls } from '../../../../../../src/renderer/src/apps/pomodoro/components/Controls'

function setup(running: boolean) {
  const handlers = {
    onStart: vi.fn(),
    onPause: vi.fn(),
    onReset: vi.fn(),
    onSkip: vi.fn(),
  }
  render(<Controls running={running} {...handlers} />)
  return handlers
}

describe('Controls', () => {
  it('未运行时显示"开始"按钮，运行时显示"暂停"', () => {
    const handlers = {
      onStart: vi.fn(),
      onPause: vi.fn(),
      onReset: vi.fn(),
      onSkip: vi.fn(),
    }
    const { unmount } = render(<Controls running={false} {...handlers} />)
    expect(screen.getByRole('button', { name: '开始' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument()
    unmount()
    render(<Controls running={true} {...handlers} />)
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开始' })).not.toBeInTheDocument()
  })

  it('重置与跳过始终可用', () => {
    setup(false)
    expect(screen.getByRole('button', { name: '重置' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳过' })).toBeInTheDocument()
  })

  it('点击各按钮触发对应回调', async () => {
    const handlers = setup(false)
    await userEvent.click(screen.getByRole('button', { name: '开始' }))
    await userEvent.click(screen.getByRole('button', { name: '重置' }))
    await userEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(handlers.onStart).toHaveBeenCalledTimes(1)
    expect(handlers.onReset).toHaveBeenCalledTimes(1)
    expect(handlers.onSkip).toHaveBeenCalledTimes(1)
    expect(handlers.onPause).not.toHaveBeenCalled()
  })
})
