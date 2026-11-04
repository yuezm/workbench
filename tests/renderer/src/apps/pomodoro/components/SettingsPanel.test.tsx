import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../../../../../src/renderer/src/apps/pomodoro/timer/machine'
import { SettingsPanel } from '../../../../../../src/renderer/src/apps/pomodoro/components/SettingsPanel'

describe('SettingsPanel', () => {
  it('渲染四个配置项，值来自 config', () => {
    render(<SettingsPanel config={DEFAULT_CONFIG} running={false} onChange={() => {}} />)
    expect(screen.getByLabelText('专注（分钟）')).toHaveValue(25)
    expect(screen.getByLabelText('短休息（分钟）')).toHaveValue(5)
    expect(screen.getByLabelText('长休息（分钟）')).toHaveValue(15)
    expect(screen.getByLabelText('每几轮长休（轮）')).toHaveValue(4)
  })

  it.each([
    ['专注（分钟）', { focusMin: 50 }],
    ['短休息（分钟）', { shortBreakMin: 10 }],
    ['长休息（分钟）', { longBreakMin: 20 }],
    ['每几轮长休（轮）', { roundsBeforeLongBreak: 6 }],
  ])('提交"%s"触发 onChange 携带对应字段', (label, expectedPatch) => {
    const onChange = vi.fn()
    render(<SettingsPanel config={DEFAULT_CONFIG} running={false} onChange={onChange} />)
    const input = screen.getByLabelText(label as string)
    fireEvent.change(input, { target: { value: String(Object.values(expectedPatch)[0]) } })
    expect(onChange).toHaveBeenLastCalledWith(expectedPatch)
  })

  it('空输入不触发 onChange', () => {
    const onChange = vi.fn()
    render(<SettingsPanel config={DEFAULT_CONFIG} running={false} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('专注（分钟）'), { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('运行中所有输入禁用', () => {
    render(<SettingsPanel config={DEFAULT_CONFIG} running={true} onChange={() => {}} />)
    for (const label of ['专注（分钟）', '短休息（分钟）', '长休息（分钟）', '每几轮长休（轮）']) {
      expect(screen.getByLabelText(label)).toBeDisabled()
    }
  })

  it('非运行态输入可用', () => {
    render(<SettingsPanel config={DEFAULT_CONFIG} running={false} onChange={() => {}} />)
    expect(screen.getByLabelText('专注（分钟）')).toBeEnabled()
  })
})
