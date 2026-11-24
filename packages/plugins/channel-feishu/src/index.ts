/**
 * 飞书通道插件（`packages/plugins/channel-feishu/src/index.ts`）：只把**需要人拍板的事**推到飞书。
 *
 * 一句话：**需要你拍板的卡发到这里，点按钮就是答复；其余一律不打扰**。
 * 发送经本机 `lark-cli`，工作台不存 app 凭证、不开公网端口（长连接由 CLI 维护）。
 *
 * 打扰口径（与 `plugins/channels/desktop` 的那条同源）：只投 `kind === 'ask'`（缺列的老数据
 * 按「有没有选项」兜底）且仍 `open` 的卡——`notice`（只知会）一张都不发，终态只改「这条连接
 * 确实发过」的那条消息。工作台不做聊天，所以这里**没有入站**：不订阅 `im.message.receive_v1`、
 * 不 `submit`、不回帖进展，也没有「第一条私聊认人」这条零配置捷径——没有发送目标的连接只记
 * 一次日志、不投递。
 *
 * 卡片要带上下文（M54）：宿主随卡片给一份「项目 / 任务 / 会话 / 阶段 / 智能体」，渲染进卡片
 * 正文第一块（`render.ts` 的 `contextLines`）。没有它的卡在飞书里只有一句智能体写的标题——
 * 收到的人不知道该不该答、答的是哪件事。
 *
 * 多连接（M45）：一个工作台可以同时接**多个飞书应用 / 多套机器人**——每个连接一个
 * `lark-cli` profile、一份接收人与拍板人名单。于是「工作台助手」与别的 agent 的助手各走各的
 * 机器人：消息不混、事件长连接不抢（同一个飞书应用全局只允许一处 event bus）。连接配置为空时
 * 退化成原来的单连接行为（旧字段照旧生效）。
 *
 * 边界（SPEC-plugins「channel」）：
 * - 只读卡片、只回报 `delivered` / `answer`；不改卡片内容；
 * - 卡片正文 / 选项只作卡片 JSON 字段或 CLI 参数，整串作为参数 / stdin，不拼命令行；
 * - 任何一步失败只记日志（`sdk.log`，不记正文），不伪造送达、不影响其它通道与内核；
 * - **发群但没点名谁能拍板**的连接自己跳过（群里谁都能替你作答是不可接受的默认），不拖累
 *   同一通道的其它连接。
 *
 * 环境隔离（M45）：`lark-cli` 会按 `HERMES_HOME` / `OPENCLAW_HOME` 自动绑定到对方的工作区，
 * 通道因此显式剔除这些变量（`LARK_ENV_UNSET`）——不剔除就会和别的 agent 抢同一个应用。
 *
 * 稳定性：
 * - 同一个 `(cardId, version)` 每个连接只发一次（幂等键 + 进程内记录）；
 * - 后续版本与终态（answered / resolved）走 `im messages patch` 原地刷新：通道的 `ref` 是
 *   `{"<连接>": "<message_id>"}` 的 JSON，宿主原样存回（`Card.deliveryRefs`），重启后仍然
 *   知道每条连接该改哪条消息；
 * - 点击只回报答案，不自己决定卡片长什么样——渲染一律按宿主送回的卡片状态；
 * - 点击要配**这条连接当前版本**的消息：不是就算旧消息，只记日志；
 * - 监听进程退出后 30 s 重连（长连接断了不该让通道永久哑掉），dispose 后不再重连。
 */
import type { CardContext, ChannelContext, ChannelPlugin } from '@workbench/protocol/channels'
import type { Card } from '@workbench/protocol/entities'
import { readClick } from './click'
import { createLark, type Lark, type LarkTarget } from './lark'
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

/** 拍板人列表的上限（防御超长配置）。 */
const MAX_ANSWERERS = 50

/** 一个通道最多接多少个飞书连接（防御超长配置；正常用 1~3 个）。 */
export const MAX_CONNECTIONS = 8

/** 连接名长度上限（进 ref 聚合键，太长只会让日志难读）。 */
const CONNECTION_ID_LIMIT = 24

/** 重连定时器的类型别名（Node 与 DOM 的 setTimeout 返回值不同，这里只要 clearTimeout 认它）。 */
type StopTimer = ReturnType<typeof setTimeout>

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
  /** 允许拍板的 open_id（空 = 只认接收人） */
  answerers: string[]
}

/**
 * 读取配置：非法值一律按缺省处理（配置坏不该让通道不启动），
 * 只有「谁来拍板」判不出来时才不投递（见 `start`）。
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

/**
 * 一条飞书连接（M45）：一个 profile = 一个飞书应用 = 一个机器人 = 一条事件总线。
 *
 * `id` 进 `ref` 聚合键（`{"<id>": "<message_id>"}`），所以只允许短 slug；
 * 展示名（`label`）随便写，只用于日志与设置页。
 */
export interface FeishuConnection {
  /** 连接标识（短 slug，同一通道内唯一） */
  id: string
  /** 展示名（设置页可读；缺省取 id） */
  label: string
  /** 实际下发的 CLI 命令（`lark-cli` 或 `lark-cli --profile NAME`） */
  program: string
  /** lark-cli profile 名（空 = CLI 的当前 profile） */
  profile: string | null
  /** 私聊接收人 open_id */
  user: string | null
  /** 群 chat_id（优先于私聊） */
  chat: string | null
  /** 可拍板人 open_id 名单 */
  answerers: string[]
}

/**
 * profile 名只允许「字母数字下划线连字符点」，且**不能以 `-` 开头**：它要进 argv，
 * 以 `--` 开头的名字会被 CLI 当成参数（`--profile --evil` 就是注入别的 flag）。
 */
const PROFILE_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/

/** 连接 id 归一：小写、非法字符换成 `-`、去首尾 `-`、限长；空结果交给调用方兜底。 */
export function connectionIdOf(raw: string): string {
  const slug = raw
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CONNECTION_ID_LIMIT)
  return slug
}

/** 把 profile 拼进 CLI 命令（配置里已经写了 `--profile` 时以配置为准）。 */
export function programWithProfile(program: string, profile: string | null): string {
  if (profile === null) return program
  if (/(^|\s)--profile(\s|=)/u.test(program)) return program
  return `${program} --profile ${profile}`
}

/** 把一个可能是数组 / 逗号串的字段读成 open_id 列表。 */
function listOf(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? value.split(/[,，;；\s]+/)
      : []
  const unique = [...new Set(items.map((item) => item.trim()).filter((item) => item !== ''))]
  return unique.slice(0, MAX_ANSWERERS)
}

/** 对象里读一个非空字符串（数组 / 数字一律当没配）。 */
function fieldOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 解析 `connections` 配置：JSON 数组；不是数组 / 解析失败一律当「没配」。 */
export function parseConnections(raw: string | null): Record<string, unknown>[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  )
}

/**
 * 读取连接列表（M45）：`connections` 合法就用它，否则把旧字段当成唯一连接。
 *
 * - 非法 profile 名整条丢弃（它要进 argv，宁可少一条连接也不拼出别的参数）；
 * - 同名连接自动加后缀（`ref` 聚合键必须唯一，否则两条连接会互相覆盖消息引用）；
 * - 上限 `MAX_CONNECTIONS`；配置坏不该让通道不启动。
 */
export function readFeishuConnections(raw: Record<string, unknown>): FeishuConnection[] {
  const base = textOf(raw, 'lark') ?? 'lark-cli'
  const items = parseConnections(textOf(raw, 'connections'))
  const used = new Set<string>()
  const connections: FeishuConnection[] = []

  const claim = (wanted: string, index: number): string => {
    const base0 = connectionIdOf(wanted)
    let id = base0 === '' ? `c${index + 1}` : base0
    let suffix = 2
    while (used.has(id)) {
      id = `${base0 === '' ? `c${index + 1}` : base0}-${suffix}`
      suffix += 1
    }
    used.add(id)
    return id
  }

  for (const [index, item] of items.entries()) {
    if (connections.length >= MAX_CONNECTIONS) break
    const profile = fieldOf(item, 'profile')
    if (profile !== null && !PROFILE_PATTERN.test(profile)) continue
    const label = fieldOf(item, 'label') ?? fieldOf(item, 'name') ?? profile ?? `连接 ${index + 1}`
    const id = claim(
      fieldOf(item, 'id') ??
        fieldOf(item, 'name') ??
        profile ??
        fieldOf(item, 'label') ??
        `c${index + 1}`,
      index,
    )
    connections.push({
      id,
      label,
      program: programWithProfile(base, profile),
      profile,
      user: fieldOf(item, 'user'),
      chat: fieldOf(item, 'chat'),
      answerers: listOf(item['answerers']),
    })
  }

  if (connections.length > 0) return connections

  // 兼容旧配置（M42–M45）：`lark` / `user` / `chat` / `answerers` 就是唯一连接
  return [
    {
      id: 'default',
      label: '默认连接',
      program: base,
      profile: null,
      user: textOf(raw, 'user'),
      chat: textOf(raw, 'chat'),
      answerers: listOf(raw['answerers']),
    },
  ]
}

/** 连接配置 → 单连接配置形状（复用 `targetOf` / `answerersOf` 的判定口径）。 */
const configOfConnection = (conn: FeishuConnection): FeishuConfig => ({
  program: conn.program,
  user: conn.user,
  chat: conn.chat,
  answerers: conn.answerers,
})

/** 发到哪：配了群发群，否则发私聊（接收人取配置，未配置取登录人）。 */
export function targetOf(config: FeishuConfig, owner: string | null): LarkTarget | null {
  if (config.chat !== null) return { kind: 'chat', id: config.chat }
  if (config.user !== null) return { kind: 'user', id: config.user }
  return owner === null ? null : { kind: 'user', id: owner }
}

/**
 * 谁可以拍板：配了名单就用名单；否则只认接收人（配置的接收人 → CLI 登录人）。
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

/**
 * 解析宿主给回的聚合引用（`{"<连接>": "<message_id>"}`）。
 *
 * 解析不出来一律当「这条连接没发过」：宁可新发一条，也不拿别人的消息 id 去改一张卡。
 */
export function parseConnectionRefs(raw: string | null): Record<string, string> {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const refs: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') refs[key] = value
  }
  return refs
}

/** 一条连接在进程内的状态：它把哪张卡的哪一版发到了哪条消息。 */
interface ConnectionRuntime {
  conn: FeishuConnection
  lark: Lark
  /**
   * 卡片发到哪；`null` = 没有落点（既没配接收人 / 群，也没读到登录人）——
   * 这种连接照样启用，只是不投递（见 `deliverOne`，日志只记一次）。
   */
  target: LarkTarget | null
  /** 谁能拍板；空集 = 这条连接不投递（发群却没点名，见 `start`） */
  allowed: Set<string>
  /** cardId → 这条连接最近发出的 (version, message_id)：点击要靠它认「当前这一版」 */
  sent: Map<string, { version: number; ref: string }>
  /** 点击长连接的重连状态 */
  stream: { stop: (() => void) | null; timer: StopTimer | null }
  /** 「还没有落点」只提示一次，别每张卡刷一行日志 */
  warnedNoTarget: boolean
}

/**
 * 是否需要人拍板：`kind` 是内核建卡时写的判据，缺列的老数据按「有没有选项」兜底——
 * 与 `plugins/channels/desktop` 的 `needsAnswer` 同口径，两处各自判一次，
 * 免得把信息卡当提问发出去。
 */
const needsAnswer = (card: { kind?: string; options: string[] }): boolean =>
  card.kind === 'ask' ||
  card.kind === 'stall' ||
  (card.kind === undefined && card.options.length > 0)

/**
 * 没有对应消息时回报的投递引用：不需要拍板的卡与「从未发出过的终态卡」在飞书里**不落消息**，
 * 但投递语义是「已送达至少一个通道」，照样要 ack。形状与其他引用一致
 * （`{连接 id → message id}` 的空表），hub 只把它记进 `deliveryRefs`。
 */
const NO_MESSAGE_REFS = '{}'

/** 进程内已送达的卡片版本（同一版本重投不再打扰） */
interface SentMark {
  version: number
  ref: string
}

export const feishuChannel: ChannelPlugin = {
  async start(ctx: ChannelContext): Promise<() => void> {
    const raw = ctx.sdk.config<Record<string, unknown>>() ?? {}
    const connections = readFeishuConnections(raw)
    const owners: ConnectionRuntime[] = []

    for (const conn of connections) {
      const lark = createLark({
        sdk: ctx.sdk,
        program: conn.program,
        log: (line) => {
          ctx.sdk.log(`[${conn.id}] ${line}`)
        },
      })
      const config = configOfConnection(conn)
      // 私聊且没配接收人时，接收人就是这条连接 CLI 的登录人（auth status 读一次）。
      // 读不到也不当作错误：连接照样起来，只是没有落点（投递时记一次日志、不发送）。
      let owner = config.user
      if (config.chat === null && owner === null) owner = await lark.owner().catch(() => null)
      const target = targetOf(config, owner)
      const allowed = answerersOf(config, owner)
      // 只有「发到群里却没点名谁能拍板」才禁用整条连接：群里谁都能替你作答是不可接受的默认。
      // 「没有落点」不跳过：那种连接只是不发消息，不该整条消失。
      if (target !== null && allowed.length === 0) {
        ctx.sdk.log(`飞书连接「${conn.label}」发群但没配拍板人，跳过这条连接`)
        continue
      }
      owners.push({
        conn,
        lark,
        target,
        allowed: new Set(allowed),
        sent: new Map<string, SentMark>(),
        stream: { stop: null, timer: null },
        warnedNoTarget: false,
      })
    }

    if (owners.length === 0) {
      ctx.sdk.log('飞书通道没有可用的连接，不投递')
      return noopDispose
    }

    const remember = (runtime: ConnectionRuntime, card: Card, messageId: string): void => {
      runtime.sent.set(card.id, { version: card.version, ref: messageId })
    }

    /**
     * 给一条连接投递一张卡：`ref` 有值就原地更新，没有就是第一次发。
     *
     * 返回这条连接最终指向的消息 id；失败返回 `null`（调用方只记日志，不伪造送达）。
     * 终态更新失败（卡片超过 14 天 / 机器人不是发送者）不再新发：那张卡已经不等人了。
     */
    const deliverOne = async (
      runtime: ConnectionRuntime,
      card: Card,
      json: string,
      known: string | null,
    ): Promise<string | null> => {
      const { conn } = runtime
      // 还没有落点（没配接收人 / 群，也没读到登录人）：这次不发，日志只记一次。
      if (runtime.target === null) {
        if (!runtime.warnedNoTarget) {
          runtime.warnedNoTarget = true
          ctx.sdk.log(
            `飞书连接「${conn.id}」还没有发送目标：先在设置里填接收人或群，否则拍板卡发不出去`,
          )
        }
        return null
      }
      const target = runtime.target
      if (known !== null) {
        try {
          await runtime.lark.patch(known, json)
          remember(runtime, card, known)
          return known
        } catch (error) {
          if (card.status !== 'open') {
            ctx.sdk.log(
              `飞书卡片终态更新失败（连接 ${conn.id}，卡片 ${card.id} v${card.version} ${card.status}）：${errMsg(error)}`,
            )
            return known
          }
          // 卡片超过 14 天 / 机器人不是发送者时平台会拒绝更新：新发一条比留在旧版本强
          ctx.sdk.log(
            `飞书卡片更新失败（连接 ${conn.id}，卡片 ${card.id} v${card.version}），改为新发：${errMsg(error)}`,
          )
        }
      }
      const messageId = await runtime.lark.send(target, json, idempotencyKeyOf(card))
      remember(runtime, card, messageId)
      return messageId
    }

    /**
     * 投递一个版本 / 一种状态：逐条连接发或改，最后把**成功的引用**聚合成一个 JSON 交给宿主。
     *
     * 一条连接失败不该抹掉另一条已经发出去的消息，所以 ref 按连接记账；全部失败才不回报
     * （宿主按超时走重投）。
     */
    const deliver = async (
      card: Card,
      ref: string | null,
      context: CardContext | null,
    ): Promise<void> => {
      const json = JSON.stringify(renderCard(card, context))
      const previous = parseConnectionRefs(ref)
      const next: Record<string, string> = {}
      let delivered = false
      /** 有条连接真的该动这张卡（终态卡从未发过的连接直接跳过，见下） */
      let claimed = false
      for (const runtime of owners) {
        const { conn } = runtime
        const known = previous[conn.id] ?? runtime.sent.get(card.id)?.ref ?? null
        // 终态只改「这条连接确实发过」的那条消息：没发过就别在飞书里凭空多一张卡
        if (card.status !== 'open' && known === null) continue
        claimed = true
        try {
          const messageId = await deliverOne(runtime, card, json, known)
          if (messageId !== null) {
            next[conn.id] = messageId
            delivered = true
          }
        } catch (error) {
          ctx.sdk.log(
            `飞书投递失败（连接 ${conn.id}，卡片 ${card.id} v${card.version}）：${errMsg(error)}`,
          )
          if (known !== null) next[conn.id] = known
        }
      }
      if (!delivered) {
        // 没有一条连接该动这张卡：照旧 ack 送达（in-app 投影已经能看到它），但不落消息。
        // 发过却全失败的不 ack —— 宿主按重投曲线再来。
        if (!claimed) await ctx.delivered(card.id, card.version, NO_MESSAGE_REFS)
        return
      }
      try {
        await ctx.delivered(card.id, card.version, JSON.stringify(next))
      } catch (error) {
        ctx.sdk.log(`飞书投递回报失败（卡片 ${card.id} v${card.version}）：${errMsg(error)}`)
      }
    }

    /**
     * 点击：只回报答案，卡片长什么样交给宿主送回来的卡片状态。
     *
     * 校验「点的是这条连接当前版本的那条消息」由通道自己做（聚合 ref 没法逐连接比对）：
     * 卡片后来更新过版本时，旧消息上的点击不计入（答案必须配当前这一版问题）。
     */
    const answer = async (
      runtime: ConnectionRuntime,
      event: Record<string, unknown>,
    ): Promise<void> => {
      const clicked = readClick(event)
      if (clicked === null) return
      const { conn } = runtime
      if (!runtime.allowed.has(clicked.operator)) {
        ctx.sdk.log(`飞书点击被忽略（连接 ${conn.id}，卡片 ${clicked.cardId}）：操作人不在名单`)
        return
      }
      const own = runtime.sent.get(clicked.cardId)
      if (own === undefined || clicked.messageId === undefined || own.ref !== clicked.messageId) {
        ctx.sdk.log(
          `飞书点击被忽略（连接 ${conn.id}，卡片 ${clicked.cardId}）：不是当前版本的那条消息`,
        )
        return
      }
      try {
        const outcome = await ctx.answer(
          clicked.cardId,
          clicked.choice,
          undefined,
          clicked.operator,
        )
        ctx.sdk.log(
          outcome.changed
            ? `飞书点击已计入（连接 ${conn.id}，卡片 ${clicked.cardId}，${clicked.operator}）`
            : `飞书点击未计入（连接 ${conn.id}，卡片 ${clicked.cardId} 已是 ${outcome.status}）`,
        )
      } catch (error) {
        // 宿主回调抛错（不该发生，但通道不能因此变成一条未处理的 rejection）
        ctx.sdk.log(`飞书点击未计入（连接 ${conn.id}，卡片 ${clicked.cardId}）：${errMsg(error)}`)
      }
    }

    let disposed = false

    /**
     * 监听进程退出：等固定间隔再起一个（长连接断了不该让通道永久哑掉）。
     *
     * 「停用之后不再重连」由监听器自己的 stopped 守卫保证（stop 之后它不再回报退出），
     * 这里不重复判一次——重复守卫是第二位真相源，只会让「谁负责不重连」变得含糊。
     */
    const restartLater = (runtime: ConnectionRuntime, reason: string): void => {
      if (disposed) return
      const stream = runtime.stream
      if (stream.timer !== null) return
      ctx.sdk.log(
        `飞书连接 ${runtime.conn.id} 的点击监听中断（${reason}）；${Math.round(WATCH_RESTART_MS / 1000)} 秒后重连`,
      )
      stream.timer = setTimeout(() => {
        stream.timer = null
        startStream(runtime)
      }, WATCH_RESTART_MS)
    }

    const startStream = (runtime: ConnectionRuntime): void => {
      runtime.stream.stop = runtime.lark.watchClicks(
        (event) => {
          void answer(runtime, event)
        },
        (reason) => {
          restartLater(runtime, reason)
        },
      )
    }

    /**
     * 只推需要拍板的卡：`notice`（只知会）与老的无选项信息卡一张都不发——IM 里没有「通知栏」
     * 可落，工作台里已经能看到它。每种状态都照样 ack：投递语义是「已送达至少一个通道」。
     */
    const off = ctx.onCard((card, ref, context) => {
      if (!needsAnswer(card)) {
        void ctx.delivered(card.id, card.version, NO_MESSAGE_REFS)
        return
      }
      void deliver(card, ref, context)
    })

    for (const runtime of owners) startStream(runtime)

    const dispose = (): void => {
      if (disposed) return
      disposed = true
      off()
      for (const runtime of owners) {
        const stream = runtime.stream
        if (stream.timer !== null) clearTimeout(stream.timer)
        stream.timer = null
        stream.stop?.()
        stream.stop = null
        runtime.sent.clear()
      }
      ctx.signal.removeEventListener('abort', dispose)
    }
    ctx.signal.addEventListener('abort', dispose, { once: true })
    if (ctx.signal.aborted) dispose()
    return dispose
  },
}
