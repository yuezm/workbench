// @vitest-environment node
/**
 * 通道宿主 hub（M4 T7）：启停、按 registry 顺序分发、异常/超时隔离、投递回写、
 * 启动补投与回答入口。全部用假通道/假 store/假 effects，不涉及真实通道与数据库。
 *
 * **投递语义（lead 拍板）**：向所有已启动通道各投一次（registry 顺序），首个 ack 写
 * 一条 `card.delivered`（只一次），其余 ack 静默丢弃；全部失败才写
 * `card.delivery_failed`。同一 `(cardId, version)` 进程内只跑一轮。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/protocol/entities'
import type { ChannelContext, ChannelPlugin } from '../../src/protocol/channels'
import type { PluginManifest } from '../../src/protocol/manifest'
import type { Fact } from '../../src/kernel/types'
import type { ChannelRegistryEntry } from '../../src/plugins/registry'
import type { SdkHost } from '../../src/sdk/types'
import type { ChannelsEffects, ChannelsStore } from '../../src/host/channels'
import { createChannels } from '../../src/host/channels'
import { sample } from './store/test-support'

const AT = '2026-01-01T00:00:00.000Z'

const MANIFEST = (id: string): PluginManifest => ({
  id,
  kind: 'channel',
  name: id,
  version: '1.0.0',
  capabilities: [],
})

const fakeSdkHost: SdkHost = {
  log: vi.fn(),
  now: () => Date.parse(AT),
  paths: { sessionRoot: null },
  config: <T = Record<string, unknown>>() => ({}) as T,
  process: {
    spawn: () => {
      throw new Error('通道不启动子进程')
    },
    resolve: (command) => ({ path: null, error: `通道不解析命令：${command}` }),
    killTree: () => false,
    scanDirs: () => [],
    findInDirs: () => null,
  },
}

const cardOpened = (card: Card): Fact =>
  ({
    type: 'card.opened',
    actor: { kind: 'host', via: 'scheduler' },
    at: AT,
    seq: 1,
    payload: { card },
  }) as Fact

const cardUpdated = (card: Card): Fact =>
  ({
    type: 'card.updated',
    actor: { kind: 'host', via: 'scheduler' },
    at: AT,
    seq: 1,
    payload: { card },
  }) as Fact

/** 断言用：从 effects.dispatch 的调用里取输入（按顺序）。 */
const dispatchInputs = (dispatch: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> =>
  dispatch.mock.calls.map(([input]) => input as Record<string, unknown>)

/** 一个假通道：在 onCard 里执行给定动作，返回 dispose 计数。 */
function fakeEntry(
  key: string,
  onCard?: (ctx: ChannelContext, card: Card) => void,
): ChannelRegistryEntry & { received: Card[]; disposed: number } {
  const received: Card[] = []
  const state = { disposed: 0 }
  const plugin: ChannelPlugin = {
    async start(ctx) {
      ctx.onCard((card) => {
        received.push(card)
        if (onCard) onCard(ctx, card)
      })
      return () => {
        state.disposed += 1
      }
    },
  }
  const entry = {
    key,
    label: key,
    manifest: MANIFEST(key),
    plugin,
    get received() {
      return received
    },
    get disposed() {
      return state.disposed
    },
  }
  return entry
}

/** 立即 ack 的通道（同步调用 delivered）。 */
const ackEntry = (key: string): ReturnType<typeof fakeEntry> =>
  fakeEntry(key, (ctx, card) => {
    void ctx.delivered(card.id, card.version, key)
  })

function harness(options: {
  entries: ChannelRegistryEntry[]
  cards?: Card[]
  timeoutMs?: number
}): {
  hub: ReturnType<typeof createChannels>
  store: ChannelsStore
  effects: ChannelsEffects
  dispatch: ReturnType<typeof vi.fn>
} {
  const store = {
    query: vi.fn((_view: string) => options.cards ?? []),
  } as unknown as ChannelsStore
  const dispatch = vi.fn(() => ({ facts: [] }))
  const effects = { dispatch } as unknown as ChannelsEffects
  const hub = createChannels({
    store,
    effects,
    entries: options.entries,
    sdkHost: fakeSdkHost,
    timeoutMs: options.timeoutMs ?? 20,
  })
  return { hub, store, effects, dispatch }
}

describe('createChannels：按 registry 顺序投递与回写', () => {
  it('多通道都收到 onCard：首个 ack 写一次 delivered，后续 ack 静默丢弃', async () => {
    const inApp = ackEntry('in-app')
    const desktop = ackEntry('desktop')
    const { hub, dispatch } = harness({ entries: [inApp, desktop] })
    await hub.startAll()

    const card = sample.card({ id: 'card-1', version: 1 })
    hub.dispatch([cardOpened(card)])

    await vi.waitFor(() => expect(desktop.received).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 两个通道都收到卡片；只有首个 ack 写事实，且没有 failed
    expect(inApp.received.map((item) => item.id)).toEqual(['card-1'])
    expect(desktop.received.map((item) => item.id)).toEqual(['card-1'])
    const inputs = dispatchInputs(dispatch)
    expect(inputs.filter((input) => input['type'] === 'card.delivered')).toEqual([
      { type: 'card.delivered', cardId: 'card-1', version: 1, ref: 'in-app' },
    ])
    expect(inputs.some((input) => input['type'] === 'card.delivery_failed')).toBe(false)
  })

  it('in-app 抛错时 desktop 成功仍记 delivered，且不写 failed', async () => {
    const broken = fakeEntry('in-app', () => {
      throw new Error('通道炸了')
    })
    const desktop = ackEntry('desktop')
    const { hub, dispatch } = harness({ entries: [broken, desktop] })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() => expect(desktop.received).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const inputs = dispatchInputs(dispatch)
    expect(inputs.filter((input) => input['type'] === 'card.delivered')).toEqual([
      { type: 'card.delivered', cardId: 'card-1', version: 1, ref: 'desktop' },
    ])
    expect(inputs.some((input) => input['type'] === 'card.delivery_failed')).toBe(false)
  })

  it('in-app 超时但 desktop 成功：仍记 delivered（ref=desktop），不写 failed', async () => {
    const silent = fakeEntry('in-app') // 不 ack，等超时
    const desktop = ackEntry('desktop')
    const { hub, dispatch } = harness({ entries: [silent, desktop], timeoutMs: 10 })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() => expect(desktop.received).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const inputs = dispatchInputs(dispatch)
    expect(inputs.filter((input) => input['type'] === 'card.delivered')).toEqual([
      { type: 'card.delivered', cardId: 'card-1', version: 1, ref: 'desktop' },
    ])
    expect(inputs.some((input) => input['type'] === 'card.delivery_failed')).toBe(false)
  })

  it('desktop 失败但 in-app 成功 → 无 failed 事实', async () => {
    const inApp = ackEntry('in-app')
    const desktopBroken = fakeEntry('desktop', () => {
      throw new Error('通知失败')
    })
    const { hub, dispatch } = harness({ entries: [inApp, desktopBroken] })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() => expect(desktopBroken.received).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const inputs = dispatchInputs(dispatch)
    expect(inputs.filter((input) => input['type'] === 'card.delivered')).toEqual([
      { type: 'card.delivered', cardId: 'card-1', version: 1, ref: 'in-app' },
    ])
    expect(inputs.some((input) => input['type'] === 'card.delivery_failed')).toBe(false)
  })

  it('通道抛错被隔离：后续通道仍收到并成功回写', async () => {
    const broken = fakeEntry('broken', () => {
      throw new Error('通道炸了')
    })
    const good = ackEntry('good')
    const { hub, dispatch } = harness({ entries: [broken, good] })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() =>
      expect(dispatchInputs(dispatch)).toContainEqual({
        type: 'card.delivered',
        cardId: 'card-1',
        version: 1,
        ref: 'good',
      }),
    )
  })

  it('超时的通道被跳过并继续下一个；全失败回 card.delivery_failed', async () => {
    const silent = fakeEntry('silent') // 不 ack，等超时
    const ack = ackEntry('ack')
    const { hub, dispatch } = harness({ entries: [silent, ack], timeoutMs: 10 })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() =>
      expect(dispatchInputs(dispatch)).toContainEqual({
        type: 'card.delivered',
        cardId: 'card-1',
        version: 1,
        ref: 'ack',
      }),
    )

    const { hub: failing, dispatch: failingDispatch } = harness({
      entries: [fakeEntry('silent-a'), fakeEntry('silent-b')],
      timeoutMs: 10,
    })
    await failing.startAll()
    failing.dispatch([cardOpened(sample.card({ id: 'card-2', version: 1 }))])

    await vi.waitFor(() =>
      expect(dispatchInputs(failingDispatch)).toContainEqual({
        type: 'card.delivery_failed',
        cardId: 'card-2',
        version: 1,
        error: '所有通道投递失败或超时',
      }),
    )
  })

  it('慢通道 500ms 不阻塞 dispatch（fire-and-forget），随后仍回写 delivered', async () => {
    const slow = fakeEntry('slow', (ctx, card) => {
      setTimeout(() => {
        void ctx.delivered(card.id, card.version, 'slow')
      }, 500)
    })
    const { hub, dispatch } = harness({ entries: [slow], timeoutMs: 1_000 })
    await hub.startAll()

    const startedAt = Date.now()
    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])
    expect(Date.now() - startedAt).toBeLessThan(100)

    await vi.waitFor(
      () =>
        expect(dispatchInputs(dispatch)).toContainEqual({
          type: 'card.delivered',
          cardId: 'card-1',
          version: 1,
          ref: 'slow',
        }),
      { timeout: 2_000 },
    )
  })

  it('同一 (cardId, version) 进程内不重复投递', async () => {
    const ack = ackEntry('ack')
    const { hub, dispatch } = harness({ entries: [ack] })
    await hub.startAll()
    const fact = cardOpened(sample.card({ id: 'card-1', version: 1 }))

    hub.dispatch([fact])
    await vi.waitFor(() => expect(ack.received).toHaveLength(1))
    hub.dispatch([fact])
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(ack.received).toHaveLength(1)
    expect(
      dispatchInputs(dispatch).filter(
        (input) => input['type'] === 'card.delivered' && input['cardId'] === 'card-1',
      ),
    ).toHaveLength(1)
  })

  it('card.updated 换版本后重新投递；非 open / 非 pending 卡忽略', async () => {
    const ack = ackEntry('ack')
    const { hub, dispatch } = harness({ entries: [ack] })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])
    await vi.waitFor(() => expect(ack.received).toHaveLength(1))
    hub.dispatch([cardUpdated(sample.card({ id: 'card-1', version: 2 }))])
    await vi.waitFor(() => expect(ack.received).toHaveLength(2))
    expect(ack.received.map((card) => card.version)).toEqual([1, 2])

    hub.dispatch([cardOpened(sample.card({ id: 'card-2', status: 'answered' }))])
    hub.dispatch([cardOpened(sample.card({ id: 'card-3', delivery: 'delivered' }))])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ack.received.map((card) => card.id)).toEqual(['card-1', 'card-1'])
    expect(
      dispatchInputs(dispatch).filter((input) => input['type'] === 'card.delivered'),
    ).toHaveLength(2)
  })

  it('startAll 补投：只投 open 且 delivery=pending 的卡', async () => {
    const ack = ackEntry('ack')
    const pending = sample.card({ id: 'card-pending', version: 1 })
    const delivered = sample.card({ id: 'card-delivered', version: 1, delivery: 'delivered' })
    const { hub, dispatch } = harness({
      entries: [ack],
      cards: [pending, delivered],
    })
    await hub.startAll()

    await vi.waitFor(() =>
      expect(
        dispatchInputs(dispatch).filter((input) => input['type'] === 'card.delivered'),
      ).toHaveLength(1),
    )
    expect(ack.received.map((card) => card.id)).toEqual(['card-pending'])
  })

  it('没有任何通道时不误判投递失败（T8 前空注册表，pending 卡保持原状）', async () => {
    const card = sample.card({ id: 'card-pending', version: 1 })
    const { hub, dispatch } = harness({ entries: [], cards: [card] })
    await hub.startAll()

    hub.dispatch([cardOpened(card)])
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('通道 start 失败只跳过该通道，其余通道照常投递', async () => {
    const brokenEntry: ChannelRegistryEntry = {
      key: 'broken-start',
      label: 'broken-start',
      manifest: MANIFEST('broken-start'),
      plugin: {
        start: async () => {
          throw new Error('启动失败')
        },
      },
    }
    const good = ackEntry('good')
    const { hub, dispatch } = harness({ entries: [brokenEntry, good] })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])
    await vi.waitFor(() =>
      expect(dispatchInputs(dispatch)).toContainEqual({
        type: 'card.delivered',
        cardId: 'card-1',
        version: 1,
        ref: 'good',
      }),
    )
  })

  it('start 前 dispatch 是 no-op；stopAll 幂等（abort + dispose 只一次）', async () => {
    const ack = ackEntry('ack')
    const { hub, dispatch } = harness({ entries: [ack] })

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])
    expect(ack.received).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()

    await hub.startAll()
    await hub.stopAll()
    await hub.stopAll()
    expect(ack.disposed).toBe(1)

    // 停止后不再投递
    hub.dispatch([cardOpened(sample.card({ id: 'card-2', version: 1 }))])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ack.received.map((card) => card.id)).toEqual([])
  })
})

describe('createChannels：answer 入口', () => {
  it('answer 发 card.answer{via:channel, commandId=card:<id>:<version>}', async () => {
    const card = sample.card({ id: 'card-1', version: 3 })
    const { hub, dispatch, store } = harness({ entries: [], cards: [card] })
    await hub.startAll()

    await hub.answer('card-1', 1)

    expect(store.query).toHaveBeenCalledWith('cards.open')
    expect(dispatch).toHaveBeenCalledWith({
      type: 'card.answer',
      commandId: 'card:card-1:3',
      cardId: 'card-1',
      optionIndex: 1,
      via: 'channel',
    })
  })

  it('内核拒绝（effects.dispatch 抛错）时 answer 原样 reject', async () => {
    const { hub, dispatch } = harness({ entries: [], cards: [] })
    await hub.startAll()
    dispatch.mockImplementationOnce(() => {
      throw new Error('卡片已回答或已关闭: card-1')
    })

    await expect(hub.answer('card-1', 0)).rejects.toThrow('卡片已回答或已关闭')
    // 卡片不在 open 列表里时版本回落 0（内核按 not_found 拒绝，不伪造版本）
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'card:card-1:0' }))
  })
})

describe('createChannels：隔离与边界分支', () => {
  it('通道没有任何 onCard 订阅者：视为未送达，落 delivery_failed', async () => {
    const listenerless: ChannelRegistryEntry = {
      key: 'listenerless',
      label: 'listenerless',
      manifest: MANIFEST('listenerless'),
      plugin: { start: async () => () => undefined },
    }
    const { hub, dispatch } = harness({ entries: [listenerless], timeoutMs: 10 })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() =>
      expect(dispatchInputs(dispatch)).toContainEqual({
        type: 'card.delivery_failed',
        cardId: 'card-1',
        version: 1,
        error: '所有通道投递失败或超时',
      }),
    )
  })

  it('通道同步 ack 后又抛错：settle 只认第一次，不重复 resolve、不写 failed', async () => {
    const race = fakeEntry('race', (ctx, card) => {
      void ctx.delivered(card.id, card.version, 'race')
      throw new Error('ack 之后才炸')
    })
    const { hub, dispatch } = harness({ entries: [race], timeoutMs: 10 })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() =>
      expect(dispatchInputs(dispatch)).toContainEqual({
        type: 'card.delivered',
        cardId: 'card-1',
        version: 1,
        ref: 'race',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dispatchInputs(dispatch).some((input) => input['type'] === 'card.delivery_failed')).toBe(
      false,
    )
  })

  it('非卡片事实不触发投递', async () => {
    const ack = ackEntry('ack')
    const { hub, dispatch } = harness({ entries: [ack] })
    await hub.startAll()

    hub.dispatch([
      {
        type: 'run.queued',
        actor: { kind: 'host', via: 'scheduler' },
        at: AT,
        seq: 1,
        payload: {},
      } as unknown as Fact,
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(ack.received).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('超时之后才到的 ack：按事实回写一次；同一版本重复 ack 静默丢弃', async () => {
    let captured: ChannelContext | null = null
    const received: Card[] = []
    const lateEntry: ChannelRegistryEntry = {
      key: 'late',
      label: 'late',
      manifest: MANIFEST('late'),
      plugin: {
        async start(ctx) {
          captured = ctx
          ctx.onCard((card) => {
            received.push(card)
          })
          return () => undefined
        },
      },
    }
    const { hub, dispatch } = harness({ entries: [lateEntry], timeoutMs: 10 })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])
    await vi.waitFor(() => expect(received).toHaveLength(1))

    // 等超时：先记投递失败
    await vi.waitFor(() =>
      expect(dispatchInputs(dispatch)).toContainEqual({
        type: 'card.delivery_failed',
        cardId: 'card-1',
        version: 1,
        error: '所有通道投递失败或超时',
      }),
    )

    // 没有等待者时 ack：按事实回写 delivered
    await captured!.delivered('card-1', 1, 'late')
    expect(dispatchInputs(dispatch).filter((input) => input['type'] === 'card.delivered')).toEqual([
      { type: 'card.delivered', cardId: 'card-1', version: 1, ref: 'late' },
    ])

    // 同一 (cardId, version) 再 ack：已记录 delivered，静默丢弃
    await captured!.delivered('card-1', 1, 'late')
    expect(
      dispatchInputs(dispatch).filter((input) => input['type'] === 'card.delivered'),
    ).toHaveLength(1)
  })

  it('startAll 重复调用：第二次直接返回，不重复启动通道', async () => {
    const start = vi.fn(async () => () => undefined)
    const entry: ChannelRegistryEntry = {
      key: 'once',
      label: 'once',
      manifest: MANIFEST('once'),
      plugin: { start },
    }
    const { hub } = harness({ entries: [entry] })

    await hub.startAll()
    await hub.startAll()

    expect(start).toHaveBeenCalledTimes(1)
  })

  it('onCard 返回的退订函数生效：退订后不再收到卡片', async () => {
    let unsubscribe: (() => void) | null = null
    const received: Card[] = []
    const entry: ChannelRegistryEntry = {
      key: 'sub',
      label: 'sub',
      manifest: MANIFEST('sub'),
      plugin: {
        async start(ctx) {
          unsubscribe = ctx.onCard((card) => {
            received.push(card)
          })
          return () => undefined
        },
      },
    }
    const { hub } = harness({ entries: [entry], timeoutMs: 10 })
    await hub.startAll()

    unsubscribe!()
    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(received).toEqual([])
  })

  it('通道经 context.answer 回写 card.answer（via=channel）', async () => {
    let captured: ChannelContext | null = null
    const entry: ChannelRegistryEntry = {
      key: 'answering',
      label: 'answering',
      manifest: MANIFEST('answering'),
      plugin: {
        async start(ctx) {
          captured = ctx
          return () => undefined
        },
      },
    }
    const { hub, dispatch } = harness({ entries: [entry] })
    await hub.startAll()

    await captured!.answer('card-1', 2)

    expect(dispatch).toHaveBeenCalledWith({
      type: 'card.answer',
      commandId: 'card:card-1:0',
      cardId: 'card-1',
      optionIndex: 2,
      via: 'channel',
    })
  })

  it('stopAll：没有 dispose 的通道跳过，dispose 抛错只记日志、不阻塞退出', async () => {
    const log = vi.mocked(fakeSdkHost.log)
    log.mockClear()
    const noDispose: ChannelRegistryEntry = {
      key: 'no-dispose',
      label: 'no-dispose',
      manifest: MANIFEST('no-dispose'),
      plugin: { start: async () => null as unknown as () => void },
    }
    const badDispose: ChannelRegistryEntry = {
      key: 'bad-dispose',
      label: 'bad-dispose',
      manifest: MANIFEST('bad-dispose'),
      plugin: {
        start: async () => () => {
          throw new Error('dispose 失败')
        },
      },
    }
    const { hub } = harness({ entries: [noDispose, badDispose] })
    await hub.startAll()

    await expect(hub.stopAll()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad-dispose dispose 失败'))
  })

  it('投递回写抛错：只记日志，不向外抛（fire-and-forget 隔离）', async () => {
    const log = vi.mocked(fakeSdkHost.log)
    log.mockClear()
    const ack = ackEntry('ack')
    const { hub, dispatch } = harness({ entries: [ack] })
    dispatch.mockImplementation(() => {
      throw new Error('写库失败')
    })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('投递回写失败')),
    )
  })

  it('启动补投查询失败：只记日志，不阻塞启动', async () => {
    const log = vi.mocked(fakeSdkHost.log)
    log.mockClear()
    const store = {
      query: vi.fn(() => {
        throw new Error('查询失败')
      }),
    } as unknown as ChannelsStore
    const dispatch = vi.fn(() => ({ facts: [] }))
    const hub = createChannels({
      store,
      effects: { dispatch } as unknown as ChannelsEffects,
      entries: [ackEntry('ack')],
      sdkHost: fakeSdkHost,
      timeoutMs: 10,
    })

    await expect(hub.startAll()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('补投查询失败'))
  })

  it('未注入 timeoutMs 时用默认超时：快通道照常回写 delivered', async () => {
    const ack = ackEntry('ack')
    const store = { query: vi.fn(() => []) } as unknown as ChannelsStore
    const dispatch = vi.fn(() => ({ facts: [] }))
    const hub = createChannels({
      store,
      effects: { dispatch } as unknown as ChannelsEffects,
      entries: [ack],
      sdkHost: fakeSdkHost,
    })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() =>
      expect(dispatchInputs(dispatch)).toContainEqual({
        type: 'card.delivered',
        cardId: 'card-1',
        version: 1,
        ref: 'ack',
      }),
    )
  })

  it('通道抛出非 Error 值：文案用 String 兜底，仍被隔离', async () => {
    const log = vi.mocked(fakeSdkHost.log)
    log.mockClear()
    const weird = fakeEntry('weird', () => {
      throw '炸了'
    })
    const { hub } = harness({ entries: [weird], timeoutMs: 10 })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])

    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('通道 weird 分发失败：炸了')),
    )
  })
})

describe('createChannels：M7 插件启停与按通道配置', () => {
  it('停用的通道不启动；每条通道的 sdk.config 拿到自己的配置', async () => {
    const started: string[] = []
    const configs: Record<string, unknown> = {}
    const entryOf = (key: string): ChannelRegistryEntry => ({
      key,
      label: key,
      manifest: MANIFEST(key),
      plugin: {
        async start(ctx) {
          started.push(key)
          configs[key] = ctx.sdk.config()
          return () => undefined
        },
      },
    })
    const hub = createChannels({
      store: { query: vi.fn(() => []) } as unknown as ChannelsStore,
      effects: { dispatch: vi.fn(() => ({ facts: [] })) } as unknown as ChannelsEffects,
      entries: [entryOf('off'), entryOf('on')],
      sdkHost: fakeSdkHost,
      timeoutMs: 10,
      isEnabled: (entry) => entry.key !== 'off',
      configOf: (entry) => (entry.key === 'on' ? { url: 'http://x' } : {}),
    })
    await hub.startAll()
    expect(started).toEqual(['on'])
    expect(configs).toEqual({ on: { url: 'http://x' } })
  })
})
