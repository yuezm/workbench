import { ChangeEvent } from 'react'
import type { ReactElement } from 'react'
import type { PomodoroConfig } from '../timer/types'
import { CONFIG_LIMITS } from '../timer/types'
import styles from './settings-panel.module.css'

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
  onCommit
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
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        disabled={disabled}
        onChange={handle}
        inputMode="numeric"
      />
    </label>
  )
}

export function SettingsPanel({
  config,
  running,
  onChange
}: SettingsPanelProps): ReactElement {
  return (
    <details className={styles.panel}>
      <summary>设置</summary>
      <div className={styles.grid}>
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
      <p className={styles.hint}>
        范围：专注 {CONFIG_LIMITS.focusMin.min}–{CONFIG_LIMITS.focusMin.max}，短休息{' '}
        {CONFIG_LIMITS.shortBreakMin.min}–{CONFIG_LIMITS.shortBreakMin.max}，长休息{' '}
        {CONFIG_LIMITS.longBreakMin.min}–{CONFIG_LIMITS.longBreakMin.max}，轮数{' '}
        {CONFIG_LIMITS.roundsBeforeLongBreak.min}–{CONFIG_LIMITS.roundsBeforeLongBreak.max}。计时
        中不可修改。
      </p>
    </details>
  )
}
