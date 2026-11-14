/**
 * 通道宿主 hub（M4 D9/D10；M43 按通道记账）：注册、启停、卡片投递、补投与回答。
 *
 * 职责边界：
 * - **只读卡片、只回写投递/回答**：内容与派活由内核决定，通道插件不写库（只能经回调
 *   让 hub 走 `effects.dispatch` → `decide` → 事实）；
 * - **fire-and-forget**：`dispatch(facts)` 同步返回，投递在微任务里异步进行；单通道
 *   异常/超时被隔离，绝不影响写路径返回值；
 * - **投递顺序 = registry 顺序**：依次尝试；每个通道**各自**写一条 `card.delivered`，
 *   投递记录按 `(通道, 卡片, 版本)` 记在 `Card.deliveryRefs` 上；
 * - **状态变化回到原消息（M43）**：`card.answered` / `card.resolved` 也会投给「发过这张卡、
 *   但还停在旧状态」的通道——通道拿 `ref` 原地更新，于是 IM 里那张卡不会永远带按钮；
 * - **幂等**：同一 `(通道, 卡片, 版本, 状态)` 进程内只投一次；重启后只补 open 卡里该通道
 *   还没同步的版本与状态；
 * - **启停**：`startAll` 建 AbortController 并逐通道 `start`（单个失败只跳过该通道），
 *   随后补投；`stopAll` abort + best-effort dispose，可重复调用。
 *
 * `answer` 走既有写入口（`commandId='card:<cardId>:<version>'`，`via:'channel'`），返回
 * `{ changed, status }`：已经不在等你的卡不再抛错，通道据此把那张卡刷成终态并在日志里说清。
 */
import type { Card } from '../protocol/entities'
import type { ChannelAnswerOutcome, ChannelContext } from '../protocol/channels'
import type { Fact, Iso } from '../kernel/core/types'
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
  /** 按通道合并后的配置（M7：manifest 默认值 + 用户设置；缺省返回空对象） */
  configOf?: (entry: ChannelRegistryEntry) => Record<string, unknown>
  /** 是否启用该通道（M7：用户关闭的通道不启动；缺省全部启用） */
  isEnabled?: (entry: ChannelRegistryEntry) => boolean
}

export interface Channels {
  startAll(): Promise<void>
  stopAll(): Promise<void>
  /** 提交后分发：只处理 `card.opened` / `card.updated` / `card.answered` / `card.resolved` */
  dispatch(facts: readonly Fact[]): void
  /**
   * 通道侧回答：发 `card.answer{via:'channel'}`。
   *
   * `ref` 是通道侧那条消息的引用（M43）：这个通道发过这张卡、但 ref 不是它时说明点的是
   * 旧消息，不计入。返回 `{ changed, status }`，内核不接受时 `changed=false`（不抛错）。
   */
  answer(cardId: string, optionIndex: number, ref?: string): Promise<ChannelAnswerOutcome>
}

/** 单通道单次投递的默认超时（D9：慢通道不拖住其它通道与写路径）。 */
const DEFAULT_CHANNEL_TIMEOUT_MS = 2_000

/** 投递全失败时写进 `card.delivery_failed` 的文案（不拼卡片正文）。 */
const DELIVERY_FAILED_ERROR = '所有通道投递失败或超时'

/** 需要交给通道的卡片事实：新卡、新版本，以及「已答 / 已关」的终态回写（M43）。 */
const CARD_FACT_TYPES: ReadonlySet<string> = new Set([
  'card.opened',
  'card.updated',
  'card.answered',
  'card.resolved',
])

interface ChannelRuntime {
  key: string
  abort: AbortController
  handlers: Set<(card: Card, ref: string | null) => void>
  dispose: (() => void) | null
  /** start 成功后才参与投递 */
  started: boolean
}

/** 一次投递尝试的等待键：`通道|卡片:版本:状态`（状态也要算，终态与 open 同版本）。 */
const attemptKey = (
  channelKey: string,
  cardId: string,
  version: number,
  status: Card['status'],
): string => `${channelKey}|${cardId}:${version}:${status}`

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 这个通道这一轮该做什么（M43）：
 *
 * - 卡片 open：没发过 / 版本变了 → 发（有 ref 就原地更新）；
 * - 卡片已答或已关：**只在「这个通道确实发过、且还停在旧版本或旧状态」时**补一次终态，
 *   从未发过的通道不必知道「已经答复了」；
 * - 投递预算用尽（`deliveryGivenUp`）且这个通道从没收到过 → 不再打扰。
 */
export function planFor(card: Card, channelKey: string): { send: boolean; ref: string | null } {
  const own = card.deliveryRefs?.[channelKey]
  const synced = own !== undefined && own.version === card.version && own.status === card.status
  if (card.status !== 'open') {
    return { send: own !== undefined && !synced, ref: own?.ref ?? null }
  }
  if (synced) return { send: false, ref: own.ref }
  if (own === undefined && card.deliveryGivenUp) return { send: false, ref: null }
  return { send: true, ref: own?.ref ?? null }
}

export function createChannels(options: ChannelsOptions): Channels {
  const { store, effects, entries, sdkHost } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS

  const runtimes = new Map<string, ChannelRuntime>()
  /** 正在等待某通道 ack 的投递；key = 通道|卡片:版本:状态 */
  const attempts = new Map<string, (ref: string) => void>()
  /** 已经送达过的 (通道, 版本, 状态)（进程内去重；重启后靠补投续上） */
  const deliveredKeys = new Set<string>()
  /** 最近一次投给通道的卡片快照：晚到 ack 要靠它判断「这张卡现在什么状态」 */
  const lastCards = new Map<string, Card>()
  const inFlight = new Set<string>()
  /** M41 已排期的重投定时器（stopAll 时统一清掉，避免退出后还投一次）。 */
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  let started = false
  let stopping = false

  const log = (line: string): void => {
    try {
      sdkHost.log(`[channels] ${line}`)
    } catch {
      // 日志失败不影响投递
    }
  }

  /**
   * 写事实：统一经 effects.dispatch（→ decide → 事实），异常自捕获。
   * 返回本次产生的事实：M41 的重投时刻由内核写在 `card.delivery_failed.payload.card` 里，
   * hub 只负责照它排期（不自己算曲线，也不重复内核的账）。
   */
  const write = (input: Record<string, unknown>): Fact[] => {
    try {
      return effects.dispatch(input).facts
    } catch (error) {
      log(`投递回写失败（${String(input['type'])}）：${errMsg(error)}`)
      return []
    }
  }

  /** 记一条「这个通道已送达」的事实；同一 (通道, 版本, 状态) 只写一次。 */
  const markDelivered = (card: Card, channelKey: string, ref: string): Fact[] => {
    const key = attemptKey(channelKey, card.id, card.version, card.status)
    if (deliveredKeys.has(key)) return []
    deliveredKeys.add(key)
    return write({
      type: 'card.delivered',
      cardId: card.id,
      version: card.version,
      channel: channelKey,
      ref,
    })
  }

  const markFailed = (card: Card, channelKey: string): Fact[] =>
    write({
      type: 'card.delivery_failed',
      cardId: card.id,
      version: card.version,
      channel: channelKey,
      error: DELIVERY_FAILED_ERROR,
    })

  /** 当前时刻（毫秒）：宿主注入的 `now` 优先，测试与生产同一口径。 */
  const nowMs = (): number => (options.now === undefined ? Date.now() : Date.parse(options.now()))

  /** 按内核给的 `nextDeliveryAt` 排一次重投；时刻已过就立刻投。 */
  const arm = (card: Card, atIso: string | null): void => {
    if (atIso === null) return
    const delay = Math.max(0, Date.parse(atIso) - nowMs())
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      void deliver(card)
    }, delay)
    retryTimers.add(timer)
  }

  /** 失败回写之后：读内核算出的下一次重投时刻，排上；放弃（null）就不排。 */
  const armFromFacts = (card: Card, facts: readonly Fact[]): void => {
    const failed = facts.find((fact) => fact.type === 'card.delivery_failed')
    if (failed === undefined) return
    const next = (failed.payload as { card?: Card }).card ?? card
    arm(next, next.nextDeliveryAt)
  }

  /**
   * 通道调用 `delivered` 的入口：命中等待中的投递就唤醒它（写事实由投递循环统一做）；
   * 没有等待者（超时后晚到的 ack）时按最近一次投给它的卡片补记——同一 (通道, 版本, 状态)
   * 只记一次，不会重复记账。
   */
  const reportDelivered = (
    channelKey: string,
    cardId: string,
    version: number,
    ref: string,
  ): void => {
    const known = lastCards.get(cardId)
    const status: Card['status'] =
      known !== undefined && known.version === version ? known.status : 'open'
    const waiter = attempts.get(attemptKey(channelKey, cardId, version, status))
    if (waiter !== undefined) {
      waiter(ref)
      return
    }
    if (known === undefined || known.version !== version) return
    markDelivered(known, channelKey, ref)
  }

  /**
   * 尝试一个通道：调用其全部 onCard 订阅者，等待 `delivered` 或超时/抛错。
   * 返回 ack 的 ref；超时/无订阅者/抛错返回 null。**这里不写事实**——写不写由投递循环决定。
   */
  const attempt = (
    runtime: ChannelRuntime,
    card: Card,
    ref: string | null,
  ): Promise<string | null> => {
    if (runtime.handlers.size === 0) return Promise.resolve(null)
    const key = attemptKey(runtime.key, card.id, card.version, card.status)
    return new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (ack: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        attempts.delete(key)
        resolve(ack)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      attempts.set(key, (ack) => finish(ack))
      try {
        // 通道插件可能异步完成投递；这里只负责把卡片与它自己的 ref 交给它。
        for (const handler of runtime.handlers) handler(card, ref)
      } catch (error) {
        log(`通道 ${runtime.key} 分发失败：${errMsg(error)}`)
        finish(null)
      }
    })
  }

  /**
   * 向所有已启动通道各投一次（registry 顺序），**不在首个成功后 break**：
   * 每个通道都要知道这张卡（in-app 投影、桌面通知、IM 消息各自独立）。
   *
   * 同一 `(卡片, 版本)` 进程内只跑一轮（inFlight 去重）；每个通道 succeed 后写一条
   * `card.delivered{channel}`；**全部**通道都没成功才写 `card.delivery_failed`（聚合口径），
   * 并照内核给的重投时刻排期。
   */
  const deliver = async (card: Card): Promise<void> => {
    // 状态也算进「同一轮」：卡片在投递途中被回答时，终态那一轮不能被进行中的 open 轮挡掉
    const key = attemptKey('*', card.id, card.version, card.status)
    if (inFlight.has(key)) return
    if (![...runtimes.values()].some((runtime) => runtime.started)) return
    const plans: { entry: ChannelRegistryEntry; runtime: ChannelRuntime; ref: string | null }[] = []
    for (const entry of entries) {
      const runtime = runtimes.get(entry.key)
      if (runtime === undefined || !runtime.started) continue
      // 进程内已经投过这个 (通道, 版本, 状态)：不重复打扰（重启后靠卡片行上的 ref 续上）
      if (deliveredKeys.has(attemptKey(entry.key, card.id, card.version, card.status))) continue
      const plan = planFor(card, entry.key)
      if (!plan.send) continue
      plans.push({ entry, runtime, ref: plan.ref })
    }
    if (plans.length === 0) return
    inFlight.add(key)
    lastCards.set(card.id, card)
    let delivered = false
    let failedChannel: string | null = null
    try {
      for (const plan of plans) {
        const ack = await attempt(plan.runtime, card, plan.ref)
        if (ack === null) {
          failedChannel = plan.entry.key
          log(`通道 ${plan.entry.key} 未确认（卡片 ${card.id} v${card.version} ${card.status}）`)
          continue
        }
        markDelivered(card, plan.entry.key, ack)
        delivered = true
        log(`通道 ${plan.entry.key} 已送达（卡片 ${card.id} v${card.version} ${card.status}）`)
      }
    } finally {
      inFlight.delete(key)
    }
    // 全部失败才推进重投曲线；终态回写失败不排期（卡已经不等人了）
    if (!delivered && failedChannel !== null && card.status === 'open') {
      armFromFacts(card, markFailed(card, failedChannel))
    }
  }

  const deliverFactCards = (facts: readonly Fact[]): void => {
    const seen = new Set<string>()
    for (const fact of facts) {
      if (!CARD_FACT_TYPES.has(fact.type)) continue
      const card = (fact.payload as { card?: Card }).card
      if (card === undefined) continue
      // 同一批事实里同一条卡（同版本同状态）只投一轮
      const key = attemptKey('*', card.id, card.version, card.status)
      if (seen.has(key)) continue
      seen.add(key)
      void deliver(card)
    }
  }

  /**
   * 启动时补投：`cards.open` 里每个通道还没同步的版本/状态立刻投；失败未放弃的卡按
   * `nextDeliveryAt` 续上（已过立刻投、未到排期）。
   *
   * 已知边界（M43）：进程重启后**不补已经 answered / resolved 的旧消息**——那需要按通道
   * 反查全部历史卡片，代价大于收益；此时旧消息再被点会被内核拒绝（`changed=false`）。
   */
  const backfill = (): void => {
    let cards: Card[]
    try {
      cards = store.query('cards.open')
    } catch (error) {
      log(`补投查询失败：${errMsg(error)}`)
      return
    }
    const now = nowMs()
    for (const card of cards) {
      if (
        card.delivery === 'failed' &&
        card.nextDeliveryAt !== null &&
        Date.parse(card.nextDeliveryAt) > now
      ) {
        arm(card, card.nextDeliveryAt)
        continue
      }
      void deliver(card)
    }
  }

  const startAll = async (): Promise<void> => {
    if (started || stopping) return
    started = true
    for (const entry of entries) {
      // M7：用户停用的通道不启动（保持 registry 顺序，不影响其它通道）
      if (options.isEnabled !== undefined && !options.isEnabled(entry)) continue
      const runtime: ChannelRuntime = {
        key: entry.key,
        abort: new AbortController(),
        handlers: new Set(),
        dispose: null,
        started: false,
      }
      runtimes.set(entry.key, runtime)
      const channelHost: SdkHost = {
        ...sdkHost,
        // 每条通道只拿到自己的配置（不读别人的 config，也拿不到 secret 明文以外的设置）
        config: <T = Record<string, unknown>>() => (options.configOf?.(entry) ?? {}) as T,
      }
      const context: ChannelContext = {
        sdk: createSdk(channelHost, entry.manifest),
        onCard: (handler) => {
          runtime.handlers.add(handler)
          return () => {
            runtime.handlers.delete(handler)
          }
        },
        delivered: (cardId, version, ref) =>
          Promise.resolve(reportDelivered(entry.key, cardId, version, ref)),
        answer: (cardId, optionIndex, ref, byRef) =>
          answer(entry.key, cardId, optionIndex, ref, byRef),
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
    deliveredKeys.clear()
    lastCards.clear()
    // M41：已排期的重投一并取消，退出后不再产生投递
    for (const timer of retryTimers) clearTimeout(timer)
    retryTimers.clear()
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

  const answer = async (
    channelKey: string | null,
    cardId: string,
    optionIndex: number,
    ref?: string,
    byRef?: string,
  ): Promise<ChannelAnswerOutcome> => {
    const card = store.query('cards.open').find((item) => item.id === cardId)
    // 不在 open 里 = 已被别处答复 / 已关闭：不抛错，告诉通道「已经 settled」
    if (card === undefined) return { changed: false, status: 'resolved' }
    const own = channelKey === null ? undefined : card.deliveryRefs?.[channelKey]
    // 旧消息（卡片后来更新过，消息引用对不上）的点击不计入：答案必须配当前这一版问题
    if (channelKey !== null && ref !== undefined && own !== undefined && own.ref !== ref) {
      log(`通道 ${channelKey} 的点击来自旧消息（卡片 ${cardId}），不计入`)
      return { changed: false, status: card.status }
    }
    try {
      // 命令幂等键带版本：同一张卡的重复回答在内核里是 conflict，不会覆盖既有回答
      effects.dispatch({
        type: 'card.answer',
        commandId: `card:${cardId}:${card.version}`,
        cardId,
        optionIndex,
        via: 'channel',
        ...(byRef === undefined || byRef.trim() === '' ? {} : { byRef }),
      })
    } catch (error) {
      // 内核拒绝（run 已不在等待 / 下标非法）：卡片状态以内核为准，通道只记日志
      log(`通道 ${channelKey ?? 'unknown'} 的回答未被接受（卡片 ${cardId}）：${errMsg(error)}`)
      return { changed: false, status: card.status }
    }
    return { changed: true, status: 'answered' }
  }

  return {
    startAll,
    stopAll,
    dispatch: (facts) => {
      if (!started) return
      deliverFactCards(facts)
    },
    answer: (cardId, optionIndex, ref) => answer(null, cardId, optionIndex, ref),
  }
}
