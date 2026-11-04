import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PomodoroPage } from '../../../../../src/renderer/src/apps/pomodoro/PomodoroPage'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('番茄时钟页面', () => {
  it('初始显示"专注 25:00"与控制按钮', () => {
    vi.stubGlobal('workbench', { notify: vi.fn() })
    render(<PomodoroPage />)
    expect(screen.getByText('专注')).toBeInTheDocument()
    expect(screen.getByText('25:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始' })).toBeInTheDocument()
  })

  it('跳过 → 立即切到短休息且不触发通知', async () => {
    const notify = vi.fn()
    vi.stubGlobal('workbench', { notify })
    render(<PomodoroPage />)
    await userEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(screen.getByText('短休息')).toBeInTheDocument()
    expect(notify).not.toHaveBeenCalled()
  })

  it('开始后主按钮变为"暂停"', async () => {
    vi.stubGlobal('workbench', { notify: vi.fn() })
    render(<PomodoroPage />)
    await userEvent.click(screen.getByRole('button', { name: '开始' }))
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument()
  })

  it('设置面板：修改专注时长后倒计时显示立即更新', async () => {
    vi.stubGlobal('workbench', { notify: vi.fn() })
    render(<PomodoroPage />)
    await userEvent.click(screen.getByText('设置'))
    fireEvent.change(screen.getByLabelText('专注（分钟）'), { target: { value: '50' } })
    expect(screen.getByText('50:00')).toBeInTheDocument()
  })

  it('运行中设置面板禁用：开始后输入不可用', async () => {
    vi.stubGlobal('workbench', { notify: vi.fn() })
    render(<PomodoroPage />)
    await userEvent.click(screen.getByText('设置'))
    await userEvent.click(screen.getByRole('button', { name: '开始' }))
    expect(screen.getByLabelText('专注（分钟）')).toBeDisabled()
  })
})
