import type { Phase, PomodoroConfig, PomodoroEvent, PomodoroState } from './types'
import { CONFIG_LIMITS, DEFAULT_CONFIG } from './types'

export { CONFIG_LIMITS, DEFAULT_CONFIG } from './types'

const MIN = 60_000

export function createInitialState(config: PomodoroConfig = DEFAULT_CONFIG): PomodoroState {
  return {
    phase: 'idle',
    remainingMs: config.focusMin * MIN,
    endsAt: null,
    completedRounds: 0,
    justCompleted: false,
    config
  }
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value))
}

/** 阶段对应时长（毫秒）。UI 也用它生成通知文案 */
export function phaseDurationMs(config: PomodoroConfig, phase: Phase): number {
  switch (phase) {
    case 'shortBreak':
      return config.shortBreakMin * MIN
    case 'longBreak':
      return config.longBreakMin * MIN
    case 'focus':
    case 'idle':
      return config.focusMin * MIN
  }
}

function isBreak(phase: Phase): boolean {
  return phase === 'shortBreak' || phase === 'longBreak'
}

/** 专注结束后的下一阶段：自然完成整 n 轮（且至少 1 轮）才进长休息 */
function nextPhaseAfterFocus(config: PomodoroConfig, completedRounds: number): Phase {
  const due = completedRounds > 0 && completedRounds % config.roundsBeforeLongBreak === 0
  return due ? 'longBreak' : 'shortBreak'
}

/**
 * 切换到下一阶段的就绪态（暂停等待用户确认）。
 * countRound 仅在专注"自然到 0"时为 true；SKIP 永不计轮。
 */
function advance(state: PomodoroState, countRound: boolean): PomodoroState {
  const completedRounds =
    countRound && state.phase === 'focus' ? state.completedRounds + 1 : state.completedRounds
  const nextPhase = isBreak(state.phase)
    ? 'focus'
    : nextPhaseAfterFocus(state.config, completedRounds)
  return {
    ...state,
    phase: nextPhase,
    remainingMs: phaseDurationMs(state.config, nextPhase),
    endsAt: null,
    completedRounds,
    justCompleted: countRound
  }
}

/**
 * 纯 reducer：所有计时/切阶段/计轮规则都集中在这里，UI 不写业务规则。
 * 计时基于时间戳差值（endsAt），TICK 用真实时钟的 now 驱动。
 */
export function reduce(state: PomodoroState, event: PomodoroEvent): PomodoroState {
  switch (event.type) {
    case 'START': {
      if (state.endsAt !== null) return state
      return {
        ...state,
        phase: state.phase === 'idle' ? 'focus' : state.phase,
        endsAt: event.now + state.remainingMs,
        justCompleted: false
      }
    }
    case 'PAUSE': {
      if (state.endsAt === null) return state
      return {
        ...state,
        remainingMs: Math.max(0, state.endsAt - event.now),
        endsAt: null,
        justCompleted: false
      }
    }
    case 'TICK': {
      if (state.endsAt === null) return state
      const remaining = Math.max(0, state.endsAt - event.now)
      return remaining === 0
        ? advance(state, true)
        : { ...state, remainingMs: remaining, justCompleted: false }
    }
    case 'PHASE_COMPLETE': {
      return state.endsAt === null ? state : advance(state, true)
    }
    case 'SKIP': {
      return advance(state, false)
    }
    case 'RESET': {
      return createInitialState(state.config)
    }
    case 'SET_CONFIG': {
      if (state.endsAt !== null) return state
      const config: PomodoroConfig = {
        focusMin: clamp(event.patch.focusMin ?? state.config.focusMin, CONFIG_LIMITS.focusMin),
        shortBreakMin: clamp(
          event.patch.shortBreakMin ?? state.config.shortBreakMin,
          CONFIG_LIMITS.shortBreakMin
        ),
        longBreakMin: clamp(
          event.patch.longBreakMin ?? state.config.longBreakMin,
          CONFIG_LIMITS.longBreakMin
        ),
        roundsBeforeLongBreak: clamp(
          event.patch.roundsBeforeLongBreak ?? state.config.roundsBeforeLongBreak,
          CONFIG_LIMITS.roundsBeforeLongBreak
        )
      }
      return {
        ...state,
        config,
        // 仅 idle 态重算展示剩余时间；暂停中的冻结时长不变，新时长作用于下一阶段
        remainingMs: state.phase === 'idle' ? config.focusMin * MIN : state.remainingMs,
        justCompleted: false
      }
    }
  }
}
