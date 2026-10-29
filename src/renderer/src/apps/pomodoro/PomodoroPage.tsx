import type { ReactElement } from 'react'
import { Controls } from './components/Controls'
import { SettingsPanel } from './components/SettingsPanel'
import { TimerDisplay } from './components/TimerDisplay'
import { usePomodoro } from './hooks/usePomodoro'
import styles from './pomodoro-page.module.css'

export function PomodoroPage(): ReactElement {
  const { state, start, pause, reset, skip, setConfig } = usePomodoro()
  const running = state.endsAt !== null

  return (
    <div className={styles.page}>
      <TimerDisplay
        phase={state.phase}
        remainingMs={state.remainingMs}
        completedRounds={state.completedRounds}
        roundsBeforeLongBreak={state.config.roundsBeforeLongBreak}
      />
      <Controls
        running={running}
        onStart={start}
        onPause={pause}
        onReset={reset}
        onSkip={skip}
      />
      <SettingsPanel config={state.config} running={running} onChange={setConfig} />
    </div>
  )
}
