import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  TimerDisplay,
  formatRemaining,
} from '../../../../../../src/renderer/src/apps/pomodoro/components/TimerDisplay'

describe('formatRemaining', () => {
  it.each([
    [25 * 60_000, '25:00'],
    [0, '00:00'],
    [65_500, '01:06'],
    [5_000, '00:05'],
    [999, '00:01'],
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
      />,
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
      />,
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
      />,
    )
    expect(screen.getByText('长休息')).toBeInTheDocument()
  })

  // 主题适配：颜色只能走 token，写死白色会让亮色主题下的倒计时看不见
  it('倒计时数字走前景色 token，不写死白色', () => {
    render(
      <TimerDisplay
        phase="focus"
        remainingMs={25 * 60_000}
        completedRounds={0}
        roundsBeforeLongBreak={4}
      />,
    )
    const digits = screen.getByText('25:00')
    expect(digits.className).toContain('from-foreground')
    expect(digits.className).not.toMatch(/\bfrom-white\b/)
  })

  it('进度环底轨走 border token，不写死白色', () => {
    const { container } = render(
      <TimerDisplay
        phase="focus"
        remainingMs={25 * 60_000}
        completedRounds={0}
        roundsBeforeLongBreak={4}
      />,
    )
    expect(container.querySelector('circle.stroke-border')).not.toBeNull()
    expect(container.innerHTML).not.toContain('white')
  })

  it('阶段主题色取 token 变量（专注 --brand / 短休 --success / 长休 --info）', () => {
    const stopsOf = (phase: 'focus' | 'shortBreak' | 'longBreak'): (string | null)[] => {
      const { container } = render(
        <TimerDisplay
          phase={phase}
          remainingMs={60_000}
          completedRounds={0}
          roundsBeforeLongBreak={4}
        />,
      )
      return [...container.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color'))
    }
    expect(stopsOf('focus')).toEqual(['var(--brand)', 'var(--ring)'])
    expect(stopsOf('shortBreak')).toEqual(['var(--success)', 'var(--success-deep)'])
    expect(stopsOf('longBreak')).toEqual(['var(--info)', 'var(--info-deep)'])
  })
})
