// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CONFIG_LIMITS,
  DEFAULT_CONFIG,
  createInitialState,
  reduce,
} from '../../../../../../src/renderer/src/apps/pomodoro/timer/machine'
import type {
  PomodoroConfig,
  PomodoroState,
} from '../../../../../../src/renderer/src/apps/pomodoro/timer/types'

const MIN = 60_000

/** 便利构造：从初始态出发依次派发事件 */
function run(start: PomodoroState, ...events: Parameters<typeof reduce>[1][]): PomodoroState {
  return events.reduce(reduce, start)
}

function withConfig(patch: Partial<PomodoroConfig>): PomodoroState {
  return run(createInitialState(), { type: 'SET_CONFIG', patch })
}

describe('初始状态', () => {
  it('phase 为 idle，剩余时间为默认专注时长 25 分钟，已完成轮数为 0', () => {
    const s = createInitialState()
    expect(s.phase).toBe('idle')
    expect(s.remainingMs).toBe(25 * MIN)
    expect(s.endsAt).toBeNull()
    expect(s.completedRounds).toBe(0)
    expect(s.config).toEqual(DEFAULT_CONFIG)
  })
})

describe('START / PAUSE / TICK', () => {
  it('START：idle → focus，endsAt = now + remainingMs', () => {
    const s = run(createInitialState(), { type: 'START', now: 1_000 })
    expect(s.phase).toBe('focus')
    expect(s.endsAt).toBe(1_000 + 25 * MIN)
    expect(s.remainingMs).toBe(25 * MIN)
  })

  it('TICK：随真实时间递减 remainingMs（时间戳差值）', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    const s = run(started, { type: 'TICK', now: 30_000 })
    expect(s.remainingMs).toBe(25 * MIN - 30_000)
    expect(s.endsAt).not.toBeNull()
  })

  it('PAUSE：冻结剩余时间，endsAt 清空', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    const s = run(started, { type: 'PAUSE', now: 30_000 })
    expect(s.remainingMs).toBe(25 * MIN - 30_000)
    expect(s.endsAt).toBeNull()
    expect(s.phase).toBe('focus')
  })

  it('暂停后 START：从冻结的剩余时间继续', () => {
    const paused = run(
      createInitialState(),
      { type: 'START', now: 0 },
      { type: 'PAUSE', now: 30_000 },
    )
    const s = run(paused, { type: 'START', now: 100_000 })
    expect(s.endsAt).toBe(100_000 + (25 * MIN - 30_000))
  })

  it('TICK 在暂停/idle 状态下为 no-op', () => {
    const paused = run(
      createInitialState(),
      { type: 'START', now: 0 },
      { type: 'PAUSE', now: 30_000 },
    )
    expect(run(paused, { type: 'TICK', now: 500_000 })).toEqual(paused)
    expect(run(createInitialState(), { type: 'TICK', now: 500_000 })).toEqual(createInitialState())
  })

  it('PAUSE 在未运行（idle）状态下为 no-op', () => {
    expect(run(createInitialState(), { type: 'PAUSE', now: 100 })).toEqual(createInitialState())
  })
})

describe('阶段自然结束（PHASE_COMPLETE 语义）', () => {
  it('专注自然到 0 → 计一轮，进入短休息就绪态（暂停等待确认）', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    const s = run(started, { type: 'TICK', now: 25 * MIN })
    expect(s.phase).toBe('shortBreak')
    expect(s.completedRounds).toBe(1)
    expect(s.remainingMs).toBe(5 * MIN)
    expect(s.endsAt).toBeNull()
  })

  it('第 4 轮专注结束 → 进入长休息', () => {
    let s = createInitialState()
    for (let round = 0; round < 4; round++) {
      s = run(s, { type: 'START', now: 0 }, { type: 'TICK', now: 25 * MIN })
      if (round < 3) s = run(s, { type: 'START', now: 0 }, { type: 'TICK', now: 5 * MIN })
    }
    expect(s.completedRounds).toBe(4)
    expect(s.phase).toBe('longBreak')
    expect(s.remainingMs).toBe(15 * MIN)
  })

  it('休息自然结束 → 回到专注，已完成轮数不变', () => {
    const afterFocus = run(
      createInitialState(),
      { type: 'START', now: 0 },
      { type: 'TICK', now: 25 * MIN },
    )
    const s = run(afterFocus, { type: 'START', now: 0 }, { type: 'TICK', now: 5 * MIN })
    expect(s.phase).toBe('focus')
    expect(s.completedRounds).toBe(1)
    expect(s.remainingMs).toBe(25 * MIN)
  })

  it('大幅时间跳跃（模拟休眠恢复）：直接落到 0 并完成阶段切换', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    const s = run(started, { type: 'TICK', now: 10 * 60 * MIN })
    expect(s.phase).toBe('shortBreak')
    expect(s.completedRounds).toBe(1)
    expect(s.remainingMs).toBe(5 * MIN)
  })
})

describe('SKIP', () => {
  it('运行中跳过专注：进入短休息就绪态，不计轮数', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    const s = run(started, { type: 'SKIP' })
    expect(s.phase).toBe('shortBreak')
    expect(s.completedRounds).toBe(0)
    expect(s.endsAt).toBeNull()
  })

  it('跳过不计轮数：完成 3 轮后跳过第 4 轮专注 → 仍是短休息且轮数停在第 3', () => {
    let s = withConfig({})
    for (let round = 0; round < 3; round++) {
      s = run(s, { type: 'START', now: 0 }, { type: 'TICK', now: 25 * MIN })
      s = run(s, { type: 'START', now: 0 }, { type: 'TICK', now: 5 * MIN })
    }
    // 此刻处于第 4 轮专注就绪态
    s = run(s, { type: 'START', now: 0 }, { type: 'SKIP' })
    expect(s.completedRounds).toBe(3)
    expect(s.phase).toBe('shortBreak')
  })

  it('跳过休息 → 回到专注', () => {
    const afterFocus = run(
      createInitialState(),
      { type: 'START', now: 0 },
      { type: 'TICK', now: 25 * MIN },
    )
    const s = run(afterFocus, { type: 'SKIP' })
    expect(s.phase).toBe('focus')
    expect(s.completedRounds).toBe(1)
  })

  it('初始 idle 态跳过（视为跳过专注）→ 短休息，不会因 0%4===0 误入长休息', () => {
    const s = run(createInitialState(), { type: 'SKIP' })
    expect(s.phase).toBe('shortBreak')
    expect(s.completedRounds).toBe(0)
  })
})

describe('RESET', () => {
  it('回到初始态：idle、专注时长、轮数清零，但保留已修改的配置', () => {
    const customized = withConfig({ focusMin: 50 })
    const mid = run(
      customized,
      { type: 'START', now: 0 },
      { type: 'TICK', now: 25 * MIN },
      { type: 'START', now: 0 },
    )
    const s = run(mid, { type: 'RESET' })
    expect(s.phase).toBe('idle')
    expect(s.remainingMs).toBe(50 * MIN)
    expect(s.completedRounds).toBe(0)
    expect(s.endsAt).toBeNull()
    expect(s.config.focusMin).toBe(50)
  })
})

describe('SET_CONFIG', () => {
  it('idle 下修改 focusMin 立即反映到剩余时间', () => {
    const s = withConfig({ focusMin: 50 })
    expect(s.config.focusMin).toBe(50)
    expect(s.remainingMs).toBe(50 * MIN)
  })

  it('运行中修改配置被拒绝', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    const s = run(started, { type: 'SET_CONFIG', patch: { focusMin: 50 } })
    expect(s.config).toEqual(DEFAULT_CONFIG)
    expect(s).toEqual(started)
  })

  it('暂停下修改配置：配置生效但冻结的剩余时间不变', () => {
    const paused = run(
      createInitialState(),
      { type: 'START', now: 0 },
      { type: 'PAUSE', now: 30_000 },
    )
    const s = run(paused, { type: 'SET_CONFIG', patch: { shortBreakMin: 10 } })
    expect(s.config.shortBreakMin).toBe(10)
    expect(s.remainingMs).toBe(25 * MIN - 30_000)
  })

  it('各字段按范围钳制：越界取上/下限', () => {
    const s = withConfig({
      focusMin: 999,
      shortBreakMin: 0,
      longBreakMin: -5,
      roundsBeforeLongBreak: 100,
    })
    expect(s.config.focusMin).toBe(CONFIG_LIMITS.focusMin.max)
    expect(s.config.shortBreakMin).toBe(CONFIG_LIMITS.shortBreakMin.min)
    expect(s.config.longBreakMin).toBe(CONFIG_LIMITS.longBreakMin.min)
    expect(s.config.roundsBeforeLongBreak).toBe(CONFIG_LIMITS.roundsBeforeLongBreak.max)
  })

  it('roundsBeforeLongBreak 低于下限时取下限 2', () => {
    const s = withConfig({ roundsBeforeLongBreak: 1 })
    expect(s.config.roundsBeforeLongBreak).toBe(CONFIG_LIMITS.roundsBeforeLongBreak.min)
  })
})

describe('PHASE_COMPLETE 事件', () => {
  it('未运行时派发为 no-op', () => {
    expect(run(createInitialState(), { type: 'PHASE_COMPLETE' })).toEqual(createInitialState())
  })

  it('运行中派发：与自然到 0 同语义（计轮并切换到下一阶段就绪态）', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    const s = run(started, { type: 'PHASE_COMPLETE' })
    expect(s.phase).toBe('shortBreak')
    expect(s.completedRounds).toBe(1)
    expect(s.endsAt).toBeNull()
  })
})

describe('justCompleted 标记（供 UI 区分自然完成与跳过）', () => {
  it('初始为 false', () => {
    expect(createInitialState().justCompleted).toBe(false)
  })

  it('阶段自然到 0 时为 true', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    expect(run(started, { type: 'TICK', now: 25 * MIN }).justCompleted).toBe(true)
  })

  it('SKIP 为 false（跳过不响铃）', () => {
    const started = run(createInitialState(), { type: 'START', now: 0 })
    expect(run(started, { type: 'SKIP' }).justCompleted).toBe(false)
  })

  it('自然完成后的任意后续转移（START/RESET/TICK）将其清除', () => {
    const completed = run(
      createInitialState(),
      { type: 'START', now: 0 },
      { type: 'TICK', now: 25 * MIN },
    )
    expect(run(completed, { type: 'START', now: 100 }).justCompleted).toBe(false)
    expect(run(completed, { type: 'RESET' }).justCompleted).toBe(false)
    const breakStarted = run(completed, { type: 'START', now: 0 })
    expect(run(breakStarted, { type: 'TICK', now: 1000 }).justCompleted).toBe(false)
  })
})

describe('自定义配置下的完整循环', () => {
  it('roundsBeforeLongBreak=2：2 轮专注后进长休息', () => {
    let s = withConfig({ roundsBeforeLongBreak: 2 })
    s = run(s, { type: 'START', now: 0 }, { type: 'TICK', now: 25 * MIN })
    expect(s.phase).toBe('shortBreak')
    s = run(s, { type: 'START', now: 0 }, { type: 'TICK', now: 5 * MIN })
    s = run(s, { type: 'START', now: 0 }, { type: 'TICK', now: 25 * MIN })
    expect(s.phase).toBe('longBreak')
    expect(s.completedRounds).toBe(2)
  })
})
