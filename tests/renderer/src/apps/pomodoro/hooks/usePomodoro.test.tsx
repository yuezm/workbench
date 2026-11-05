import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RingPlayer } from '../../../../../../src/renderer/src/apps/pomodoro/audio'
import { usePomodoro } from '../../../../../../src/renderer/src/apps/pomodoro/hooks/usePomodoro'
import { installFakeKernel, stopFakeKernel } from '../../../../shell/fake-kernel'

const MIN = 60_000

function setup() {
  const ring: RingPlayer = { play: vi.fn() }
  const notify = vi.fn()
  vi.stubGlobal('workbench', { notify })
  const kernel = installFakeKernel()
  const { result } = renderHook(() => usePomodoro({ ring }))
  return { ring, notify, result, kernel }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  stopFakeKernel()
})

describe('usePomodoro', () => {
  it('初始：idle、剩余 25 分钟', () => {
    const { result } = setup()
    expect(result.current.state.phase).toBe('idle')
    expect(result.current.state.remainingMs).toBe(25 * MIN)
  })

  it('start 后随真实时钟递减（interval 驱动 TICK）', () => {
    const { result } = setup()
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(result.current.state.phase).toBe('focus')
    expect(result.current.state.remainingMs).toBe(25 * MIN - 5_000)
  })

  it('pause 冻结剩余时间，start 从冻结点恢复', () => {
    const { result } = setup()
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    act(() => {
      result.current.pause()
    })
    const frozen = result.current.state.remainingMs
    expect(frozen).toBe(25 * MIN - 10_000)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(result.current.state.remainingMs).toBe(frozen)

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    act(() => {
      result.current.start()
    })
    expect(result.current.state.endsAt).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(result.current.state.remainingMs).toBe(frozen - 2_000)
  })

  it('专注自然到 0：响铃一次 + 系统通知含下一阶段名，进入短休息就绪态，并发一条 app 事件', () => {
    const { result, ring, notify, kernel } = setup()
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(25 * MIN)
    })
    expect(result.current.state.phase).toBe('shortBreak')
    expect(result.current.state.completedRounds).toBe(1)
    expect(ring.play).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('番茄时钟', expect.stringContaining('短休息'))
    expect(kernel.dispatched).toEqual([
      expect.objectContaining({
        type: 'app.event',
        appId: 'pomodoro',
        eventType: 'pomodoro.completed',
        subject: '番茄完成',
      }),
    ])
  })

  it('短休息自然结束同样发 app 事件（一轮回专注）', () => {
    const { result, kernel } = setup()
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(25 * MIN)
    })
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(5 * MIN)
    })
    expect(result.current.state.phase).toBe('focus')
    expect(result.current.state.completedRounds).toBe(1)
    expect(kernel.dispatched.map((command) => command.type)).toEqual(['app.event', 'app.event'])
  })

  it('app 事件入账失败：响铃与通知照常，本地状态不受影响', async () => {
    const { result, ring, notify, kernel } = setup()
    kernel.onDispatch(() => Promise.reject(new Error('桥接故障')))
    act(() => {
      result.current.start()
    })
    await act(async () => {
      vi.advanceTimersByTime(25 * MIN)
      await Promise.resolve()
    })
    expect(result.current.state.phase).toBe('shortBreak')
    expect(ring.play).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(kernel.dispatched.map((command) => command.type)).toEqual(['app.event'])
  })

  it('justCompleted 在后续转移中被清除：响铃不会重复', () => {
    const { result, ring, kernel } = setup()
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(25 * MIN)
    })
    expect(ring.play).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(ring.play).toHaveBeenCalledTimes(1)
    expect(kernel.dispatched).toHaveLength(1)
  })

  it('skip：切阶段但不响铃不通知、不发事件', () => {
    const { result, ring, notify, kernel } = setup()
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    act(() => {
      result.current.skip()
    })
    expect(result.current.state.phase).toBe('shortBreak')
    expect(ring.play).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('reset 回到 idle 且轮数清零', () => {
    const { result } = setup()
    act(() => {
      result.current.start()
    })
    act(() => {
      vi.advanceTimersByTime(25 * MIN)
    })
    act(() => {
      result.current.reset()
    })
    expect(result.current.state.phase).toBe('idle')
    expect(result.current.state.completedRounds).toBe(0)
    expect(result.current.state.remainingMs).toBe(25 * MIN)
  })

  it('setConfig 在 idle 下生效并重算剩余时间', () => {
    const { result } = setup()
    act(() => {
      result.current.setConfig({ focusMin: 50 })
    })
    expect(result.current.state.config.focusMin).toBe(50)
    expect(result.current.state.remainingMs).toBe(50 * MIN)
  })
})
