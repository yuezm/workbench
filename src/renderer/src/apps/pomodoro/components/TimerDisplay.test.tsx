import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TimerDisplay, formatRemaining } from './TimerDisplay'

describe('formatRemaining', () => {
  it.each([
    [25 * 60_000, '25:00'],
    [0, '00:00'],
    [65_500, '01:06'],
    [5_000, '00:05'],
    [999, '00:01']
  ])('%d ms → %s（向上取整到秒）', (ms, expected) => {
    expect(formatRemaining(ms)).toBe(expected)
  })
})

describe('TimerDisplay', () => {
  it('显示当前阶段中文名与大号倒计时', () => {
    render(
      <TimerDisplay
        phase="focus"
        remainingMs={25 * 60_000}
        completedRounds={2}
        roundsBeforeLongBreak={4}
      />
    )
    expect(screen.getByText('专注')).toBeInTheDocument()
    expect(screen.getByText('25:00')).toBeInTheDocument()
  })

  it('显示已完成轮数与长休间隔（2/4）', () => {
    render(
      <TimerDisplay
        phase="shortBreak"
        remainingMs={3 * 60_000}
        completedRounds={2}
        roundsBeforeLongBreak={4}
      />
    )
    expect(screen.getByText(/2\s*\/\s*4/)).toBeInTheDocument()
    expect(screen.getByText('短休息')).toBeInTheDocument()
  })

  it('长休息阶段显示"长休息"', () => {
    render(
      <TimerDisplay
        phase="longBreak"
        remainingMs={10 * 60_000}
        completedRounds={4}
        roundsBeforeLongBreak={4}
      />
    )
    expect(screen.getByText('长休息')).toBeInTheDocument()
  })
})
