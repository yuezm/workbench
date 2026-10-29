import { useId } from 'react'
import type { ReactElement } from 'react'
import { PHASE_LABELS } from '../hooks/usePomodoro'
import type { Phase } from '../timer/types'
import { cn } from '../../../lib/cn'

/** 剩余毫秒 → mm:ss（向上取整到秒，倒计时显示惯例） */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 各阶段的视觉主题：色点 / 渐变端色 */
const PHASE_THEME: Record<Phase, { text: string; dot: string; from: string; to: string }> = {
  idle: { text: 'text-focus', dot: 'bg-focus', from: '#8b7cf7', to: '#6d5ce8' },
  focus: { text: 'text-focus', dot: 'bg-focus', from: '#8b7cf7', to: '#6d5ce8' },
  shortBreak: { text: 'text-short', dot: 'bg-short', from: '#2dd4a8', to: '#14b8a6' },
  longBreak: { text: 'text-long', dot: 'bg-long', from: '#4aa8f7', to: '#3b82f6' }
}

const RING_SIZE = 296
const RING_STROKE = 5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

interface TimerDisplayProps {
  phase: Phase
  remainingMs: number
  completedRounds: number
  roundsBeforeLongBreak: number
  /** 当前阶段总时长；用于绘制进度环，缺省视为满环 */
  totalMs?: number
}

export function TimerDisplay({
  phase,
  remainingMs,
  completedRounds,
  roundsBeforeLongBreak,
  totalMs
}: TimerDisplayProps): ReactElement {
  const gradId = useId()
  const theme = PHASE_THEME[phase]

  const progress =
    totalMs !== undefined && totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 1

  return (
    <div className="animate-rise relative grid place-items-center">
      {/* 进度环 */}
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={theme.from} />
            <stop offset="100%" stopColor={theme.to} />
          </linearGradient>
        </defs>
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          className="stroke-white/[0.06]"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          stroke={`url(#${gradId})`}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
          className="transition-[stroke-dashoffset] duration-300 ease-linear"
          style={{ filter: `drop-shadow(0 0 6px ${theme.from})` }}
        />
      </svg>

      {/* 环内内容 */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-full border border-line bg-white/[0.03] px-4 py-1.5',
            'text-xs tracking-[0.3em] text-ink-dim backdrop-blur-sm'
          )}
        >
          <i className={cn('size-1.5 rounded-full', theme.dot)} aria-hidden="true" />
          {PHASE_LABELS[phase]}
        </span>

        <span
          className={cn(
            'bg-gradient-to-b from-white to-white/60 bg-clip-text tabular-nums',
            'text-[80px] leading-none font-extralight tracking-tight text-transparent'
          )}
        >
          {formatRemaining(remainingMs)}
        </span>

        <span className="flex items-center gap-2" aria-label={`已完成 ${completedRounds} 轮`}>
          {Array.from({ length: roundsBeforeLongBreak }, (_, i) => (
            <i
              key={i}
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full transition-colors duration-300',
                i < completedRounds ? theme.dot : 'bg-white/10'
              )}
              style={i < completedRounds ? { boxShadow: `0 0 6px ${theme.from}` } : undefined}
            />
          ))}
          <em className="ml-1 text-xs text-ink-faint not-italic tabular-nums">
            {completedRounds} / {roundsBeforeLongBreak}
          </em>
        </span>
      </div>
    </div>
  )
}
