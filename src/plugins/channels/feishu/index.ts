/**
 * 飞书通道插件（`src/plugins/channels/feishu/index.ts`）：IM 接入的第一个平台。
 *
 * 一句话：**卡片进飞书，点按钮就是答案；卡片的每次变化都回到同一条消息上**。
 * 收发都经本机 `lark-cli`，工作台不存 app 凭证、不开公网端口（长连接由 CLI 维护）。
 *
 * 边界（SPEC-plugins「channel」）：
 * - 只读卡片、只回报 `delivered` / `answer`；不改卡片内容、不改派活；
 * - 卡片正文只作卡片 JSON 的字段值，整串作为 `lark-cli` 的参数 / stdin，不拼命令行；
 * - 任何一步失败只记日志（`sdk.log`，不记正文），不伪造送达、不影响其它通道与内核；
 * - 未登录 / 没配可答复人 / 没有 lark-cli 时**不投递**（`start` 返回 no-op dispose）。
 *
 * 稳定性：
 * - 同一个 `(cardId, version)` 只发一次（hub 的 2 s 投递超时后重投不会刷出第二条消息）；
 * - 后续版本与终态（answered / resolved）走 `im messages patch` 原地刷新：`ref` 由宿主按
 *   通道持久化在卡片行上（`Card.deliveryRefs`），重启后仍然知道该改哪条消息（M43）；
 * - 点击只回报答案，不再自己决定卡片长什么样——渲染一律按宿主送回的卡片状态，
 *   于是「在飞书答的」与「在工作台答的」看起来一致；
 * - 点击监听进程退出后 30 s 重连（长连接断了不该让通道永久哑掉），dispose 后不再重连。
 */
import type { ChannelContext, ChannelPlugin } from '../../../protocol/channels'
import type { Card } from '../../../protocol/entities'
import { readClick } from './click'
import { createLark, type LarkTarget } from './lark'
import { renderCard } from './render'

export { feishuManifest } from './manifest'

/**
 * 点击监听中断后的重连间隔（毫秒）。
 *
 * 长连接断开要能自愈；但**同一飞书应用全局只允许一处 event bus**（另一个程序占着时
 * `lark-cli` 会以 `failed_precondition` 退出），所以间隔取 30 s：既能在占用方退出后接管，
 * 又不会把日志刷成每 10 秒一条。
 */
export const WATCH_RESTART_MS = 30_000

/** `--idempotency-key` 的上限是 50 字符（平台约束）。 */
const IDEMPOTENCY_KEY_LIMIT = 50

/** 可答复人列表的上限（防御超长配置）。 */
const MAX_ANSWERERS = 50

/** 未就绪时的 dispose：通道本来就不投递，调用无副作用且可重复。 */
const noopDispose = (): void => undefined

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 读一个字符串配置项：非字符串 / 空白一律当「没配」。 */
const textOf = (raw: Record<string, unknown>, key: string): string | null => {
  const value = raw[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 归一化后的通道配置。 */
export interface FeishuConfig {
  /** lark-cli 命令名或绝对路径 */
  program: string
  /** 私聊接收人 open_id（未配置时取 CLI 当前登录人） */
  user: string | null
  /** 群 chat_id（配置了优先发群） */
  chat: string | null
  /** 允许答复的 open_id（空 = 只认接收人） */
  answerers: string[]
}

/**
 * 读取配置：非法值一律按缺省处理（配置坏不该让通道不启动），
 * 只有「谁来答复」判不出来时才不投递（见 `start`）。
 */
export function readFeishuConfig(raw: Record<string, unknown>): FeishuConfig {
  const answerers = (textOf(raw, 'answerers') ?? '')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return {
    program: textOf(raw, 'lark') ?? 'lark-cli',
    user: textOf(raw, 'user'),
    chat: textOf(raw, 'chat'),
    answerers: [...new Set(answerers)].slice(0, MAX_ANSWERERS),
  }
}

/** 发到哪：配了群发群，否则发私聊（接收人取配置，未配置取登录人）。 */
export function targetOf(config: FeishuConfig, owner: string | null): LarkTarget | null {
  if (config.chat !== null) return { kind: 'chat', id: config.chat }
  if (config.user !== null) return { kind: 'user', id: config.user }
  return owner === null ? null : { kind: 'user', id: owner }
}

/**
 * 谁可以答复：配了名单就用名单；否则只认接收人（配置的接收人 → CLI 登录人）。
 * 发到群里又没配名单 = 空集合 → 通道不投递（群里任何人都替你作答是不可接受的默认）。
 */
export function answerersOf(config: FeishuConfig, owner: string | null): string[] {
  if (config.answerers.length > 0) return config.answerers
  const single = config.chat === null ? (config.user ?? owner) : owner
  return single === null ? [] : [single]
}

/** 幂等键：`wb-<cardId>-v<version>`，超长截断（平台上限 50 字符）。 */
export function idempotencyKeyOf(card: { id: string; version: number }): string {
  const raw = `wb-${card.id}-v${card.version}`
  return raw.length <= IDEMPOTENCY_KEY_LIMIT ? raw : raw.slice(0, IDEMPOTENCY_KEY_LIMIT)
}

export const feishuChannel: ChannelPlugin = {
  async start(ctx: ChannelContext): Promise<() => void> {
    const config = readFeishuConfig(ctx.sdk.config<Record<string, unknown>>() ?? {})
    const lark = createLark({
      sdk: ctx.sdk,
      program: config.program,
      log: (line) => {
        ctx.sdk.log(line)
      },
    })

    // 私聊且没配接收人时，接收人就是 CLI 的登录人（auth status 读一次）
    let owner: string | null = config.user
    if (config.chat === null && owner === null) {
      try {
        owner = await lark.owner()
      } catch (error) {
        ctx.sdk.log(`飞书通道未就绪（${errMsg(error)}），不投递`)
        return noopDispose
      }
    }

    const target = targetOf(config, owner)
    const allowed = answerersOf(config, owner)
    if (target === null || allowed.length === 0) {
      ctx.sdk.log('飞书通道未配置接收人（user / chat / answerers 至少要有一处），不投递')
      return noopDispose
    }
    const answererSet = new Set(allowed)

    /**
     * cardId → 这个进程里已经发出去的那条消息。
     *
     * 宿主的 `ref` 是权威（重启后仍然知道该改哪条），这里是**进程内的第二道保险**：
     * hub 在投递超时后重投同一版本时，宿主还没记下 message id，这里用上次的引用原地更新，
     * 不去依赖平台的幂等键兜底。
     */
    const sent = new Map<string, { version: number; ref: string }>()

    const refOf = (card: Card, ref: string | null): string | null => {
      if (ref !== null) return ref
      const own = sent.get(card.id)
      return own !== undefined && own.version <= card.version ? own.ref : null
    }

    const remember = (card: Card, messageId: string): void => {
      sent.set(card.id, { version: card.version, ref: messageId })
    }

    /**
     * 投递一个版本 / 一种状态：`ref` 有值就是「这个通道发过这张卡」，原地更新；
     * 没有就是第一次发（幂等键保证重投不会刷出第二条消息）。
     *
     * 终态更新失败（卡片超过 14 天 / 机器人不是发送者）只记日志：那张卡已经不等人了，
     * 再新发一条「已答复」只会多一条噪音。
     */
    const deliver = async (card: Card, ref: string | null): Promise<void> => {
      const json = JSON.stringify(renderCard(card))
      const known = refOf(card, ref)
      try {
        if (known === null) {
          const messageId = await lark.send(target, json, idempotencyKeyOf(card))
          remember(card, messageId)
          await ctx.delivered(card.id, card.version, messageId)
          return
        }
        try {
          await lark.patch(known, json)
        } catch (error) {
          if (card.status !== 'open') {
            ctx.sdk.log(
              `飞书卡片终态更新失败（${card.id} v${card.version} ${card.status}）：${errMsg(error)}`,
            )
            return
          }
          // 卡片超过 14 天 / 机器人不是发送者时平台会拒绝更新：新发一条比留在旧版本强
          ctx.sdk.log(`飞书卡片更新失败（${card.id} v${card.version}），改为新发：${errMsg(error)}`)
          const messageId = await lark.send(target, json, idempotencyKeyOf(card))
          remember(card, messageId)
          await ctx.delivered(card.id, card.version, messageId)
          return
        }
        remember(card, known)
        await ctx.delivered(card.id, card.version, known)
      } catch (error) {
        ctx.sdk.log(`飞书投递失败（卡片 ${card.id} v${card.version}）：${errMsg(error)}`)
      }
    }

    /**
     * 点击：只回报答案，卡片长什么样交给宿主送回来的卡片状态。
     *
     * `ref` 一起带过去，宿主据此确认「点的是这个通道发出去的那条消息」——卡片后来更新过
     * 版本时，旧消息上的点击不计入（答案必须配当前这一版问题）。
     */
    const answer = async (event: Record<string, unknown>): Promise<void> => {
      const clicked = readClick(event)
      if (clicked === null) return
      if (!answererSet.has(clicked.operator)) {
        ctx.sdk.log(
          `飞书点击被忽略（卡片 ${clicked.cardId}）：${clicked.operator} 不在可答复人名单`,
        )
        return
      }
      try {
        const outcome = await ctx.answer(
          clicked.cardId,
          clicked.choice,
          clicked.messageId ?? undefined,
          clicked.operator,
        )
        ctx.sdk.log(
          outcome.changed
            ? `飞书点击已计入（卡片 ${clicked.cardId}，${clicked.operator}）`
            : `飞书点击未计入（卡片 ${clicked.cardId} 已是 ${outcome.status}，或点的是旧消息）`,
        )
      } catch (error) {
        // 宿主回调抛错（不该发生，但通道不能因此变成一条未处理的 rejection）
        ctx.sdk.log(`飞书点击未计入（卡片 ${clicked.cardId}）：${errMsg(error)}`)
      }
    }

    let stopWatch: (() => void) | null = null
    let restartTimer: ReturnType<typeof setTimeout> | null = null

    /**
     * 监听进程退出：等固定间隔再起一个（长连接断了不该让通道永久哑掉）。
     *
     * 「停用之后不再重连」由 `watchClicks` 自己的 stopped 守卫保证（stop 之后它不再回报退出），
     * 这里不重复判一次——重复守卫是第二位真相源，只会让「谁负责不重连」变得含糊。
     */
    const restartLater = (reason: string): void => {
      ctx.sdk.log(`飞书点击监听中断（${reason}）；${Math.round(WATCH_RESTART_MS / 1000)} 秒后重连`)
      restartTimer = setTimeout(() => {
        restartTimer = null
        startWatch()
      }, WATCH_RESTART_MS)
    }

    const startWatch = (): void => {
      stopWatch = lark.watchClicks((event) => {
        void answer(event)
      }, restartLater)
    }

    const off = ctx.onCard((card, ref) => {
      void deliver(card, ref)
    })
    startWatch()

    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      off()
      if (restartTimer !== null) clearTimeout(restartTimer)
      restartTimer = null
      stopWatch?.()
      stopWatch = null
      sent.clear()
      ctx.signal.removeEventListener('abort', dispose)
    }
    ctx.signal.addEventListener('abort', dispose, { once: true })
    if (ctx.signal.aborted) dispose()
    return dispose
  },
}
