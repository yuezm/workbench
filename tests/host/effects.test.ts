// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Fact } from '../../src/kernel/types'
import { createEffects, type EffectsScheduler } from '../../src/host/effects'

const AT = '2026-01-01T00:00:00.000Z'

const factOf = <P>(type: Fact['type'], payload: P, seq = 1): Fact =>
  ({ type, actor: { kind: 'host', via: 'scheduler' }, at: AT, seq, payload }) as Fact

const queued = (runId: string, seq = 1): Fact => factOf('run.queued', { run: { id: runId } }, seq)

const cancelRequested = (runId: string, seq = 1): Fact =>
  factOf('run.cancel_requested', { run: { id: runId }, by: 'owner' }, seq)

const taskCreated = (taskId: string, seq = 1): Fact =>
  factOf('task.created', { task: { id: taskId } }, seq)

const cardOpened = (cardId: string, version = 1, seq = 1): Fact =>
  factOf('card.opened', { card: { id: cardId, version, status: 'open', delivery: 'pending' } }, seq)

const cardAnswered = (cardId: string, seq = 1): Fact =>
  factOf('card.answered', { card: { id: cardId, version: 1, status: 'answered' }, by: 'ui' }, seq)

function fakeScheduler(): EffectsScheduler & {
  wake: ReturnType<typeof vi.fn<() => void>>
  cancel: ReturnType<typeof vi.fn<(runId: string) => void>>
} {
  return { wake: vi.fn<() => void>(), cancel: vi.fn<(runId: string) => void>() }
}

describe('createEffects：事实分发', () => {
  it('run.queued → 唤醒调度器；每轮提交只通知一次', () => {
    const scheduler = fakeScheduler()
    const notifyChanged = vi.fn()
    const onFacts = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => scheduler,
      notifyChanged,
      onFacts,
    })

    effects.afterCommit([queued('run-1'), queued('run-2', 2)])

    expect(scheduler.wake).toHaveBeenCalledTimes(2)
    expect(scheduler.cancel).not.toHaveBeenCalled()
    expect(notifyChanged).toHaveBeenCalledTimes(1)
    expect(onFacts).toHaveBeenCalledTimes(1)
  })

  it('run.cancel_requested → 取消对应 run，不唤醒调度器', () => {
    const scheduler = fakeScheduler()
    const notifyChanged = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => scheduler,
      notifyChanged,
    })

    effects.afterCommit([cancelRequested('run-9')])

    expect(scheduler.cancel).toHaveBeenCalledWith('run-9')
    expect(scheduler.wake).not.toHaveBeenCalled()
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('其余事实：不动调度器，只做变更通知', () => {
    const scheduler = fakeScheduler()
    const notifyChanged = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => scheduler,
      notifyChanged,
    })

    effects.afterCommit([taskCreated('t-1')])

    expect(scheduler.wake).not.toHaveBeenCalled()
    expect(scheduler.cancel).not.toHaveBeenCalled()
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('零事实：不分发、不通知', () => {
    const scheduler = fakeScheduler()
    const notifyChanged = vi.fn()
    const onFacts = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => scheduler,
      notifyChanged,
      onFacts,
    })

    effects.afterCommit([])

    expect(scheduler.wake).not.toHaveBeenCalled()
    expect(notifyChanged).not.toHaveBeenCalled()
    expect(onFacts).not.toHaveBeenCalled()
  })

  it('订阅者异常隔离：调度器抛错不影响通知与其它事实', () => {
    const scheduler = fakeScheduler()
    scheduler.wake.mockImplementation(() => {
      throw new Error('wake 炸了')
    })
    scheduler.cancel.mockImplementation(() => {
      throw new Error('cancel 炸了')
    })
    const notifyChanged = vi.fn()
    const onFacts = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => scheduler,
      notifyChanged,
      onFacts,
    })

    expect(() => effects.afterCommit([queued('run-1'), cancelRequested('run-2', 2)])).not.toThrow()

    // 一个订阅者抛错后，其余分发照常执行
    expect(scheduler.cancel).toHaveBeenCalledWith('run-2')
    expect(notifyChanged).toHaveBeenCalledTimes(1)
    expect(onFacts).toHaveBeenCalledTimes(1)
  })

  it('通知 / 观察钩子抛错也不外溢', () => {
    const scheduler = fakeScheduler()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => scheduler,
      notifyChanged: () => {
        throw new Error('窗口已销毁')
      },
      onFacts: () => {
        throw new Error('观察者炸了')
      },
    })

    expect(() => effects.afterCommit([taskCreated('t-1')])).not.toThrow()
  })

  it('调度器惰性解析：effects 先建、scheduler 后装配也能分发', () => {
    const box: { current?: EffectsScheduler } = {}
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => {
        if (!box.current) throw new Error('调度器尚未装配')
        return box.current
      },
    })

    // 装配前：getter 抛错被隔离，不阻断提交
    expect(() => effects.afterCommit([queued('run-1')])).not.toThrow()

    const late = fakeScheduler()
    box.current = late
    effects.afterCommit([queued('run-2', 2)])
    expect(late.wake).toHaveBeenCalledTimes(1)
  })
})

describe('createEffects：卡片投递交给通道 hub（M4）', () => {
  it('card.opened / card.updated → 调 channels().dispatch（整批事实），不再另外拆分', () => {
    const scheduler = fakeScheduler()
    const channelDispatch = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => scheduler,
      channels: () => ({ dispatch: channelDispatch }),
    })
    const facts = [cardOpened('card-1', 1, 1), cardOpened('card-2', 1, 2)]

    effects.afterCommit(facts)

    expect(channelDispatch).toHaveBeenCalledTimes(1)
    expect(channelDispatch).toHaveBeenCalledWith(facts)
    expect(scheduler.wake).not.toHaveBeenCalled()
  })

  it('非卡片事实 / 零事实都不调通道 hub', () => {
    const channelDispatch = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      channels: () => ({ dispatch: channelDispatch }),
    })

    effects.afterCommit([taskCreated('t-1'), cardAnswered('card-1', 2)])
    effects.afterCommit([])

    expect(channelDispatch).not.toHaveBeenCalled()
  })

  it('通道 hub 未装配 / 分发抛错：异常隔离，写路径与其它分发不受影响', () => {
    const notifyChanged = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      channels: () => {
        throw new Error('hub 尚未装配')
      },
      notifyChanged,
    })

    expect(() => effects.afterCommit([cardOpened('card-1')])).not.toThrow()
    expect(notifyChanged).toHaveBeenCalledTimes(1)

    const throwing = vi.fn(() => {
      throw new Error('通道分发炸了')
    })
    const second = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      channels: () => ({ dispatch: throwing }),
      notifyChanged,
    })
    expect(() => second.afterCommit([cardOpened('card-1')])).not.toThrow()
    expect(notifyChanged).toHaveBeenCalledTimes(2)
  })

  it('通道 hub 惰性解析：effects 先建、hub 后装配也能分发', () => {
    const box: { current?: { dispatch: (facts: readonly Fact[]) => void } } = {}
    const channelDispatch = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      channels: () => {
        if (!box.current) throw new Error('hub 尚未装配')
        return box.current
      },
    })

    // 装配前：getter 抛错被隔离
    expect(() => effects.afterCommit([cardOpened('card-1')])).not.toThrow()

    box.current = { dispatch: channelDispatch }
    effects.afterCommit([cardOpened('card-2', 1, 2)])
    expect(channelDispatch).toHaveBeenCalledTimes(1)
  })
})

describe('createEffects：结局通知（M12）', () => {
  it('每批事实交给 announce 一次；零事实不调用', () => {
    const announce = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      announce,
    })

    const facts = [taskCreated('t-1'), cardOpened('card-1', 1, 2)]
    effects.afterCommit(facts)
    effects.afterCommit([])

    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith(facts)
  })

  it('announce 抛错被隔离：变更广播与写路径照常', () => {
    const notifyChanged = vi.fn()
    const effects = createEffects({
      store: { dispatch: () => ({ facts: [taskCreated('t-1')] }) },
      scheduler: () => fakeScheduler(),
      announce: () => {
        throw new Error('通知服务不可用')
      },
      notifyChanged,
    })

    expect(() => effects.dispatch({ type: 'task.create' })).not.toThrow()
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })
})

describe('createEffects：结局通知的装配与异常隔离（M12）', () => {
  it('announce 收到整批事实（完成 / 失败由装配根翻译成系统通知）', () => {
    const announce = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      announce,
    })
    const facts = [taskCreated('t-1', 1)]

    effects.afterCommit(facts)

    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith(facts)
  })

  it('announce 未装配：提交照常，不抛', () => {
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
    })
    expect(() => effects.afterCommit([taskCreated('t-1')])).not.toThrow()
  })

  it('announce 抛错：异常被隔离，卡片投递与变更广播照常执行', () => {
    const channelDispatch = vi.fn()
    const notifyChanged = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      channels: () => ({ dispatch: channelDispatch }),
      announce: () => {
        throw new Error('通知服务不可用')
      },
      notifyChanged,
    })

    expect(() => effects.afterCommit([cardOpened('card-1')])).not.toThrow()
    expect(channelDispatch).toHaveBeenCalledTimes(1)
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('零事实：不调 announce（没有要播报的事）', () => {
    const announce = vi.fn()
    const effects = createEffects({
      store: { dispatch: vi.fn() },
      scheduler: () => fakeScheduler(),
      announce,
    })
    effects.afterCommit([])
    expect(announce).not.toHaveBeenCalled()
  })
})

describe('createEffects：统一写入口', () => {
  it('dispatch：写库成功后 afterCommit，返回原结果', () => {
    const scheduler = fakeScheduler()
    const result = { facts: [queued('run-1')] }
    const store = { dispatch: vi.fn(() => result) }
    const notifyChanged = vi.fn()
    const effects = createEffects({ store, scheduler: () => scheduler, notifyChanged })

    expect(effects.dispatch({ type: 'task.create' })).toBe(result)
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'task.create' })
    expect(scheduler.wake).toHaveBeenCalledTimes(1)
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('dispatch：写库失败直接抛出，不分发、不通知', () => {
    const scheduler = fakeScheduler()
    const notifyChanged = vi.fn()
    const store = {
      dispatch: () => {
        throw new Error('invalid_input')
      },
    }
    const effects = createEffects({ store, scheduler: () => scheduler, notifyChanged })

    expect(() => effects.dispatch({ type: 'nope' })).toThrow('invalid_input')
    expect(scheduler.wake).not.toHaveBeenCalled()
    expect(notifyChanged).not.toHaveBeenCalled()
  })

  it('dispatch：零事实（决策无产出）不通知', () => {
    const scheduler = fakeScheduler()
    const notifyChanged = vi.fn()
    const effects = createEffects({
      store: { dispatch: () => ({ facts: [] }) },
      scheduler: () => scheduler,
      notifyChanged,
    })

    expect(effects.dispatch({ type: 'clock.tick' })).toEqual({ facts: [] })
    expect(notifyChanged).not.toHaveBeenCalled()
  })
})
