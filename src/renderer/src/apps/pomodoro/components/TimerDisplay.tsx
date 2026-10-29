import type { ReactElement } from 'react'
import { PHASE_LABELS } from '../hooks/usePomodoro'
import type { Phase } from '../timer/types'
import styles from './timer-display.module.css'

/** 剩余毫秒 → mm:ss（向上取整到秒，倒计时显示惯例） */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

interface TimerDisplayProps {
  phase: Phase
  remainingMs: number
  completedRounds: number
  roundsBeforeLongBreak: number
}

export function TimerDisplay({
  phase,
  remainingMs,
  completedRounds,
  roundsBeforeLongBreak
}: TimerDisplayProps): ReactElement {
  const phaseClass =
    phase === 'focus' || phase === 'idle'
      ? styles.focusPhase
      : phase === 'shortBreak'
        ? styles.shortBreakPhase
        : styles.longBreakPhase

  return (
    <div className={`${styles.display} ${phaseClass}`}>
      <span className={styles.phaseLabel}>{PHASE_LABELS[phase]}</span>
      <span className={styles.time}>{formatRemaining(remainingMs)}</span>
      <span className={styles.rounds} aria-label={`已完成 ${completedRounds} 轮`}>
        {Array.from({ length: roundsBeforeLongBreak }, (_, i) => (
          <i
            key={i}
            className={i < completedRounds ? styles.dotFilled : styles.dotEmpty}
            aria-hidden="true"
          />
        ))}
        <em>
          {completedRounds} / {roundsBeforeLongBreak}
        </em>
      </span>
    </div>
  )
}
