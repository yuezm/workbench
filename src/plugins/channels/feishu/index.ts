/**
 * 飞书通道插件（`src/plugins/channels/feishu/index.ts`）：IM 接入的第一个平台。
 *
 * 一句话：**卡片进飞书，点按钮就是答案；私聊发一句话就是派活，进展回帖到那句话下面**。
 * 收发都经本机 `lark-cli`，工作台不存 app 凭证、不开公网端口（长连接由 CLI 维护）。
 *
 * 零配置起步（M46）：**没有用户登录、也没配接收人时，连接照样启用**——入站事件自己带着
 * 「谁发的」（`sender`）与「哪个会话」（`chat_id`），第一条私聊就把这两件事认下来（`adopt`），
 * 之后卡片与回帖都发到那个会话。于是「装好 → 选 profile → 选智能体 → 私聊它」就能用，
 * 不必为了拿一个 open_id 先走一遍设备码登录（`open_id` 按应用隔离、又查不到，那条路
 * 对交付是死循环）。认人只发生一次：一旦名单非空（配置的接收人 / 名单 / 登录人），
 * 其他人的消息一律忽略——默认拒绝不动。
 *
 * 多连接（M45）：一个工作台可以同时接**多个飞书应用 / 多套机器人**——每个连接一个
 * `lark-cli` profile、一份接收人名单、一个默认智能体。于是「工作台助手」与「别的 agent 的
 * 助手」各走各的机器人：消息不混、事件长连接不抢（同一个飞书应用全局只允许一处 event bus），
 * 也能按连接派给不同智能体。连接配置为空时退化成原来的单连接行为（旧字段照旧生效）。
 *
 * 边界（SPEC-plugins「channel」）：
 * - 只读卡片、只回报 `delivered` / `answer`；不改卡片内容；
 * - 入站文本（M44）只经 `ctx.submit` 转给宿主，**派给哪个智能体由宿主决定**（多连接时按
 *   连接的 `agent` 覆盖，见 `ChannelSubmit` 第三参）；
 * - 卡片正文 / 入站文字只作卡片 JSON 字段或 CLI 参数，整串作为参数 / stdin，不拼命令行；
 * - 任何一步失败只记日志（`sdk.log`，不记正文），不伪造送达、不影响其它通道与内核；
 * - **发群但没点名谁能答**的连接自己跳过（群里谁都能替你作答是不可接受的默认），不拖累
 *   同一通道的其它连接；「还没认人」不算这种跳过。
 *
 * 环境隔离（M45）：`lark-cli` 会按 `HERMES_HOME` / `OPENCLAW_HOME` 自动绑定到对方的工作区，
 * 通道因此显式剔除这些变量（`LARK_ENV_UNSET`）——不剔除就会和别的 agent 抢同一个应用。
 *
 * 稳定性：
 * - 同一个 `(cardId, version)` 每个连接只发一次（幂等键 + 进程内记录）；
 * - 后续版本与终态（answered / resolved）走 `im messages patch` 原地刷新：通道的 `ref` 是
 *   `{"<连接>": "<message_id>"}` 的 JSON，宿主原样存回（`Card.deliveryRefs`），重启后仍然
 *   知道每条连接该改哪条消息；
 * - 点击只回报答案，不再自己决定卡片长什么样——渲染一律按宿主送回的卡片状态；
 * - 点击要配**这条连接当前版本**的消息：不是就算旧消息，只记日志；
 * - 监听进程退出后 30 s 重连（长连接断了不该让通道永久哑掉），dispose 后不再重连。
 */
import type {
  ChannelContext,
  ChannelPlugin,
  ChannelSubmitOutcome,
} from '../../../protocol/channels'
import type { Card } from '../../../protocol/entities'
import { readClick } from './click'
import { readTextMessage } from './inbound'
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

/** 可答复人列表的上限（防御超长配置）。 */
const MAX_ANSWERERS = 50

/** 一个通道最多接多少个飞书连接（防御超长配置；正常用 1~3 个）。 */
export const MAX_CONNECTIONS = 8

/** 连接名长度上限（进 ref 聚合键，太长只会让日志难读）。 */
const CONNECTION_ID_LIMIT = 24

/** 两条长连接：卡片点击、入站消息（各自重连，互不牵连）。 */
const WATCH_KINDS = ['clicks', 'messages'] as const

type WatchKind = (typeof WATCH_KINDS)[number]

/** 重连定时器的类型别名（Node 与 DOM 的 setTimeout 返回值不同，这里只要 clearTimeout 认它）。 */
type StopTimer = ReturnType<typeof setTimeout>

/** 一条进展回帖的长度上限（码点）：平台对单条文本有上限，超了截断并标注还有更多。 */
export const PROGRESS_CHARS = 3_000

/**
 * 截断进展正文：智能体的一轮输出可能很长，回帖只用于「知道进展」，
 * 完整内容在工作台里看。截断保留头尾，让「结论」不至于被砍掉。
 */
export function clipProgress(body: string): string {
  const chars = [...body]
  if (chars.length <= PROGRESS_CHARS) return body
  const head = chars.slice(0, PROGRESS_CHARS - 200).join('')
  const tail = chars.slice(-160).join('')
  return `${head}\n…（已截断，完整内容在工作台里看）…\n${tail}`
}

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
  /**
   * 是否接收入站文本（M44）：「配了默认智能体」才开第二条长连接。
   *
   * 派给谁**不由通道决定**（宿主按同一个 `agent` 配置挑人），这里只借它当开关：
   * 没配就不必多挂一条 `im.message.receive_v1` 的长连接，也不会在没智能体时对空回话。
   */
  inbound: boolean
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
    inbound: textOf(raw, 'agent') !== null,
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
  /** 这条连接派活给谁（空 = 不接收入站） */
  agent: string | null
  /** 私聊接收人 open_id */
  user: string | null
  /** 群 chat_id（优先于私聊） */
  chat: string | null
  /** 可答复人 open_id 名单 */
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
  const legacyAgent = textOf(raw, 'agent')
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
      agent: fieldOf(item, 'agent'),
      user: fieldOf(item, 'user'),
      chat: fieldOf(item, 'chat'),
      answerers: listOf(item['answerers']),
    })
  }

  if (connections.length > 0) return connections

  // 兼容旧配置（M42–M44）：`lark` / `agent` / `user` / `chat` / `answerers` 就是唯一连接
  return [
    {
      id: 'default',
      label: '默认连接',
      program: base,
      profile: null,
      agent: legacyAgent,
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
  inbound: conn.agent !== null,
})

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
   * 卡片发到哪；`null` = 还不知道（既没配接收人/群、也没登录人）——这种连接**照样启用**，
   * 等第一条私聊把「谁在用、会话是哪个」带进来（`adopt`），之后卡片就有落点了。
   */
  target: LarkTarget | null
  /** 能不能入站 / 能不能点卡片；空集 = 还没认人（处女连接的合法状态） */
  allowed: Set<string>
  /** cardId → 这条连接最近发出的 (version, message_id)：点击要靠它认「当前这一版」 */
  sent: Map<string, { version: number; ref: string }>
  /** 两条长连接各自的重连状态：一条断了不该拖停另一条 */
  streams: Record<WatchKind, { stop: (() => void) | null; timer: StopTimer | null }>
  /** 「还没有落点」只提示一次，别每张卡刷一行日志 */
  warnedNoTarget: boolean
}

/**
 * 只知会的卡片（M12 打扰口径）：`kind` 是内核建卡时写的判据，缺列的老数据按「有没有选项」
 * 兜底——与 `plugins/channels/desktop` 的 `needsAnswer` 同口径，两处各自判一次，
 * 免得把信息卡当提问发出去。
 */
const isNotice = (card: { kind?: string; options: string[] }): boolean =>
  card.kind === 'notice' || (card.kind === undefined && card.options.length === 0)

/**
 * 没有对应消息时回报的投递引用：信息卡在飞书里**不落消息**（见 `onCard`），
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
      // 读不到也不当作错误：入站事件自带「谁发的、会话是哪个」，第一条私聊就能把这两件事定下来
      // —— 装完就能用，不该为了拿一个 open_id 逼人去走设备码登录。
      let owner = config.user
      if (config.chat === null && owner === null) {
        try {
          owner = await lark.owner()
        } catch (error) {
          owner = null
          ctx.sdk.log(
            `飞书连接「${conn.label}」还没有登录人（${errMsg(error)}）：卡片先不发，等第一条私聊把发送人与会话带进来`,
          )
        }
      }
      const target = targetOf(config, owner)
      const allowed = answerersOf(config, owner)
      // 只有「发到群里却没点名谁能答」才禁用整条连接：群里谁都能替你作答是不可接受的默认。
      // 「没有落点」不跳过——那是处女连接的正常起点（见 `adopt`）。
      if (target !== null && allowed.length === 0) {
        ctx.sdk.log(`飞书连接「${conn.label}」发群但没配可答复人，跳过这条连接`)
        continue
      }
      owners.push({
        conn,
        lark,
        target,
        allowed: new Set(allowed),
        sent: new Map<string, SentMark>(),
        streams: {
          clicks: { stop: null, timer: null },
          messages: { stop: null, timer: null },
        },
        warnedNoTarget: false,
      })
    }

    if (owners.length === 0) {
      ctx.sdk.log('飞书通道没有可用的连接，不投递')
      return noopDispose
    }

    /** 会话 id → 发起这条会话的连接与消息（进展回帖挂在它下面） */
    const anchors = new Map<string, { runtime: ConnectionRuntime; messageId: string }>()

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
      // 还没有落点（没配接收人 / 没登录人 / 还没人来私聊过）：这次不发，但连接不哑——
      // 第一条私聊会带来会话（`adopt`），之后卡片就有地方去了。
      if (runtime.target === null) {
        if (!runtime.warnedNoTarget) {
          runtime.warnedNoTarget = true
          ctx.sdk.log(
            `飞书连接「${conn.id}」还没有发送目标（配接收人，或先在飞书私聊它一句），卡片先不发`,
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
    const deliver = async (card: Card, ref: string | null): Promise<void> => {
      const json = JSON.stringify(renderCard(card))
      const previous = parseConnectionRefs(ref)
      const next: Record<string, string> = {}
      let delivered = false
      for (const runtime of owners) {
        const { conn } = runtime
        const known = previous[conn.id] ?? runtime.sent.get(card.id)?.ref ?? null
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
      if (!delivered) return
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

    /**
     * 入站（M44）：私聊里发来的一句话 → `ctx.submit` 派活 → 回一句回执。
     *
     * 「只做私聊」是通道策略：群里任何人都能对着机器人说话，把群聊当遥控器风险太大；
     * 白名单与「谁能点卡片」同一份。派给谁按这条连接的 `agent`（空则回落到通道配置）。
     */
    const inbound = async (
      runtime: ConnectionRuntime,
      event: Record<string, unknown>,
    ): Promise<void> => {
      const incoming = readTextMessage(event)
      if (incoming === null) return
      const { conn } = runtime
      if (incoming.chatType !== 'p2p') {
        ctx.sdk.log(`飞书消息已忽略（连接 ${conn.id}，${incoming.chatType}）：入站只认私聊`)
        return
      }
      if (!runtime.allowed.has(incoming.sender)) {
        // 已经认过人就按名单办事（默认拒绝，别人再来一律忽略）
        if (runtime.allowed.size > 0 || runtime.target !== null) {
          ctx.sdk.log(`飞书消息已忽略（连接 ${conn.id}）：${incoming.sender} 不在名单`)
          return
        }
        // 处女连接（没配接收人/群、也没有登录人）：第一条私聊就是「认人」。
        // 记下发这句话的人与会话，之后卡片与回帖都发到这里 —— 装完就能用，不必先走登录。
        runtime.allowed.add(incoming.sender)
        runtime.target =
          incoming.chatId === null
            ? { kind: 'user', id: incoming.sender }
            : { kind: 'chat', id: incoming.chatId }
        runtime.warnedNoTarget = false
        ctx.sdk.log(
          `飞书连接「${runtime.conn.label}」认下第一位使用者 ${incoming.sender}：之后卡片与回帖都发到这个会话`,
        )
      }
      let outcome: ChannelSubmitOutcome
      try {
        outcome = await ctx.submit(
          incoming.text,
          {
            // 幂等键仍由「连接 + 平台消息 id」组成
            ref: `${conn.id}:${incoming.messageId}`,
            // M47：话题归属的证据全部交出去，判不判由宿主决定
            chatId: incoming.chatId,
            rootRef: incoming.rootRef,
            threadRef: incoming.threadRef,
            replyTo: incoming.replyTo,
          },
          conn.agent ?? undefined,
        )
      } catch (error) {
        ctx.sdk.log(`飞书消息没能派出去（连接 ${conn.id}）：${errMsg(error)}`)
        return
      }
      // 回帖锚点：进展挂在你发的那句话下面，一个话题一条线程，不串台
      if (outcome.conversationId !== null) {
        anchors.set(outcome.conversationId, { runtime, messageId: incoming.messageId })
      }
      try {
        await runtime.lark.reply(incoming.messageId, outcome.receipt)
      } catch (error) {
        ctx.sdk.log(`飞书回执没发出去（连接 ${conn.id}）：${errMsg(error)}`)
      }
    }

    let disposed = false

    /**
     * 监听进程退出：等固定间隔再起一个（长连接断了不该让通道永久哑掉）。
     *
     * 「停用之后不再重连」由监听器自己的 stopped 守卫保证（stop 之后它不再回报退出），
     * 这里不重复判一次——重复守卫是第二位真相源，只会让「谁负责不重连」变得含糊。
     */
    const restartLater = (runtime: ConnectionRuntime, kind: WatchKind, reason: string): void => {
      if (disposed) return
      const stream = runtime.streams[kind]
      if (stream.timer !== null) return
      const label = kind === 'clicks' ? '点击' : '消息'
      ctx.sdk.log(
        `飞书连接 ${runtime.conn.id} 的${label}监听中断（${reason}）；${Math.round(WATCH_RESTART_MS / 1000)} 秒后重连`,
      )
      stream.timer = setTimeout(() => {
        stream.timer = null
        startStream(runtime, kind)
      }, WATCH_RESTART_MS)
    }

    const startStream = (runtime: ConnectionRuntime, kind: WatchKind): void => {
      const onExit = (reason: string): void => {
        restartLater(runtime, kind, reason)
      }
      runtime.streams[kind].stop =
        kind === 'clicks'
          ? runtime.lark.watchClicks((event) => {
              void answer(runtime, event)
            }, onExit)
          : runtime.lark.watchMessages((event) => {
              void inbound(runtime, event)
            }, onExit)
    }

    /**
     * 信息卡（`notice`）**不发消息**：IM 里没有「通知栏」可落，正文已经在这一轮回帖里
     * 说过同一件事，再发一张卡片就是重复打扰（M12 的打扰口径同样适用于 IM 通道）。
     * 终态（resolved）也跳过——那张卡本来就不在飞书里，没有要改口的消息。
     * 每种状态都照样 ack：投递语义是「已送达至少一个通道」，in-app 投影已经能看到它。
     */
    const off = ctx.onCard((card, ref) => {
      if (isNotice(card)) {
        void ctx.delivered(card.id, card.version, NO_MESSAGE_REFS)
        return
      }
      void deliver(card, ref)
    })
    const offProgress = ctx.onProgress((progress) => {
      const anchor = anchors.get(progress.conversationId)
      if (anchor === undefined) return
      void anchor.runtime.lark
        .reply(anchor.messageId, clipProgress(progress.text))
        .catch((error: unknown) => {
          ctx.sdk.log(
            `飞书进展没发出去（连接 ${anchor.runtime.conn.id}，会话 ${progress.conversationId}）：${errMsg(error)}`,
          )
        })
    })

    for (const runtime of owners) {
      startStream(runtime, 'clicks')
      // 入站是可选能力：没配智能体就不多挂一条长连接（平台上一条应用只能一处事件总线）
      if (runtime.conn.agent !== null || textOf(raw, 'agent') !== null) {
        startStream(runtime, 'messages')
      }
    }

    const dispose = (): void => {
      if (disposed) return
      disposed = true
      off()
      offProgress()
      for (const runtime of owners) {
        for (const kind of WATCH_KINDS) {
          const stream = runtime.streams[kind]
          if (stream.timer !== null) clearTimeout(stream.timer)
          stream.timer = null
          stream.stop?.()
          stream.stop = null
        }
        runtime.sent.clear()
      }
      anchors.clear()
      ctx.signal.removeEventListener('abort', dispose)
    }
    ctx.signal.addEventListener('abort', dispose, { once: true })
    if (ctx.signal.aborted) dispose()
    return dispose
  },
}
