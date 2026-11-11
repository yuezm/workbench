/**
 * shell 级落点 store（M27）：系统通知点击 → 切 app → 进任务 / 会话 → 定位卡片。
 *
 * 这里只测 store 本身（序号、订阅、清空、测试重置）；「谁消费它」由 Workbench 与
 * AiWorkflowPage 的用例覆盖。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { OpenTarget } from '../../../../src/protocol/ipc'
import {
  clearOpenTarget,
  pushOpenTarget,
  resetOpenTargetForTest,
  selectApp,
  subscribeOpenTarget,
  useActiveAppId,
  useOpenTarget,
  type PendingOpenTarget,
} from '../../../../src/renderer/src/shell/openTarget'

const taskTarget: OpenTarget = { appId: 'ai-workflow', taskId: 't1', cardId: 'card-1' }

beforeEach(() => {
  resetOpenTargetForTest()
})

describe('openTarget store', () => {
  it('push 单调递增 seq：同内容连点两次也不能被当成一次', () => {
    const { result } = renderHook(() => useOpenTarget())
    act(() => pushOpenTarget(taskTarget))
    const first = result.current
    act(() => pushOpenTarget(taskTarget))
    const second = result.current

    expect(first?.seq).toBe(1)
    expect(second?.seq).toBe(2)
    // 内容完全相同，只有 seq 能区分「这是新的一次点击」
    expect(second).toMatchObject(taskTarget)
  })

  it('订阅者收到新落点，退订后不再收到', () => {
    const { result, unmount } = renderHook(() => useOpenTarget())
    expect(result.current).toBeNull()

    act(() => pushOpenTarget(taskTarget))
    expect(result.current).toMatchObject({ taskId: 't1', cardId: 'card-1', seq: 1 })

    unmount()
    // 退订之后再推：没有组件在听，不该抛错（这就是 shell 里清空 / 推送的常态）
    act(() => pushOpenTarget({ appId: 'pomodoro' }))
    expect(result.current?.appId).toBe('ai-workflow')
  })

  it('clear 清空并通知订阅者：落点是一次性的，不留在 store 里重放', () => {
    const { result } = renderHook(() => useOpenTarget())
    act(() => pushOpenTarget(taskTarget))
    expect(result.current).not.toBeNull()

    act(() => clearOpenTarget())
    expect(result.current).toBeNull()
  })

  it('没有落点时 clear 是空操作（重复消费不重复通知）', () => {
    let notifications = 0
    const { result } = renderHook(() => {
      notifications += 1
      return useOpenTarget()
    })
    const before = notifications

    act(() => clearOpenTarget())
    expect(notifications).toBe(before)
    expect(result.current).toBeNull()
  })

  it('reset：落点与序号一起归零，订阅者一并清掉（用例之间不串味）', () => {
    const { result } = renderHook(() => useOpenTarget())
    act(() => pushOpenTarget(taskTarget))
    expect(result.current?.seq).toBe(1)

    resetOpenTargetForTest()
    act(() => pushOpenTarget({ appId: 'pomodoro' }))
    // 序号从头数：新用例里第一条落点就是 1
    const fresh = renderHook(() => useOpenTarget()).result.current
    expect(fresh).toMatchObject({ appId: 'pomodoro', seq: 1 })
    // 旧订阅者在 reset 时被丢掉：不再被新的落点唤醒（界面已卸载，无从更新）
    expect(result.current?.appId).toBe('ai-workflow')
  })
})

/**
 * 当前 app 与落点同住在 shell 导航 store：切 app 是落点的第一跳，两者必须一笔写入，
 * 否则「先切过去、落点被消费后又弹回原 app」。
 */
describe('openTarget：当前 app', () => {
  it('落点进来就切 app（第一跳），清空落点不回弹', () => {
    const { result } = renderHook(() => useActiveAppId())
    expect(result.current).toBeNull()

    act(() => pushOpenTarget(taskTarget))
    expect(result.current).toBe('ai-workflow')

    act(() => clearOpenTarget())
    expect(result.current).toBe('ai-workflow')
  })

  it('顶部栏点选（selectApp）切 app；同一个 app 重复点不惊动订阅者', () => {
    const { result } = renderHook(() => useActiveAppId())

    act(() => selectApp('pomodoro'))
    expect(result.current).toBe('pomodoro')

    // 重复点当前 app：同一笔状态，不发通知（避免一次无意义的重渲染）
    let renders = 0
    const { result: counter } = renderHook(() => {
      renders += 1
      return useActiveAppId()
    })
    const before = renders
    act(() => selectApp('pomodoro'))
    expect(counter.current).toBe('pomodoro')
    expect(renders).toBe(before)
  })

  it('reset 一并清掉当前 app：下个用例从「没选过」开始', () => {
    const { result } = renderHook(() => useActiveAppId())
    act(() => selectApp('pomodoro'))
    expect(result.current).toBe('pomodoro')

    resetOpenTargetForTest()
    expect(renderHook(() => useActiveAppId()).result.current).toBeNull()
  })
})

/**
 * 订阅（app 侧消费落点）：订阅瞬间先重放还没被消费的落点——系统通知可能先于 app 挂载到达。
 */
describe('openTarget：订阅', () => {
  it('订阅时重放当前落点，之后每次变化都收到', () => {
    const seen: Array<PendingOpenTarget | null> = []
    pushOpenTarget(taskTarget)

    const unsubscribe = subscribeOpenTarget((target) => seen.push(target))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ appId: 'ai-workflow', taskId: 't1', seq: 1 })

    act(() => pushOpenTarget({ appId: 'ai-workflow', conversationId: 'c1' }))
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ conversationId: 'c1', seq: 2 })

    clearOpenTarget()
    expect(seen).toHaveLength(3)
    expect(seen[2]).toBeNull()

    // 退订后不再收到
    unsubscribe()
    act(() => pushOpenTarget(taskTarget))
    expect(seen).toHaveLength(3)
  })

  it('没有待打开落点时订阅：先收到一次 null（消费方不必自己补一次判空）', () => {
    const seen: Array<PendingOpenTarget | null> = []
    const unsubscribe = subscribeOpenTarget((target) => seen.push(target))
    expect(seen).toEqual([null])
    unsubscribe()
  })
})
