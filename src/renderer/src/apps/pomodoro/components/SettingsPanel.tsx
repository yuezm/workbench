import { ChangeEvent } from 'react'
import type { ReactElement } from 'react'
import type { PomodoroConfig } from '../timer/types'
import { CONFIG_LIMITS } from '../timer/types'
import { cn } from '../../../lib/cn'

interface SettingsPanelProps {
  config: PomodoroConfig
  /** 运行中禁用（配置变更仅在 idle/paused 生效，钳制由状态机负责） */
  running: boolean
  onChange: (patch: Partial<PomodoroConfig>) => void
}

function NumberField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string
  value: number
  disabled: boolean
  onCommit: (value: number) => void
}): ReactElement {
  const handle = (e: ChangeEvent<HTMLInputElement>): void => {
    const parsed = Number(e.target.value)
    if (e.target.value !== '' && !Number.isNaN(parsed)) onCommit(parsed)
  }
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-dim">{label}</span>
      <input
        type="number"
        value={value}
        disabled={disabled}
        onChange={handle}
        inputMode="numeric"
        className={cn(
          'h-10 rounded-xl border border-line bg-black/20 px-3 text-sm text-ink tabular-nums',
          'transition-all duration-200 outline-none',
          'hover:border-line-strong',
          'focus:border-focus/60 focus:ring-2 focus:ring-focus/25',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line',
        )}
      />
    </label>
  )
}

export function SettingsPanel({ config, running, onChange }: SettingsPanelProps): ReactElement {
  return (
    <details className="group w-full max-w-md animate-rise [animation-delay:160ms]">
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center justify-between rounded-2xl',
          'border border-line bg-white/[0.03] px-5 py-3 backdrop-blur-md',
          'text-sm text-ink-dim transition-colors duration-200',
          'hover:bg-white/[0.05] hover:text-ink [&::-webkit-details-marker]:hidden',
        )}
      >
        <span className="inline-flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
            <circle cx="15" cy="7" r="2.2" />
            <circle cx="9" cy="17" r="2.2" />
          </svg>
          设置
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="transition-transform duration-200 group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>

      <div className="mt-3 rounded-2xl border border-line bg-white/[0.03] p-5 shadow-[0_16px_48px_-24px_rgb(0_0_0/60%)] backdrop-blur-md">
        <div className="grid grid-cols-2 gap-4">
          <NumberField
            label={`专注（分钟）`}
            value={config.focusMin}
            disabled={running}
            onCommit={(focusMin) => onChange({ focusMin })}
          />
          <NumberField
            label={`短休息（分钟）`}
            value={config.shortBreakMin}
            disabled={running}
            onCommit={(shortBreakMin) => onChange({ shortBreakMin })}
          />
          <NumberField
            label={`长休息（分钟）`}
            value={config.longBreakMin}
            disabled={running}
            onCommit={(longBreakMin) => onChange({ longBreakMin })}
          />
          <NumberField
            label={`每几轮长休（轮）`}
            value={config.roundsBeforeLongBreak}
            disabled={running}
            onCommit={(roundsBeforeLongBreak) => onChange({ roundsBeforeLongBreak })}
          />
        </div>
        <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
          范围：专注 {CONFIG_LIMITS.focusMin.min}–{CONFIG_LIMITS.focusMin.max}，短休息{' '}
          {CONFIG_LIMITS.shortBreakMin.min}–{CONFIG_LIMITS.shortBreakMin.max}，长休息{' '}
          {CONFIG_LIMITS.longBreakMin.min}–{CONFIG_LIMITS.longBreakMin.max}，轮数{' '}
          {CONFIG_LIMITS.roundsBeforeLongBreak.min}–{CONFIG_LIMITS.roundsBeforeLongBreak.max}。计时
          中不可修改。
        </p>
      </div>
    </details>
  )
}
