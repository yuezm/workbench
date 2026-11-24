/**
 * 通道插件契约（M4）：卡片送到哪、答案怎么回来。
 *
 * 依赖方向：`plugins → protocol`（插件只依赖 sdk 与 protocol）。`protocol` 不反向 import
 * `src/sdk`，所以这里的 `sdk` 用结构性最小面 `ChannelSdk`——`src/sdk` 的 `Sdk` 结构上满足它；
 * 宿主把能力门控后的 Sdk 实例注入通道插件（`notify` 需 manifest 声明
 * `capabilities: ['notify']`，否则访问即抛 `capability_not_declared`）。
 *
 * 通道的边界：只负责「展示卡片 / 收回答 / 回报投递 / 转发入站文字」，**不改卡片内容、
 * 不决定派给谁**。卡片正文与入站文字都是外部文本，只能作为平台/通知 API 的参数，不得拼进
 * 命令行、脚本或 HTML/模板字符串。
 */
import type { Card } from './entities'
import type { NotifyTarget } from './ipc'

/** 卡片 / 版本等业务 id 的字符串别名（与 `kernel/types` 的 `Id` 同形，protocol 不依赖 kernel）。 */
type Id = string

/**
 * 通道端口版本：上下文形状变化时递增；外部通道（M7）按它做兼容判断。
 *
 * - 1（M4）：`log / now / notify / config / net`；
 * - 2（M42）：`ChannelSdk.process`（声明 `spawn` 才拿到）——IM 通道要驱动 `lark-cli` 这类
 *   自带凭据与长连接的 CLI，宿主不为每个平台写适配器；
 * - 3（M43）：`onCard(card, ref)` 的 `ref` + `answer(cardId, optionIndex, ref)` 与
 *   `{ changed, status }` 返回值——同一张卡会出现在多个通道，回答要能回到**每一处**并
 *   知道「是否已由别处答复」。
 * - 4（M44）：`submit(text, ref)` + `onProgress(handler)`——IM 里发来的文字可以派活，
 *   智能体每一轮的终态能回到同一个通道（派活目标与幂等键由宿主决定，通道只转发与回帖）。
 * - 5（M45）：`submit(text, ref, agent)` 的第三参 + `SpawnOptions.envPatch`——一个通道可以
 *   同时接多个飞书连接（多套应用 / 多套机器人），每条连接派给不同智能体，并且能把宿主环境里
 *   别的 agent 留下的身份变量剔除，避免两个程序抢同一个应用的长连接。
 * - 6（M47）：`submit(text, hints, agent)` 的第二参从「消息引用」升级为**入站线索**——通道额外
 *   交出平台结构证据（`chatId` / `rootRef` / `threadRef` / `replyTo`），宿主据此把同一话题的
 *   消息收进同一会话。派给谁、算不算同一话题仍由宿主决定。
 * - 7（M54）：`onCard(card, ref, context)` 的第三参——宿主把「这张卡属于哪个项目 / 哪条任务 /
 *   哪一步 / 谁在问」一并交给通道。IM 里只有标题和按钮时，收到卡的人无法判断该不该答。
 */
export const CHANNEL_PORT_VERSION = 7

/**
 * 投递重投曲线（M41）：第 N 次失败之后等多少毫秒再投下一次。
 *
 * 节奏按「桌面场景」定：第一次失败 30 秒后重投，之后 2 / 10 / 30 分钟，一共 5 次尝试。
 * 超过曲线就放弃（`card.deliveryGivenUp`），把「通道长期不可用」变成一条可查的事实，
 * 而不是每次启动都重投一遍。曲线是协议常量：内核算 `retryAt`、宿主按它排期，两边同一份。
 */
export const DELIVERY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const

/** 一条卡片版本最多尝试几次（首次 + 曲线里的每一次）。 */
export const DELIVERY_MAX_ATTEMPTS = DELIVERY_RETRY_DELAYS_MS.length + 1

/**
 * 第 `attempt` 次尝试失败后的重投时刻（毫秒延迟）；`null` = 预算用尽，不再排期。
 *
 * 纯函数、无时钟：`attempt` 是「本次失败算第几次尝试」（1 基），`now` 由调用方给。
 */
export function deliveryRetryDelayMs(attempt: number): number | null {
  if (attempt >= DELIVERY_MAX_ATTEMPTS) return null
  return DELIVERY_RETRY_DELAYS_MS[attempt - 1] ?? null
}

/**
 * 通道可用的网络子集（M7）：只暴露出站请求（回环监听只给 source）。
 * 与 `src/sdk/types` 的 `NetCapability` 结构兼容（宿主按 manifest 的 `net` 声明注入）。
 */
export interface ChannelNet {
  fetch(
    url: string,
    options?: {
      method?: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
    },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>
}

/**
 * 子进程写入端（通道侧最小面）：经 `ChannelSpawned.stdin` 交给 CLI。
 * 与 `src/sdk/types` 的 `Spawned.stdin` 结构兼容（`protocol` 不反向 import `sdk`）。
 */
export interface ChannelStdin {
  write(chunk: string): unknown
  end(chunk?: string): unknown
}

/** 子进程输出端（通道侧最小面）：只给 `data` 事件，切行由插件自己做。 */
export interface ChannelStdout {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
}

/** 子进程句柄（与 `src/sdk/types` 的 `Spawned` 结构兼容）。 */
export interface ChannelSpawned {
  readonly pid: number | undefined
  readonly stdin: ChannelStdin | null
  readonly stdout: ChannelStdout | null
  readonly stderr: ChannelStdout | null
  onError(cb: (error: Error) => void): void
  onClose(cb: (code: number | null, signal: string | null) => void): void
  kill(signal?: string): void
}

/**
 * `spawn` 的选项：与 `src/sdk/types` 的 `SpawnOptions` 同形。
 *
 * `env` 省略 = **继承宿主进程环境**（宿主保证）；显式给值则整体替换（不合并）。
 * `envPatch` 是在继承（或 `env`）之上做增量增删（M45）：IM 通道要剔除别的 agent 留下的
 * 身份变量（如 `HERMES_HOME`），否则 CLI 会切到对方的工作区，两个程序抢同一个应用的长连接。
 */
export interface ChannelSpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** 继承环境的增量修改：先删 `unset`，再覆盖 `set` */
  envPatch?: { unset?: readonly string[]; set?: Record<string, string> }
  /** Windows 的 `.cmd` / `.bat` 需要经 shell 启动 */
  shell?: boolean
}

/**
 * 通道可用的进程子集（M42）：需要 manifest 声明 `capabilities: ['spawn']`。
 *
 * 只暴露通道描述「一个 CLI 进程怎么起、怎么停」所需的三件事：
 * 命令解析（PATH + 常见全局目录）、启动、按 pid 终止整棵树。
 */
export interface ChannelProcess {
  spawn(command: string, args: string[], options: ChannelSpawnOptions): ChannelSpawned
  resolve(command: string): { path: string | null; error: string | null }
  killTree(pid: number, signal?: string): boolean
}

/** 通道插件用到的能力子集（`src/sdk` 的 `Sdk` 结构上覆盖它）。 */
export interface ChannelSdk {
  /** 结构化日志（宿主加插件 id 前缀）；不记卡片全文。 */
  log(line: string): void
  /** 当前时刻（毫秒）。 */
  now(): number
  /**
   * 系统通知：需要 manifest 声明 `capabilities: ['notify']`。
   *
   * `target` 是「点了这条通知该去哪儿」：不传就与 M4 一样只弹不跳。通道只负责给出落点的
   * 业务部分（卡 / 任务 / 会话），app 身份由装配根补——插件不认识产品名。
   */
  notify(title: string, body: string, target?: NotifyTarget): void
  /** 插件自有配置（M7：manifest 默认值 + 用户设置合并；宿主按通道分别注入）。 */
  config<T = Record<string, unknown>>(): T
  /** 出站 HTTP（M7）：需要 manifest 声明 `capabilities: ['net']`；宿主未注入时缺省不可用。 */
  net?: ChannelNet
  /**
   * 子进程（M42）：需要 manifest 声明 `capabilities: ['spawn']`，未声明时访问即抛
   * `capability_not_declared`。IM 通道用它驱动自带凭据与长连接的 CLI（如 `lark-cli`），
   * 卡片正文只作 argv 参数，不拼命令行字符串。
   */
  process: ChannelProcess
}

/** 投递回调：通道把「已送达」的事实回报给宿主（写 `card.delivered`，按通道各一条）。 */
export type ChannelDelivered = (cardId: Id, version: number, ref: string) => Promise<void>

/**
 * 回答的结果（M43）：`changed=false` 表示这张卡已经不在等你（已被别处答复 / 已关闭），
 * 通道据此可以把那张卡刷成终态、并在日志里说清「already settled」。
 */
export interface ChannelAnswerOutcome {
  changed: boolean
  /** 内核里这张卡当前的状态（`answered` / `resolved` 时 `changed` 为 false） */
  status: Card['status']
}

/**
 * 回答回调：经宿主发 `card.answer`（`via: 'channel'`）。
 *
 * `ref` 是通道侧那条消息的引用（M43）：宿主用它确认「点的是我发出去的那条消息」，
 * 旧消息（卡片已经更新过版本）的点击只记日志、不计入。
 */
export type ChannelAnswer = (
  cardId: Id,
  optionIndex: number,
  ref?: string,
  byRef?: string,
) => Promise<ChannelAnswerOutcome>

/**
 * 入站文本的提交结果（M44）：宿主派完活后给通道的一句回执。
 *
 * `receipt` 是**宿主写的文案**，通道只负责原样回帖（不通顺也该由宿主改，而不是每个通道各编一套）。
 * `accepted=false` 时 `conversationId` 为 null，`receipt` 说明为什么没派出去（没配智能体 /
 * 智能体不存在 / 内核拒绝），通道照样回帖——沉默是最差的反馈。
 */
export interface ChannelSubmitOutcome {
  accepted: boolean
  /** 派活用的会话 id（accepted=false 时为 null） */
  conversationId: string | null
  /** 回帖给发端的一句话 */
  receipt: string
}

/**
 * 入站线索（M47，通道端口 6）：通道交出的「这句话从哪儿来」。
 *
 * 两项职责分开写：
 * - `ref` 只做**幂等键**（同一条平台消息重投不派第二次活），必须由平台消息 id 组成；
 * - `chatId` / `rootRef` / `threadRef` / `replyTo` 是**话题归属证据**：宿主按「结构证据 >
 *   显式命令 > 活跃窗口」的优先级决定这句话接在哪个话题上。缺哪个就少一条证据，不影响派活。
 *
 * 通道只交证据，不判话题——与「派给谁不由通道决定」同一条边界。
 */
export interface ChannelSubmitHints {
  /** 平台消息引用（幂等键；同一条消息重投必须同值） */
  ref?: string
  /**
   * 连接 / 应用标识（M47）：多连接通道用它区分同一条通道下的不同机器人。
   * 与 `chatId` 一起构成话题前缀 `<scope>:<chatId>:`——两个私聊用户的消息因此不会串台。
   */
  scope?: string | null
  /** 平台会话 id（`oc_…`）：没有结构证据时按「这个会话最近活跃的话题」收敛 */
  chatId?: string | null
  /** 回复链根消息（`root_id`）：用户在同一链条里回复时不变，最硬的结构证据 */
  rootRef?: string | null
  /** 话题线程 id（`thread_id`）：话题群 / 线程回复给的那条线程 */
  threadRef?: string | null
  /** 直接回复的那条消息（`reply_to`）：命中「机器人发过的某条消息」就认那个话题 */
  replyTo?: string | null
}

/**
 * 入站文本回调（M44/M45/M47）：`text` 是人在 IM 里发的那句话，`hints` 是平台侧的线索。
 *
 * 通道**不决定派给谁**：目标由宿主按通道配置选，通道拿到的只有「派出去了 / 没派出去」。
 * `agent`（M45）只用于**多连接通道**给单条连接指定智能体（id 或名称）；省略或空串时
 * 宿主沿用通道配置里的 `agent`。它仍然只是「谁来回」，命令与幂等键都在宿主手里。
 */
export type ChannelSubmit = (
  text: string,
  hints: ChannelSubmitHints,
  agent?: string,
) => Promise<ChannelSubmitOutcome>

/**
 * 进展（M44）：这个通道提交过的会话里，智能体说完了一轮（或这一轮失败）。
 *
 * 只带会话 id 与正文：通道据此把话回帖到发起那条消息下面，不参与判断这一轮算不算成功。
 */
export interface ChannelProgress {
  conversationId: string
  /** `reply` = 智能体的正常回复；`failed` = 这一轮失败的错误文案 */
  kind: 'reply' | 'failed'
  /** 正文（只作平台的文本参数，通道不改写、不拼进命令行） */
  text: string
}

/** 进展订阅处理器（返回退订函数由上下文给出）。 */
export type ChannelProgressHandler = (progress: ChannelProgress) => void

/**
 * 卡片上下文（M54，通道端口 7）：这张卡**属于哪件活**。
 *
 * 为什么由宿主给而不是通道自己查：`Card` 只有 `taskId` / `conversationId` 这样的弱引用，
 * 而通道拿不到投影（也不该拿）。卡片标题是智能体写的自由文本，实测发到飞书里就是
 * 「覆盖率棘轮红：打回补测还是接受现状？」——收卡的人既不知道这是哪个项目、哪条任务，
 * 也不知道是哪个智能体在问，于是「不知道该怎么回答」。这些都在投影里，所以由宿主算好随
 * 卡片一起交下来；通道只负责摆进消息。
 *
 * 全部字段都是**只读展示**：不参与任何判定（谁该答仍看 `answerers`），缺值就是 null。
 */
export interface CardContext {
  /** 项目名（null = 默认目录） */
  projectName: string | null
  /** 任务标题（聊天卡为 null） */
  taskTitle: string | null
  /** 会话标题（聊天卡用；阶段卡为 null） */
  conversationTitle: string | null
  /** 当前阶段名（任务卡用） */
  stageName: string | null
  /** 这一轮干活的智能体名 */
  agentName: string | null
}

/**
 * 通道插件启动上下文。
 *
 * - `onCard`：订阅卡片投递。宿主按注册表顺序分发**所有需要这个通道知道的版本**：
 *   `card.opened` / `card.updated`（新版本）以及 `card.answered` / `card.resolved`
 *   （这张卡在这个通道发过时，回到原消息改口）。第二参 `ref` 是这个通道上次成功发出的
 *   引用（从未发过为 null）——有它就走「原地更新」，没有就是第一次发。
 *   第三参 `context`（M54）是这张卡的归属上下文，读不到就是 null（通道照常投递）。
 *   返回退订函数。启动时宿主还会补投尚未送达的 open 卡。
 * - `delivered` / `answer`：通道 → 宿主的两个回调；投递状态只经事实回写，不直写投影。
 * - `submit`（M44/M47）：入站文本 + 平台线索 → 宿主派活（目标与话题归属都由宿主决定），
 *   返回一句回执。
 * - `onProgress`（M44）：订阅这个通道提交过的会话的每轮终态；返回退订函数。
 * - `signal`：宿主退出或停用通道时 abort。
 */
export interface ChannelContext {
  sdk: ChannelSdk
  onCard(handler: (card: Card, ref: string | null, context: CardContext | null) => void): () => void
  delivered: ChannelDelivered
  answer: ChannelAnswer
  submit: ChannelSubmit
  onProgress(handler: ChannelProgressHandler): () => void
  signal: AbortSignal
}

/**
 * 通道插件（SPEC-plugins「channel」）：一个通道 = 一个目录 + registry 一行。
 * `start` 返回 dispose；dispose 必须可重复调用（宿主退出时 best-effort 等待）。
 */
export interface ChannelPlugin {
  start(ctx: ChannelContext): Promise<() => void>
}
