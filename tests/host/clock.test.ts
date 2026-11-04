// @vitest-environment node
/**
 * host/clock 黄金用例（T8）：唯一 setTimeout 的排期 / 提前唤醒 / 停止 / 诊断，
 * 以及「tick 零事实也回调 onTick」与 store.nextWakeAt 的真实装配。
 * 定时器与当前时刻都用假时钟推进，不依赖真实时间。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunRow } from '../../src/protocol/entities'
import { createClock, type ClockStore, type ClockTimer } from '../../src/host/clock'
import { createStore, type Store } from '../../src/host/store'
import { createProjectionWriter } from '../../src/host/store/projection-apply'
import { decide } from '../../src/kernel/decide'
import { nextWakeAt } from '../../src/kernel/next-wake'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import { SAMPLE_AT, createMemoryDb, sample } from './store/test-support'

const NOW = '2026-11-04T12:00:00.000Z'

/** 假定时器：可推进的单调时钟 + 手工 setTimeout 队列。 */
class FakeTimer implements ClockTimer {
  private current: number
  private seq = 0
  private readonly tasks = new Map<number, { at: number; run: () => void }>()

  constructor(startIso: string) {
    this.current = Date.parse(startIso)
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.seq += 1
    this.tasks.set(this.seq, { at: this.current + delayMs, run: callback })
    return this.seq
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  nowIso(): string {
    return new Date(this.current).toISOString()
  }

  pending(): number[] {
    return [...this.tasks.values()].map((task) => task.at)
  }

  /** 推进到 target：按到期顺序逐个执行回调（回调里新排的任务也在本次推进内生效）。 */
  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      let dueId: number | null = null
      let dueAt = Number.POSITIVE_INFINITY
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < dueAt) {
          dueAt = task.at
          dueId = id
        }
      }
      if (dueId === null) break
      const task = this.tasks.get(dueId)
      if (!task) break
      this.tasks.delete(dueId)
      this.current = task.at
      task.run()
    }
    this.current = target
  }
}

/** 假 store：只实现 clock 需要的 dispatch / nextWakeAt。 */
function fakeStore(initial: string | null): {
  store: ClockStore
  dispatched: unknown[]
  setNext: (at: string | null) => void
} {
  let next = initial
  const dispatched: unknown[] = []
  return {
    dispatched,
    setNext: (at) => {
      next = at
    },
    store: {
      dispatch: (input) => {
        dispatched.push(input)
        return { facts: [] }
      },
      nextWakeAt: () => next,
    },
  }
}

let openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
  vi.useRealTimers()
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

/** 真实 store + 真实 kernel；`now` 跟随假时钟，tick 判定才与推进后的时间一致。 */
function realStore(db: DatabaseSync, timer: FakeTimer): Store {
  return createStore({
    db,
    kernel: { decide, project, viewSpec, nextWakeAt },
    now: () => timer.nowIso(),
  })
}

function seedRuns(db: DatabaseSync, runs: RunRow[]): void {
  const writer = createProjectionWriter(db)
  for (const row of runs) writer.apply({ table: 'runs', key: row.id, row }, SAMPLE_AT)
}

describe('host/clock 排期与唤醒', () => {
  it('start 按 nextWakeAt 排期；到点精确触发一次 tick 并重排', () => {
    const timer = new FakeTimer(NOW)
    const fake = fakeStore('2026-11-04T12:01:00.000Z')
    let ticks = 0
    const clock = createClock({
      store: fake.store,
      now: () => timer.nowIso(),
      onTick: () => {
        ticks += 1
      },
      timer,
    })

    clock.start()
    expect(clock.nextAt()).toBe('2026-11-04T12:01:00.000Z')
    expect(timer.pending()).toEqual([Date.parse('2026-11-04T12:01:00.000Z')])

    timer.advance(59_999)
    expect(fake.dispatched).toEqual([])

    // 下一跳在 tick 之前更新，验证「tick 后重排」用的是最新视图
    fake.setNext('2026-11-04T12:03:00.000Z')
    timer.advance(1)
    expect(fake.dispatched).toEqual([{ type: 'clock.tick' }])
    expect(ticks).toBe(1)
    expect(clock.nextAt()).toBe('2026-11-04T12:03:00.000Z')
    expect(timer.pending()).toEqual([Date.parse('2026-11-04T12:03:00.000Z')])
  })

  it('无到期时刻：不挂定时器、不空转', () => {
    const timer = new FakeTimer(NOW)
    const fake = fakeStore(null)
    let ticks = 0
    const clock = createClock({
      store: fake.store,
      now: () => timer.nowIso(),
      onTick: () => {
        ticks += 1
      },
      timer,
    })

    clock.start()
    expect(clock.nextAt()).toBeNull()
    expect(timer.pending()).toEqual([])

    timer.advance(3_600_000)
    expect(fake.dispatched).toEqual([])
    expect(ticks).toBe(0)
  })

  it('wake 提前触发一次 tick 并取消旧排期、按最新视图重排', () => {
    const timer = new FakeTimer(NOW)
    const fake = fakeStore('2026-11-04T12:01:00.000Z')
    let ticks = 0
    const clock = createClock({
      store: fake.store,
      now: () => timer.nowIso(),
      onTick: () => {
        ticks += 1
      },
      timer,
    })

    clock.start()
    fake.setNext('2026-11-04T12:03:00.000Z')
    clock.wake()

    expect(fake.dispatched).toEqual([{ type: 'clock.tick' }])
    expect(ticks).toBe(1)
    expect(clock.nextAt()).toBe('2026-11-04T12:03:00.000Z')
    expect(timer.pending()).toEqual([Date.parse('2026-11-04T12:03:00.000Z')])

    // 旧排期（12:01）已被取消：推进到 12:01 不再触发
    timer.advance(60_000)
    expect(fake.dispatched).toHaveLength(1)

    // 到 12:03 触发第二次；此后无到期，避免同一时刻反复排期
    fake.setNext(null)
    timer.advance(120_000)
    expect(fake.dispatched).toHaveLength(2)
    expect(ticks).toBe(2)
    expect(clock.nextAt()).toBeNull()
  })

  it('stop 取消定时器，之后不再触发', () => {
    const timer = new FakeTimer(NOW)
    const fake = fakeStore('2026-11-04T12:01:00.000Z')
    let ticks = 0
    const clock = createClock({
      store: fake.store,
      now: () => timer.nowIso(),
      onTick: () => {
        ticks += 1
      },
      timer,
    })

    clock.start()
    clock.stop()

    expect(clock.nextAt()).toBeNull()
    expect(timer.pending()).toEqual([])
    timer.advance(3_600_000)
    expect(fake.dispatched).toEqual([])
    expect(ticks).toBe(0)
  })

  it('默认系统定时器：start 前 wake 只 tick 不排期；start 到点 tick；stop 取消', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    const fake = fakeStore('2026-11-04T12:01:00.000Z')
    let ticks = 0
    // 不注入 timer：走默认 systemTimer（真实 setTimeout/clearTimeout，由 vi 假时钟接管）
    const clock = createClock({
      store: fake.store,
      now: () => new Date().toISOString(),
      onTick: () => {
        ticks += 1
      },
    })

    // start 前：wake 立即 tick，但不排期（schedule 的 !started 分支）
    clock.wake()
    expect(fake.dispatched).toHaveLength(1)
    expect(clock.nextAt()).toBeNull()

    clock.start()
    expect(clock.nextAt()).toBe('2026-11-04T12:01:00.000Z')
    // 定时器还挂着时 stop：走默认 clearTimeout 分支
    clock.stop()
    expect(clock.nextAt()).toBeNull()

    clock.start()
    vi.advanceTimersByTime(59_999)
    expect(fake.dispatched).toHaveLength(1)

    // 下一跳置空，避免到点后同一时刻反复排期
    fake.setNext(null)
    vi.advanceTimersByTime(1)
    expect(fake.dispatched).toHaveLength(2)
    expect(ticks).toBe(2)
    expect(clock.nextAt()).toBeNull()

    clock.stop()
    expect(clock.nextAt()).toBeNull()
  })
})

describe('host/clock 与 store / kernel 装配', () => {
  it('store.nextWakeAt 用 clock.tick 切片装载 runs；kernel 未注入时返回 null', () => {
    const timer = new FakeTimer(NOW)
    const db = memory()
    seedRuns(db, [
      sample.run({
        id: 'run-1',
        taskId: null,
        stageId: null,
        agentId: null,
        runtimeId: null,
        status: 'running',
        attempt: 1,
        leaseId: 'run-1:1',
        leaseUntil: '2026-11-04T12:01:00.000Z',
        deadlineAt: '2026-11-04T12:30:00.000Z',
      }),
    ])
    const store = realStore(db, timer)

    expect(store.nextWakeAt(NOW)).toBe('2026-11-04T12:01:00.000Z')

    const bare = createStore({
      db: memory(),
      kernel: { decide, project, viewSpec },
      now: () => NOW,
    })
    expect(bare.nextWakeAt(NOW)).toBeNull()
  })

  it('租约到期：到点 tick 产 run.abandoned，onTick 仍被调用', () => {
    const timer = new FakeTimer(NOW)
    const db = memory()
    seedRuns(db, [
      sample.run({
        id: 'run-1',
        taskId: null,
        stageId: null,
        agentId: null,
        runtimeId: null,
        status: 'running',
        attempt: 1,
        leaseId: 'run-1:1',
        leaseUntil: '2026-11-04T12:01:00.000Z',
        deadlineAt: '2026-11-04T12:30:00.000Z',
      }),
    ])
    const store = realStore(db, timer)
    let ticks = 0
    const clock = createClock({
      store,
      now: () => timer.nowIso(),
      onTick: () => {
        ticks += 1
      },
      timer,
    })

    clock.start()
    timer.advance(60_000)

    expect(ticks).toBe(1)
    expect(store.factsSince(0).map((fact) => fact.type)).toEqual(['run.abandoned'])
    expect(clock.nextAt()).toBe('2026-11-04T12:06:00.000Z')
  })

  it('tick 产零事实（退避到期的 queued run）仍然回调 onTick', () => {
    const timer = new FakeTimer(NOW)
    const db = memory()
    seedRuns(db, [
      sample.run({
        id: 'run-1',
        taskId: null,
        stageId: null,
        agentId: null,
        runtimeId: null,
        status: 'queued',
        notBefore: '2026-11-04T12:01:00.000Z',
      }),
    ])
    const store = realStore(db, timer)
    let ticks = 0
    const clock = createClock({
      store,
      now: () => timer.nowIso(),
      onTick: () => {
        ticks += 1
      },
      timer,
    })

    expect(store.nextWakeAt(NOW)).toBe('2026-11-04T12:01:00.000Z')
    clock.start()
    timer.advance(60_000)

    // clock.tick 对 queued run 不产事实，但调度器必须被唤醒去领取
    expect(store.factsSince(0)).toEqual([])
    expect(ticks).toBe(1)
    expect(clock.nextAt()).toBeNull()
  })
})
