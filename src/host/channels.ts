/**
 * 通道宿主 hub（M4 D9/D10）：注册、启停、卡片投递、补投与回答。
 *
 * 职责边界：
 * - **只读卡片、只回写投递/回答**：内容与派活由内核决定，通道插件不写库（只能经回调
 *   让 hub 走 `effects.dispatch` → `decide` → 事实）；
 * - **fire-and-forget**：`dispatch(facts)` 同步返回，投递在微任务里异步进行；单通道
 *   异常/超时被隔离，绝不影响写路径返回值；
 * - **投递顺序 = registry 顺序**：依次尝试，首个通道调 `delivered` 即记
 *   `card.delivered{ref:通道键}`；全部失败/超时记 `card.delivery_failed`；
 * - **幂等**：同一 `(cardId, version)` 进程内只投一次（重启后只补 `delivery='pending'`
 *   的 open 卡）；版本不匹配的迟到回报由内核再兜一层（零事实）；
 * - **启停**：`startAll` 建 AbortController 并逐通道 `start`（单个失败只跳过该通道），
 *   随后补投 pending 卡；`stopAll` abort + best-effort dispose，可重复调用。
 *
 * 与 SPEC-host 的启动顺序一致：hub 在 effects 之后创建、scheduler 之前 `startAll`。
 * `answer` 走既有写入口（`commandId='card:<cardId>:<version>'`，`via:'channel'`）；
 * 被内核拒绝时直接 reject 给通道插件，由插件自行展示/记录。
 */
import type { Card } from '../protocol/entities'
import type { ChannelContext } from '../protocol/channels'
import type { Fact, Iso } from '../kernel/types'
import type { ChannelRegistryEntry } from '../plugins/registry'
import type { SdkHost } from '../sdk/types'
import type { ViewId, ViewParams, ViewResult } from '../protocol/views'
import type { DispatchResult } from './store/index'
import { createSdk } from '../sdk'

/** hub 只需要的 store 读能力（补投要查 open 卡）。 */
export interface ChannelsStore {
  query<T extends ViewId>(view: T, params?: ViewParams<T>): ViewResult<T>
}

/** hub 只需要的写入口（装配根注入 `effects.dispatch`，事实仍由内核决定）。 */
export interface ChannelsEffects {
  dispatch(input: unknown): DispatchResult
}

export interface ChannelsOptions {
  store: ChannelsStore
  effects: ChannelsEffects
  /** 内置通道清单（顺序即投递顺序；装配根从 `plugins/registry` 注入） */
  entries: readonly ChannelRegistryEntry[]
  /** 通道 sdk 的宿主原件；能力门控（notify 等）由 `createSdk` 按 manifest 做 */
  sdkHost: SdkHost
  /** 当前时刻；hub 自己不产事实（时间由内核在决策时给），保留给将来的节流/日志 */
  now?: () => Iso
  /** 单通道单次投递的超时（毫秒）；默认 2 s，测试可注入更短值 */
  timeoutMs?: number
}

export interface Channels {
  startAll(): Promise<void>
  stopAll(): Promise<void>
  /** 提交后分发：只处理 `card.opened` / `card.updated`，其余事实忽略 */
  dispatch(facts: readonly Fact[]): void
  /** 通道侧回答：发 `card.answer{via:'channel'}`；内核拒绝时 reject */
  answer(cardId: string, optionIndex: number): Promise<void>
}

/** 单通道单次投递的默认超时（D9：慢通道不拖住其它通道与写路径）。 */
const DEFAULT_CHANNEL_TIMEOUT_MS = 2_000

/** 投递全失败时写进 `card.delivery_failed` 的文案（不拼卡片正文）。 */
const DELIVERY_FAILED_ERROR = '所有通道投递失败或超时'

interface ChannelRuntime {
  key: string
  abort: AbortController
  handlers: Set<(card: Card) => void>
  dispose: (() => void) | null
  /** start 成功后才参与投递 */
  started: boolean
}

const attemptKey = (channelKey: string, cardId: string, version: number): string =>
  `${channelKey}|${cardId}:${version}`

const versionKey = (cardId: string, version: number): string => `${cardId}:${version}`

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createChannels(options: ChannelsOptions): Channels {
  const { store, effects, entries, sdkHost } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS

  const runtimes = new Map<string, ChannelRuntime>()
  /** 正在等待某通道 ack 的投递；key = channelKey|cardId:version */
  const attempts = new Map<string, (ref: string) => void>()
  /** 已经送达过的版本（进程内去重；重启后清空，靠补投 pending 续上） */
  const deliveredVersions = new Set<string>()
  const inFlight = new Set<string>()
  let started = false
  let stopping = false

  const log = (line: string): void => {
    try {
      sdkHost.log(`[channels] ${line}`)
    } catch {
      // 日志失败不影响投递
    }
  }

  /** 写投递事实：统一经 effects.dispatch（→ decide → 事实），异常自捕获。 */
  const write = (input: Record<string, unknown>): void => {
    try {
      effects.dispatch(input)
    } catch (error) {
      log(`投递回写失败（${String(input['type'])}）：${errMsg(error)}`)
    }
  }

  const markDelivered = (cardId: string, version: number, ref: string): void => {
    deliveredVersions.add(versionKey(cardId, version))
    write({ type: 'card.delivered', cardId, version, ref })
  }

  const markFailed = (cardId: string, version: number, error: string): void => {
    write({ type: 'card.delivery_failed', cardId, version, error })
  }

  /**
   * 通道调用 `delivered` 的入口：命中等待中的投递就唤醒它（是否写事实由投递循环决定，
   * 多通道时只写首个成功的一条）；没有等待者（例如晚到 ack）时按事实回写，但同一版本
   * 已记录 delivered 就静默丢弃（内核也会按 `(cardId, version)` 幂等）。
   */
  const reportDelivered = (
    channelKey: string,
    cardId: string,
    version: number,
    ref: string,
  ): void => {
    const waiter = attempts.get(attemptKey(channelKey, cardId, version))
    if (waiter !== undefined) {
      waiter(ref)
      return
    }
    if (deliveredVersions.has(versionKey(cardId, version))) return
    markDelivered(cardId, version, ref)
  }

  /**
   * 尝试一个通道：调用其全部 onCard 订阅者，等待 `delivered` 或超时/抛错。
   * 返回首个 ack 的 ref；超时/无订阅者/抛错返回 null。**这里不写事实**——写不写、写几条
   * 由投递循环决定（多通道时只有首个成功写一次 `card.delivered`）。
   */
  const attempt = (runtime: ChannelRuntime, card: Card): Promise<string | null> => {
    if (runtime.handlers.size === 0) return Promise.resolve(null)
    const key = attemptKey(runtime.key, card.id, card.version)
    return new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (ref: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        attempts.delete(key)
        resolve(ref)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      attempts.set(key, (ref) => finish(ref))
      try {
        // 通道插件可能异步完成投递；这里只负责把卡片交给它（不 await handler 的返回）。
        for (const handler of runtime.handlers) handler(card)
      } catch (error) {
        log(`通道 ${runtime.key} 分发失败：${errMsg(error)}`)
        finish(null)
      }
    })
  }

  /**
   * 向所有已启动通道各投一次（registry 顺序），**不在首个成功后 break**：
   * in-app 与 desktop 都能收到同一张卡；首个 ack 立即写一条 `card.delivered`，
   * 其余 ack 静默丢弃（内核也按 `(cardId, version)` 幂等）；全部失败才写
   * `card.delivery_failed`。同一 `(cardId, version)` 进程内只跑一轮（inFlight 去重），
   * 某通道晚到成功也不会再重复写事实（`reportDelivered` 先查 deliveredVersions）。
   */
  const deliver = async (card: Card): Promise<void> => {
    const key = versionKey(card.id, card.version)
    if (deliveredVersions.has(key) || inFlight.has(key)) return
    // 没有任何通道成功启动（空注册表 / 全部 start 失败）时不判定投递失败：
    // T8 之前内置通道清单为空，启动补投不能把 pending 卡误记成 failed。
    if (![...runtimes.values()].some((runtime) => runtime.started)) return
    inFlight.add(key)
    try {
      let deliveredRef: string | null = null
      for (const entry of entries) {
        const runtime = runtimes.get(entry.key)
        if (!runtime || !runtime.started) continue
        const ref = await attempt(runtime, card)
        if (ref === null || deliveredRef !== null) continue
        deliveredRef = ref
        // 首个成功：只写一条 delivered 事实；后续通道继续投完（它们也要通知）
        markDelivered(card.id, card.version, ref)
      }
      if (deliveredRef === null) markFailed(card.id, card.version, DELIVERY_FAILED_ERROR)
    } finally {
      inFlight.delete(key)
    }
  }

  const deliverFactCards = (facts: readonly Fact[]): void => {
    for (const fact of facts) {
      if (fact.type !== 'card.opened' && fact.type !== 'card.updated') continue
      const card = (fact.payload as { card: Card }).card
      // 只有 open 且待投递的版本才需要通道动作（updated 会把 delivery 重置成 pending）
      if (card.status !== 'open' || card.delivery !== 'pending') continue
      void deliver(card)
    }
  }

  /** 启动时补投：只处理 `delivery='pending'` 的 open 卡（已投递/失败的不重复打扰）。 */
  const backfill = (): void => {
    let pending: Card[]
    try {
      pending = store.query('cards.open').filter((card) => card.delivery === 'pending')
    } catch (error) {
      log(`补投查询失败：${errMsg(error)}`)
      return
    }
    for (const card of pending) void deliver(card)
  }

  const startAll = async (): Promise<void> => {
    if (started || stopping) return
    started = true
    for (const entry of entries) {
      const runtime: ChannelRuntime = {
        key: entry.key,
        abort: new AbortController(),
        handlers: new Set(),
        dispose: null,
        started: false,
      }
      runtimes.set(entry.key, runtime)
      const context: ChannelContext = {
        sdk: createSdk(sdkHost, entry.manifest),
        onCard: (handler) => {
          runtime.handlers.add(handler)
          return () => {
            runtime.handlers.delete(handler)
          }
        },
        delivered: (cardId, version, ref) =>
          Promise.resolve(reportDelivered(entry.key, cardId, version, ref)),
        answer: (cardId, optionIndex) => answer(cardId, optionIndex),
        signal: runtime.abort.signal,
      }
      try {
        runtime.dispose = await entry.plugin.start(context)
        runtime.started = true
      } catch (error) {
        // 单个通道启动失败只跳过它：其余通道照常投递
        log(`通道 ${entry.key} 启动失败，已跳过：${errMsg(error)}`)
        runtime.abort.abort()
        runtimes.delete(entry.key)
      }
    }
    backfill()
  }

  const stopAll = async (): Promise<void> => {
    if (!started && runtimes.size === 0) return
    stopping = true
    started = false
    const runtimesToStop = [...runtimes.values()]
    runtimes.clear()
    attempts.clear()
    inFlight.clear()
    deliveredVersions.clear()
    for (const runtime of runtimesToStop) {
      try {
        runtime.abort.abort()
      } catch {
        // abort 失败不阻塞退出
      }
    }
    for (const runtime of runtimesToStop) {
      if (runtime.dispose === null) continue
      try {
        await runtime.dispose()
      } catch (error) {
        log(`通道 ${runtime.key} dispose 失败（已忽略）：${errMsg(error)}`)
      }
    }
    stopping = false
  }

  const answer = async (cardId: string, optionIndex: number): Promise<void> => {
    // 命令幂等键带版本：同一张卡的重复回答在内核里是 conflict，不会覆盖既有回答
    const card = store.query('cards.open').find((item) => item.id === cardId)
    const version = card?.version ?? 0
    effects.dispatch({
      type: 'card.answer',
      commandId: `card:${cardId}:${version}`,
      cardId,
      optionIndex,
      via: 'channel',
    })
  }

  return {
    startAll,
    stopAll,
    dispatch: (facts) => {
      if (!started) return
      deliverFactCards(facts)
    },
    answer,
  }
}
