import { useCallback, useEffect, useReducer, useRef } from 'react'
import { getKernelStore } from '../../../shell/kernelStore'
import type { RingPlayer } from '../audio'
import { createRingPlayer } from '../audio'
import { createInitialState, phaseDurationMs, reduce } from '../timer/machine'
import type { PomodoroConfig, PomodoroState } from '../timer/types'

const TICK_INTERVAL_MS = 250
const MIN = 60_000

export const PHASE_LABELS: Record<PomodoroState['phase'], string> = {
  idle: '专注',
  focus: '专注',
  shortBreak: '短休息',
  longBreak: '长休息',
}

export interface PomodoroController {
  state: PomodoroState
  start(): void
  pause(): void
  reset(): void
  skip(): void
  setConfig(patch: Partial<PomodoroConfig>): void
}

interface UsePomodoroDeps {
  /** 测试注入；缺省用真实 Web Audio 播放器 */
  ring?: RingPlayer
}

/**
 * 状态机与 UI 的接线层：驱动 interval、把"阶段自然结束"接到响铃 + 系统通知。
 * 业务规则全部在 timer/machine.ts，这里只有副作用与调度。
 */
export function usePomodoro(deps?: UsePomodoroDeps): PomodoroController {
  const [state, dispatch] = useReducer(reduce, undefined, () => createInitialState())

  const ringRef = useRef<RingPlayer | null>(null)
  if (ringRef.current === null) {
    ringRef.current = deps?.ring ?? createRingPlayer()
  }

  useEffect(() => {
    if (!state.justCompleted) return
    ringRef.current!.play()
    const label = PHASE_LABELS[state.phase]
    const minutes = Math.round(phaseDurationMs(state.config, state.phase) / MIN)
    window.workbench.notify('番茄时钟', `已进入${label}（${minutes} 分钟），准备好后点击开始`)
    // 计时完成（专注/短休息/长休息自然到 0）发一条 app 事件；事件类型必须与
    // `src/shared/apps.ts` 的白名单一致，M6 起由规则消费。
    void getKernelStore()
      .dispatch({
        type: 'app.event',
        commandId: '',
        appId: 'pomodoro',
        eventType: 'pomodoro.completed',
        subject: '番茄完成',
      })
      .catch(() => {
        // 事件入账失败不影响本地的响铃与通知；下一次完成仍会再发
      })
  }, [state])

  useEffect(() => {
    if (state.endsAt === null) return
    const id = window.setInterval(() => {
      dispatch({ type: 'TICK', now: Date.now() })
    }, TICK_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [state.endsAt])

  const start = useCallback(() => dispatch({ type: 'START', now: Date.now() }), [])
  const pause = useCallback(() => dispatch({ type: 'PAUSE', now: Date.now() }), [])
  const reset = useCallback(() => dispatch({ type: 'RESET' }), [])
  const skip = useCallback(() => dispatch({ type: 'SKIP' }), [])
  const setConfig = useCallback(
    (patch: Partial<PomodoroConfig>) => dispatch({ type: 'SET_CONFIG', patch }),
    [],
  )

  return { state, start, pause, reset, skip, setConfig }
}
