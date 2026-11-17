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
import type { Card } from '@workbench/protocol/entities'
import type { ChannelContext, ChannelPlugin, ChannelProgress } from '@workbench/protocol/channels'
import type { PluginManifest } from '@workbench/protocol/manifest'
import type { Fact } from '@workbench/kernel/core/types'
import type { ChannelRegistryEntry } from '@workbench/plugins-registry'
import type { SdkHost } from '@workbench/capabilities/types'
import type { ChannelsEffects, ChannelsStore } from '@workbench/host/channels'
import { createChannels } from '@workbench/host/channels'
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
  it('多通道都收到 onCard：每个通道各写一条 delivered（M43 按通道记账）', async () => {
    const inApp = ackEntry('in-app')
    const desktop = ackEntry('desktop')
    const { hub, dispatch } = harness({ entries: [inApp, desktop] })
    await hub.startAll()

    const card = sample.card({ id: 'card-1', version: 1 })
    hub.dispatch([cardOpened(card)])

    await vi.waitFor(() => expect(desktop.received).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 两个通道都收到卡片，各自记一条「我送达了」
    expect(inApp.received.map((item) => item.id)).toEqual(['card-1'])
    expect(desktop.received.map((item) => item.id)).toEqual(['card-1'])
    const inputs = dispatchInputs(dispatch)
    expect(inputs.filter((input) => input['type'] === 'card.delivered')).toEqual([
      { type: 'card.delivered', cardId: 'card-1', version: 1, channel: 'in-app', ref: 'in-app' },
      { type: 'card.delivered', cardId: 'card-1', version: 1, channel: 'desktop', ref: 'desktop' },
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
      { type: 'card.delivered', cardId: 'card-1', version: 1, channel: 'desktop', ref: 'desktop' },
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
      { type: 'card.delivered', cardId: 'card-1', version: 1, channel: 'desktop', ref: 'desktop' },
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
      { type: 'card.delivered', cardId: 'card-1', version: 1, channel: 'in-app', ref: 'in-app' },
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
        channel: 'good',
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
        channel: 'ack',
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
        channel: 'silent-b',
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
          channel: 'slow',
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

  it('card.updated 换版本后重新投递；已答 / 已关的卡只补发给发过它的通道', async () => {
    const ack = ackEntry('ack')
    const { hub, dispatch } = harness({ entries: [ack] })
    await hub.startAll()

    hub.dispatch([cardOpened(sample.card({ id: 'card-1', version: 1 }))])
    await vi.waitFor(() => expect(ack.received).toHaveLength(1))
    hub.dispatch([cardUpdated(sample.card({ id: 'card-1', version: 2 }))])
    await vi.waitFor(() => expect(ack.received).toHaveLength(2))
    expect(ack.received.map((card) => card.version)).toEqual([1, 2])

    // 从没发给过这个通道的已答卡：不必告诉它「已经答复了」
    hub.dispatch([cardOpened(sample.card({ id: 'card-2', status: 'answered' }))])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ack.received.map((card) => card.id)).toEqual(['card-1', 'card-1'])

    // 发过、但还停在 open 版本的卡：终态要回写（M43）
    const settled = sample.card({
      id: 'card-1',
      version: 2,
      status: 'answered',
      optionIndex: 0,
      deliveryRefs: { ack: { version: 2, status: 'open', ref: 'ack', at: AT } },
    })
    hub.dispatch([cardOpened(settled)])
    await vi.waitFor(() => expect(ack.received).toHaveLength(3))
    expect(ack.received.at(-1)?.status).toBe('answered')
    expect(
      dispatchInputs(dispatch).filter((input) => input['type'] === 'card.delivered'),
    ).toHaveLength(3)
  })

  it('startAll 补投：open 卡按通道补齐；已经同步过该通道的卡不再打扰', async () => {
    const ack = ackEntry('ack')
    const pending = sample.card({ id: 'card-pending', version: 1 })
    const synced = sample.card({
      id: 'card-synced',
      version: 1,
      delivery: 'delivered',
      deliveryRef: 'ack',
      deliveryRefs: { ack: { version: 1, status: 'open', ref: 'ack', at: AT } },
    })
    const { hub, dispatch } = harness({
      entries: [ack],
      cards: [pending, synced],
    })
    await hub.startAll()

    await vi.waitFor(() =>
      expect(
        dispatchInputs(dispatch).filter((input) => input['type'] === 'card.delivered'),
      ).toHaveLength(1),
    )
    expect(ack.received.map((card) => card.id)).toEqual(['card-pending'])
  })

  it('投递进行中再次 dispatch 同一张卡：不重复开一轮', async () => {
    const slow = fakeEntry('slow', (ctx, card) => {
      setTimeout(() => {
        void ctx.delivered(card.id, card.version, 'slow')
      }, 20)
    })
    const { hub } = harness({ entries: [slow], timeoutMs: 500 })
    await hub.startAll()

    const fact = cardOpened(sample.card({ id: 'card-1', version: 1 }))
    hub.dispatch([fact])
    hub.dispatch([fact])
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(slow.received).toHaveLength(1)
  })

  it('同一批里同一张卡重复出现只投一轮；缺卡片体的事实直接跳过', async () => {
    const ack = ackEntry('ack')
    const { hub } = harness({ entries: [ack] })
    await hub.startAll()

    const card = sample.card({ id: 'card-1', version: 1 })
    hub.dispatch([cardOpened(card), cardUpdated(card)])
    hub.dispatch([{ type: 'card.opened', payload: {} } as unknown as Fact])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(ack.received).toHaveLength(1)
  })

  it('从未投给这个通道的卡被 ack：忽略（不凭空造投递记录）', async () => {
    let captured: ChannelContext | null = null
    const entry: ChannelRegistryEntry = {
      key: 'ghost',
      label: 'ghost',
      manifest: MANIFEST('ghost'),
      plugin: {
        async start(ctx) {
          captured = ctx
          return () => undefined
        },
      },
    }
    const { hub, dispatch } = harness({ entries: [entry] })
    await hub.startAll()

    await captured!.delivered('unknown-card', 1, 'om_1')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('投递途中卡片被回答：终态那一轮不被进行中的 open 轮挡掉', async () => {
    const received: Card[] = []
    const entry: ChannelRegistryEntry = {
      key: 'slow',
      label: 'slow',
      manifest: MANIFEST('slow'),
      plugin: {
        async start(ctx) {
          ctx.onCard((card) => {
            received.push(card)
          })
          return () => undefined
        },
      },
    }
    const { hub } = harness({ entries: [entry], timeoutMs: 500 })
    await hub.startAll()

    const open = sample.card({ id: 'card-1', version: 1 })
    hub.dispatch([cardOpened(open)])
    // open 那一轮还在等 ack（通道不 ack）：此时回答，终态要能立刻排上
    hub.dispatch([
      {
        type: 'card.answered',
        actor: { kind: 'owner', via: 'ui' },
        at: AT,
        seq: 2,
        payload: {
          card: {
            ...open,
            status: 'answered',
            optionIndex: 0,
            deliveryRefs: { slow: { version: 1, status: 'open', ref: 'om_1', at: AT } },
          },
          by: 'ui',
        },
      } as unknown as Fact,
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(received.map((card) => card.status)).toEqual(['open', 'answered'])
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
        channel: 'good',
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
  it('answer 发 card.answer{via:channel, commandId=card:<id>:<version>}，返回 changed', async () => {
    const card = sample.card({ id: 'card-1', version: 3 })
    const { hub, dispatch, store } = harness({ entries: [], cards: [card] })
    await hub.startAll()

    await expect(hub.answer('card-1', 1)).resolves.toEqual({
      changed: true,
      status: 'answered',
    })

    expect(store.query).toHaveBeenCalledWith('cards.open')
    expect(dispatch).toHaveBeenCalledWith({
      type: 'card.answer',
      commandId: 'card:card-1:3',
      cardId: 'card-1',
      optionIndex: 1,
      via: 'channel',
    })
  })

  it('卡片已经不在等你（别处答过 / 已关闭）：不 dispatch、返回 changed=false', async () => {
    const { hub, dispatch } = harness({ entries: [], cards: [] })
    await hub.startAll()

    await expect(hub.answer('card-1', 0)).resolves.toEqual({
      changed: false,
      status: 'resolved',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('内核拒绝（effects.dispatch 抛错）：返回 changed=false，不伪造状态', async () => {
    const card = sample.card({ id: 'card-1', version: 3 })
    const { hub, dispatch } = harness({ entries: [], cards: [card] })
    await hub.startAll()
    dispatch.mockImplementationOnce(() => {
      throw new Error('运行不存在或不在等待状态: run-1')
    })

    await expect(hub.answer('card-1', 0)).resolves.toEqual({
      changed: false,
      status: 'open',
    })
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
        channel: 'listenerless',
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
        channel: 'race',
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
        channel: 'late',
        error: '所有通道投递失败或超时',
      }),
    )

    // 没有等待者时 ack：按事实回写 delivered
    await captured!.delivered('card-1', 1, 'late')
    expect(dispatchInputs(dispatch).filter((input) => input['type'] === 'card.delivered')).toEqual([
      { type: 'card.delivered', cardId: 'card-1', version: 1, channel: 'late', ref: 'late' },
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

  it('通道经 context.answer 回写 card.answer（via=channel，带回答人）', async () => {
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
    const card = sample.card({ id: 'card-1', version: 3 })
    const { hub, dispatch } = harness({ entries: [entry], cards: [card] })
    await hub.startAll()

    await expect(captured!.answer('card-1', 2, 'om_1', 'ou_me')).resolves.toEqual({
      changed: true,
      status: 'answered',
    })

    expect(dispatch).toHaveBeenCalledWith({
      type: 'card.answer',
      commandId: 'card:card-1:3',
      cardId: 'card-1',
      optionIndex: 2,
      via: 'channel',
      byRef: 'ou_me',
    })
  })

  it('点的是这个通道发出去的旧消息（ref 对不上）：不计入', async () => {
    let captured: ChannelContext | null = null
    const entry: ChannelRegistryEntry = {
      key: 'feishu',
      label: 'feishu',
      manifest: MANIFEST('feishu'),
      plugin: {
        async start(ctx) {
          captured = ctx
          return () => undefined
        },
      },
    }
    const card = sample.card({
      id: 'card-1',
      version: 2,
      deliveryRefs: { feishu: { version: 2, status: 'open', ref: 'om_new', at: AT } },
    })
    const { hub, dispatch } = harness({ entries: [entry], cards: [card] })
    await hub.startAll()

    await expect(captured!.answer('card-1', 0, 'om_old')).resolves.toEqual({
      changed: false,
      status: 'open',
    })
    expect(dispatch).not.toHaveBeenCalled()
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
        channel: 'ack',
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

describe('createChannels：M7 无 configOf 时的配置兜底', () => {
  it('未注入 configOf：sdk.config() 返回空对象（不抛错）', async () => {
    const configs: Record<string, unknown> = {}
    const entry: ChannelRegistryEntry = {
      key: 'plain',
      label: 'plain',
      manifest: MANIFEST('plain'),
      plugin: {
        async start(ctx) {
          configs.plain = ctx.sdk.config()
          return () => undefined
        },
      },
    }
    const hub = createChannels({
      store: { query: vi.fn(() => []) } as unknown as ChannelsStore,
      effects: { dispatch: vi.fn(() => ({ facts: [] })) } as unknown as ChannelsEffects,
      entries: [entry],
      sdkHost: fakeSdkHost,
      timeoutMs: 10,
    })
    await hub.startAll()
    expect(configs).toEqual({ plain: {} })
  })
})

describe('createChannels：投递重试账（M41）', () => {
  /** 让内核回写「下一次重投时刻」：hub 只按它排期，不自己算曲线。 */
  const retryEffects = (
    dispatch: ReturnType<typeof vi.fn>,
    nextDeliveryAt: string | null,
    cardId: string,
  ): void => {
    dispatch.mockImplementation((input: Record<string, unknown>) => {
      if (input['type'] !== 'card.delivery_failed') return { facts: [] }
      return {
        facts: [
          {
            type: 'card.delivery_failed',
            payload: {
              card: {
                ...sample.card({ id: cardId, version: 1 }),
                delivery: 'failed',
                nextDeliveryAt,
              },
              error: '所有通道投递失败或超时',
            },
          },
        ],
      }
    })
  }

  it('失败后按 nextDeliveryAt 再投一次，成功即停', async () => {
    let attempts = 0
    const flaky = fakeEntry('in-app', (ctx, card) => {
      attempts += 1
      if (attempts >= 2) void ctx.delivered(card.id, card.version, 'in-app')
    })
    const { hub, dispatch } = harness({ entries: [flaky], timeoutMs: 10 })
    retryEffects(dispatch, new Date(Date.now() + 10).toISOString(), 'card-r')

    await hub.startAll()
    hub.dispatch([cardOpened(sample.card({ id: 'card-r', version: 1 }))])

    await vi.waitFor(() => expect(flaky.received.length).toBeGreaterThanOrEqual(2), {
      timeout: 1_000,
    })
    const delivered = dispatch.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .filter((input) => input['type'] === 'card.delivered')
    expect(delivered).toHaveLength(1)
    // 成功之后不再有新的失败回写
    const failed = dispatch.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .filter((input) => input['type'] === 'card.delivery_failed')
    expect(failed).toHaveLength(1)
  })

  it('内核判定放弃（nextDeliveryAt=null）就不再重投', async () => {
    const alwaysFails = fakeEntry('in-app')
    const { hub, dispatch } = harness({ entries: [alwaysFails], timeoutMs: 10 })
    retryEffects(dispatch, null, 'card-given-up')

    await hub.startAll()
    hub.dispatch([cardOpened(sample.card({ id: 'card-given-up', version: 1 }))])

    await vi.waitFor(() => expect(alwaysFails.received).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(alwaysFails.received).toHaveLength(1)
  })
})

describe('createChannels：补投与重投排期（M41）', () => {
  it('启动补投：未到点的失败卡先排期，到点才投', async () => {
    const inApp = ackEntry('in-app')
    const pendingRetry = sample.card({
      id: 'card-later',
      version: 1,
      delivery: 'failed',
      deliveryAttempts: 1,
      nextDeliveryAt: new Date(Date.now() + 20).toISOString(),
      deliveryGivenUp: false,
    })
    const { hub } = harness({ entries: [inApp], cards: [pendingRetry] })

    await hub.startAll()
    expect(inApp.received).toHaveLength(0)

    await vi.waitFor(() => expect(inApp.received).toHaveLength(1), { timeout: 1_000 })
  })

  it('stopAll 取消已排期的重投（退出后不再投）', async () => {
    const inApp = ackEntry('in-app')
    const pendingRetry = sample.card({
      id: 'card-later-2',
      version: 1,
      delivery: 'failed',
      deliveryAttempts: 1,
      nextDeliveryAt: new Date(Date.now() + 20).toISOString(),
      deliveryGivenUp: false,
    })
    const { hub } = harness({ entries: [inApp], cards: [pendingRetry] })

    await hub.startAll()
    await hub.stopAll()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(inApp.received).toHaveLength(0)
  })
})
it('补投跳过已放弃的卡（判据只在 deliver 一处）', async () => {
  const inApp = ackEntry('in-app')
  const givenUp = sample.card({
    id: 'card-given-up-backfill',
    version: 1,
    delivery: 'failed',
    deliveryAttempts: 5,
    nextDeliveryAt: null,
    deliveryGivenUp: true,
  })
  const { hub } = harness({ entries: [inApp], cards: [givenUp] })

  await hub.startAll()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(inApp.received).toHaveLength(0)
})

it('回写事实缺卡片体时不排期（防御分支），并按注入的 now 计算延迟', async () => {
  const failing = fakeEntry('in-app')
  const { hub, dispatch } = harness({ entries: [failing], timeoutMs: 10 })
  dispatch.mockReturnValue({
    facts: [{ type: 'card.delivery_failed', payload: { error: '缺卡体' } }],
  })

  // 注入 now：覆盖「宿主给了时钟」那条分支
  const withClock = createChannels({
    store: { query: () => [] } as unknown as ChannelsStore,
    effects: { dispatch } as unknown as ChannelsEffects,
    entries: [failing],
    sdkHost: fakeSdkHost,
    timeoutMs: 10,
    now: () => AT,
  })
  await withClock.startAll()
  withClock.dispatch([cardOpened(sample.card({ id: 'card-no-body', version: 1 }))])

  await vi.waitFor(() => expect(failing.received).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(failing.received).toHaveLength(1)
  await withClock.stopAll()
  await hub.stopAll()
})

// ---------------------------------------------------------------- 入站（M44）

/** 一条 assistant `message.appended`（聊天轮终态时内核补的那条）。 */
const progressFact = (
  conversationId: string,
  body: string,
  over: { role?: string; error?: string | null; messageId?: string } = {},
): Fact =>
  ({
    type: 'message.appended',
    actor: { kind: 'host', via: 'scheduler' },
    at: AT,
    seq: 1,
    payload: {
      conversationId,
      messageId: over.messageId ?? 'message-1',
      role: over.role ?? 'assistant',
      content: body,
      error: over.error ?? null,
    },
  }) as Fact

describe('createChannels：入站派活与进展（M44）', () => {
  const AGENTS = [
    { id: 'a1', name: '小助' },
    { id: 'a2', name: '写手' },
  ]

  /** 一个会暴露自己 ctx 的假通道：入站派活与进展都靠它观察。 */
  const captureEntry = (
    key: string,
  ): ChannelRegistryEntry & {
    ctx: ChannelContext | null
    progress: ChannelProgress[]
  } => {
    const state: { ctx: ChannelContext | null; progress: ChannelProgress[] } = {
      ctx: null,
      progress: [],
    }
    const plugin: ChannelPlugin = {
      async start(ctx) {
        state.ctx = ctx
        ctx.onProgress((p) => state.progress.push(p))
        return () => undefined
      },
    }
    return Object.assign(
      { key, label: key, manifest: MANIFEST(key), plugin },
      {
        get ctx() {
          return state.ctx
        },
        get progress() {
          return state.progress
        },
      },
    )
  }

  const hubOf = (options: {
    entries: ChannelRegistryEntry[]
    config?: Record<string, unknown>
    configs?: Record<string, Record<string, unknown>>
    /** M47：话题路由要读的三张视图（缺省都为空 = 「没有话题、没有会话」） */
    threads?: unknown[]
    conversations?: unknown[]
    active?: unknown[]
    /** 注入时钟（话题活跃窗口按它算；不传走宿主真实时间） */
    now?: () => string
  }): {
    hub: ReturnType<typeof createChannels>
    dispatch: ReturnType<typeof vi.fn>
  } => {
    const store = {
      query: vi.fn((view: string) => {
        if (view === 'agents.all') return AGENTS
        if (view === 'threads.open') return options.threads ?? []
        if (view === 'conversations.byThread') return options.conversations ?? []
        if (view === 'runs.active-by-conversation') return options.active ?? []
        return []
      }),
    } as unknown as ChannelsStore
    const dispatch = vi.fn((input: Record<string, unknown>) => {
      if (input['type'] === 'thread.open') {
        return {
          facts: [{ type: 'thread.opened', payload: { thread: { id: 'thread-1' } } }],
        }
      }
      if (input['type'] === 'chat.create') {
        return {
          facts: [
            {
              type: 'conversation.created',
              payload: { conversation: { id: 'conversation-1' } },
            },
          ],
        }
      }
      return { facts: [] }
    })
    const hub = createChannels({
      store,
      effects: { dispatch } as unknown as ChannelsEffects,
      entries: options.entries,
      sdkHost: fakeSdkHost,
      timeoutMs: 20,
      configOf: (entry) => options.configs?.[entry.key] ?? options.config ?? {},
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    return { hub, dispatch }
  }

  it('一句话派活：先建会话（标题取首行），再发这句；回执带上智能体名字', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({ entries: [feishu], config: { agent: '小助' } })
    await hub.startAll()

    const outcome = await hub.submit('feishu', '帮我看看今天的待办', { ref: 'om_1' })

    expect(outcome).toEqual({
      accepted: true,
      conversationId: 'conversation-1',
      receipt: '已交给「小助」，这一轮说完我回在这里。',
    })
    const inputs = dispatchInputs(dispatch)
    expect(inputs[0]).toEqual({
      type: 'chat.create',
      commandId: 'channel:feishu:om_1:create',
      agentId: 'a1',
      title: '帮我看看今天的待办',
    })
    expect(inputs[1]).toEqual({
      type: 'chat.send',
      commandId: 'channel:feishu:om_1:send',
      conversationId: 'conversation-1',
      content: '帮我看看今天的待办',
    })
    await hub.stopAll()
  })

  it('同一条平台消息重投：幂等键不变（内核不会派两次活）', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({ entries: [feishu], config: { agent: 'a1' } })
    await hub.startAll()

    await hub.submit('feishu', '第一句', { ref: 'om_1' })
    await hub.submit('feishu', '第一句', { ref: 'om_1' })

    const keys = dispatchInputs(dispatch).map((input) => input['commandId'])
    expect(keys).toEqual([
      'channel:feishu:om_1:create',
      'channel:feishu:om_1:send',
      'channel:feishu:om_1:create',
      'channel:feishu:om_1:send',
    ])
    await hub.stopAll()
  })

  it('入站线索按对象传入：ref 仍是幂等键，别的线索不影响派活', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({ entries: [feishu], config: { agent: 'a1' } })
    await hub.startAll()

    const hints = { ref: 'om_9', chatId: 'oc_1', rootRef: 'om_root', threadRef: 'omt_1' }
    const first = await hub.submit('feishu', '第一句', hints)
    const again = await hub.submit('feishu', '第一句', hints)

    expect(first.accepted).toBe(true)
    expect(again.accepted).toBe(true)
    // 幂等键仍由 ref 决定：同一条平台消息重投不换键（带了会话 id 会先开话题）
    const keys = dispatchInputs(dispatch).map((input) => input['commandId'])
    expect(keys).toEqual([
      'channel:feishu:om_9:topic',
      'channel:feishu:om_9:create',
      'channel:feishu:om_9:send',
      'channel:feishu:om_9:topic',
      'channel:feishu:om_9:create',
      'channel:feishu:om_9:send',
    ])
    await hub.stopAll()
  })

  it('没配默认智能体 / 智能体不存在 / 空消息：都不派活，但都回一句人话', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({ entries: [feishu] })
    await hub.startAll()

    const unset = await hub.submit('feishu', '你好', { ref: 'om_1' })
    expect(unset.accepted).toBe(false)
    expect(unset.receipt).toContain('没配默认智能体')

    const missing = await hub.submit('feishu', '你好', { ref: 'om_2' })
    expect(missing.accepted).toBe(false)
    expect(missing.receipt).toContain('没配默认智能体')

    const blank = await hub.submit('feishu', '   ', { ref: 'om_3' })
    expect(blank.accepted).toBe(false)
    expect(blank.receipt).toContain('空消息')
    expect(dispatch).not.toHaveBeenCalled()
    await hub.stopAll()
  })

  it('配置里写不存在的智能体：回执说清是哪一个没找到', async () => {
    const feishu = captureEntry('feishu')
    const { hub } = hubOf({ entries: [feishu], config: { agent: '不存在的' } })
    await hub.startAll()

    const outcome = await hub.submit('feishu', '你好', { ref: 'om_1' })
    expect(outcome.accepted).toBe(false)
    expect(outcome.receipt).toContain('找不到智能体「不存在的」')
    await hub.stopAll()
  })

  it('进展只回给提交这个会话的通道；别人的会话、人发的消息、别的角色都不吵人', async () => {
    const feishu = captureEntry('feishu')
    const desktop = captureEntry('desktop')
    const { hub } = hubOf({ entries: [feishu, desktop], config: { agent: 'a1' } })
    await hub.startAll()
    await hub.submit('feishu', '帮我看看今天的待办', { ref: 'om_1' })

    hub.dispatch([progressFact('conversation-1', '已经做完了')])
    hub.dispatch([progressFact('conversation-other', '别人的活')])
    hub.dispatch([progressFact('conversation-1', '人说的话', { role: 'user' })])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(feishu.progress).toEqual([
      { conversationId: 'conversation-1', kind: 'reply', text: '已经做完了' },
    ])
    expect(desktop.progress).toEqual([])
    await hub.stopAll()
  })

  it('失败的一轮按 failed 转出去（错误文案原样交给通道回帖）', async () => {
    const feishu = captureEntry('feishu')
    const { hub } = hubOf({ entries: [feishu], config: { agent: 'a1' } })
    await hub.startAll()
    await hub.submit('feishu', '帮我看看今天的待办', { ref: 'om_1' })

    hub.dispatch([progressFact('conversation-1', '', { error: '执行器崩了' })])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(feishu.progress).toEqual([
      { conversationId: 'conversation-1', kind: 'failed', text: '执行器崩了' },
    ])
    await hub.stopAll()
  })

  // ---------------------------------------------------------------- 话题收敛（M47）

  /** 一条 open 话题（`externalRef` = `<scope>:<chat>:<根消息>`）。 */
  const topicOf = (over: Record<string, unknown> = {}) => ({
    id: 'thread-1',
    source: 'feishu',
    externalRef: 'default:oc_1:om_root',
    title: '报销流程',
    status: 'open',
    lastActivityAt: AT,
    ...over,
  })

  it('同一会话的第二句接在上一轮会话上：不建新会话，回执写明接在哪个话题', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({
      entries: [feishu],
      config: { agent: 'a1' },
      threads: [topicOf()],
      conversations: [{ id: 'conversation-9' }],
      now: () => AT,
    })
    await hub.startAll()

    const outcome = await hub.submit('feishu', '还有个问题', {
      ref: 'default:om_2',
      chatId: 'oc_1',
      scope: 'default',
    })

    expect(outcome).toEqual({
      accepted: true,
      conversationId: 'conversation-9',
      receipt: '已接在「报销流程」这个话题里，这一轮说完我回在这里。',
    })
    const inputs = dispatchInputs(dispatch)
    expect(inputs).toEqual([
      {
        type: 'chat.send',
        commandId: 'channel:feishu:default:om_2:send',
        conversationId: 'conversation-9',
        content: '还有个问题',
      },
    ])
    await hub.stopAll()
  })

  it('会话正忙：这一句先排队，run 落终态后自动补发（不丢话）', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({
      entries: [feishu],
      config: { agent: 'a1' },
      threads: [topicOf()],
      conversations: [{ id: 'conversation-9' }],
      active: [{ id: 'run-1' }],
      now: () => AT,
    })
    await hub.startAll()

    const outcome = await hub.submit('feishu', '再补一句', {
      ref: 'default:om_3',
      chatId: 'oc_1',
      scope: 'default',
    })

    expect(outcome.accepted).toBe(true)
    expect(outcome.conversationId).toBe('conversation-9')
    expect(outcome.receipt).toContain('排在当前这轮后面')
    // 忙时不发：只有等这一轮说完才轮到它
    expect(dispatchInputs(dispatch)).toEqual([])

    hub.dispatch([progressFact('conversation-9', '这一轮说完了')])
    await new Promise((resolve) => setTimeout(resolve, 10))

    const sent = dispatchInputs(dispatch).filter((input) => input['type'] === 'chat.send')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      conversationId: 'conversation-9',
      content: '再补一句',
    })
    await hub.stopAll()
  })

  it('结构证据优先：超出活跃窗口，但回复的是这个话题的根消息 → 仍接上', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({
      entries: [feishu],
      config: { agent: 'a1' },
      threads: [topicOf({ lastActivityAt: '2020-01-01T00:00:00.000Z' })],
      conversations: [{ id: 'conversation-9' }],
      now: () => AT,
    })
    await hub.startAll()

    const outcome = await hub.submit('feishu', '三天后回一句', {
      ref: 'default:om_4',
      chatId: 'oc_1',
      scope: 'default',
      rootRef: 'om_root',
    })

    expect(outcome.conversationId).toBe('conversation-9')
    expect(dispatchInputs(dispatch).map((input) => input['type'])).toEqual(['chat.send'])
    await hub.stopAll()
  })

  it('窗口外又没有结构证据：开新话题、建新会话', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({
      entries: [feishu],
      config: { agent: 'a1' },
      threads: [topicOf({ lastActivityAt: '2020-01-01T00:00:00.000Z' })],
      conversations: [{ id: 'conversation-9' }],
      now: () => AT,
    })
    await hub.startAll()

    const outcome = await hub.submit('feishu', '换个事', {
      ref: 'default:om_5',
      chatId: 'oc_1',
      scope: 'default',
    })

    expect(outcome.accepted).toBe(true)
    const inputs = dispatchInputs(dispatch)
    expect(inputs[0]).toMatchObject({
      type: 'thread.open',
      source: 'feishu',
      externalRef: 'default:oc_1:default:om_5',
    })
    expect(inputs[1]).toMatchObject({ type: 'chat.create', threadId: 'thread-1' })
    expect(inputs[2]).toMatchObject({ type: 'chat.send', conversationId: 'conversation-1' })
    await hub.stopAll()
  })

  it('没有会话 id 的提交（老调用 / 别的平台）：仍按老行为建新会话，不并话题', async () => {
    const feishu = captureEntry('feishu')
    const { hub, dispatch } = hubOf({
      entries: [feishu],
      config: { agent: 'a1' },
      threads: [topicOf()],
      conversations: [{ id: 'conversation-9' }],
      now: () => AT,
    })
    await hub.startAll()

    const outcome = await hub.submit('feishu', '你好', { ref: 'om_6' })

    expect(outcome.conversationId).toBe('conversation-1')
    const inputs = dispatchInputs(dispatch)
    expect(inputs[0]).toMatchObject({ type: 'chat.create' })
    expect(inputs[0]).not.toHaveProperty('threadId')
    await hub.stopAll()
  })
})
