import type { ReactElement } from 'react'
import { Controls } from './components/Controls'
import { SettingsPanel } from './components/SettingsPanel'
import { TimerDisplay } from './components/TimerDisplay'
import { usePomodoro } from './hooks/usePomodoro'
import { phaseDurationMs } from './timer/machine'

export function PomodoroPage(): ReactElement {
  const { state, start, pause, reset, skip, setConfig } = usePomodoro()
  const running = state.endsAt !== null

  return (
    // 外层可滚动、内层 min-h-full：展开设置面板后内容超高时整体滚动，不被裁掉
    <div className="h-full overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center gap-10 px-6 py-8">
        <TimerDisplay
          phase={state.phase}
          remainingMs={state.remainingMs}
          completedRounds={state.completedRounds}
          roundsBeforeLongBreak={state.config.roundsBeforeLongBreak}
          totalMs={phaseDurationMs(state.config, state.phase)}
        />
        <Controls running={running} onStart={start} onPause={pause} onReset={reset} onSkip={skip} />
        <SettingsPanel config={state.config} running={running} onChange={setConfig} />
      </div>
    </div>
  )
}
