export type Phase = 'idle' | 'focus' | 'shortBreak' | 'longBreak'

export interface PomodoroConfig {
  /** 专注时长（分钟） */
  focusMin: number
  /** 短休息时长（分钟） */
  shortBreakMin: number
  /** 长休息时长（分钟） */
  longBreakMin: number
  /** 每完成几轮专注进入长休息 */
  roundsBeforeLongBreak: number
}

export interface ConfigRange {
  min: number
  max: number
}

export const DEFAULT_CONFIG: PomodoroConfig = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsBeforeLongBreak: 4,
}

export const CONFIG_LIMITS: Record<keyof PomodoroConfig, ConfigRange> = {
  focusMin: { min: 1, max: 120 },
  shortBreakMin: { min: 1, max: 30 },
  longBreakMin: { min: 1, max: 60 },
  roundsBeforeLongBreak: { min: 2, max: 8 },
}

export type PomodoroEvent =
  | { type: 'START'; now: number }
  | { type: 'PAUSE'; now: number }
  | { type: 'TICK'; now: number }
  | { type: 'PHASE_COMPLETE' }
  | { type: 'SKIP' }
  | { type: 'RESET' }
  | { type: 'SET_CONFIG'; patch: Partial<PomodoroConfig> }

export interface PomodoroState {
  phase: Phase
  /** 冻结的剩余毫秒数；运行中的真实剩余时间以 endsAt 计算 */
  remainingMs: number
  /** 运行中的绝对截止时间戳；idle / paused 为 null */
  endsAt: number | null
  /** 已自然完成（非跳过）的专注轮数 */
  completedRounds: number
  /** 最近一次转移是否为"阶段自然到 0"（UI 据此决定是否响铃+通知；SKIP 恒为 false） */
  justCompleted: boolean
  config: PomodoroConfig
}
