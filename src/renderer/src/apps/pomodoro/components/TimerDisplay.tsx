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

/**
 * 各阶段的视觉主题：色点 / 渐变端色。
 *
 * 全部走主题 token（`--brand` / `--success` / `--info` 及其深色端），
 * 亮暗两套主题各有一套值——不写死颜色，否则亮色主题下会看不见。
 */
const PHASE_THEME: Record<Phase, { dot: string; from: string; to: string }> = {
  idle: {
    dot: 'bg-primary',
    from: 'var(--brand)',
    to: 'var(--ring)',
  },
  focus: {
    dot: 'bg-primary',
    from: 'var(--brand)',
    to: 'var(--ring)',
  },
  shortBreak: {
    dot: 'bg-success',
    from: 'var(--success)',
    to: 'var(--success-deep)',
  },
  longBreak: {
    dot: 'bg-info',
    from: 'var(--info)',
    to: 'var(--info-deep)',
  },
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
  totalMs,
}: TimerDisplayProps): ReactElement {
  const gradId = useId()
  const theme = PHASE_THEME[phase]

  const progress =
    totalMs !== undefined && totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 1

  return (
    <div className="relative grid animate-rise place-items-center">
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
          className="stroke-border"
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
          // 光晕取阶段色的半透明版：亮底上是淡淡一层，不糊成光斑（SPEC-ui §6）
          style={{
            filter: `drop-shadow(0 0 5px color-mix(in oklab, ${theme.from} 45%, transparent))`,
          }}
        />
      </svg>

      {/* 环内内容 */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-md border border-border bg-muted px-4 py-1.5',
            'text-xs tracking-[0.3em] text-muted-foreground',
          )}
        >
          <i className={cn('size-1.5 rounded-full', theme.dot)} aria-hidden="true" />
          {PHASE_LABELS[phase]}
        </span>

        {/* 倒计时数字：前景色渐变（亮色主题深字、暗色主题亮字），不写死白色 */}
        <span
          className={cn(
            'bg-gradient-to-b from-foreground to-foreground/70 bg-clip-text tabular-nums',
            'text-[80px] leading-none font-extralight text-transparent',
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
                i < completedRounds ? theme.dot : 'bg-muted',
              )}
              style={i < completedRounds ? { boxShadow: `0 0 6px ${theme.from}` } : undefined}
            />
          ))}
          <em className="ml-1 text-xs text-faint-foreground not-italic tabular-nums">
            {completedRounds} / {roundsBeforeLongBreak}
          </em>
        </span>
      </div>
    </div>
  )
}
