/**
 * 通道插件契约（M4）：卡片送到哪、答案怎么回来。
 *
 * 依赖方向：`plugins → protocol`（插件只依赖 sdk 与 protocol）。`protocol` 不反向 import
 * `src/sdk`，所以这里的 `sdk` 用结构性最小面 `ChannelSdk`——`src/sdk` 的 `Sdk` 结构上满足它；
 * 宿主把能力门控后的 Sdk 实例注入通道插件（`notify` 需 manifest 声明
 * `capabilities: ['notify']`，否则访问即抛 `capability_not_declared`）。
 *
 * 通道的边界：只负责「展示卡片 / 收回答 / 回报投递」，**不改卡片内容、不改派活**。
 * 卡片正文是智能体产出的文字，只能作为平台/通知 API 的参数，不得拼进命令行、脚本或
 * HTML/模板字符串。
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
 */
export const CHANNEL_PORT_VERSION = 3

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
 */
export interface ChannelSpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
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
 * 通道插件启动上下文。
 *
 * - `onCard`：订阅卡片投递。宿主按注册表顺序分发**所有需要这个通道知道的版本**：
 *   `card.opened` / `card.updated`（新版本）以及 `card.answered` / `card.resolved`
 *   （这张卡在这个通道发过时，回到原消息改口）。第二参 `ref` 是这个通道上次成功发出的
 *   引用（从未发过为 null）——有它就走「原地更新」，没有就是第一次发。
 *   返回退订函数。启动时宿主还会补投尚未送达的 open 卡。
 * - `delivered` / `answer`：通道 → 宿主的两个回调；投递状态只经事实回写，不直写投影。
 * - `signal`：宿主退出或停用通道时 abort。
 */
export interface ChannelContext {
  sdk: ChannelSdk
  onCard(handler: (card: Card, ref: string | null) => void): () => void
  delivered: ChannelDelivered
  answer: ChannelAnswer
  signal: AbortSignal
}

/**
 * 通道插件（SPEC-plugins「channel」）：一个通道 = 一个目录 + registry 一行。
 * `start` 返回 dispose；dispose 必须可重复调用（宿主退出时 best-effort 等待）。
 */
export interface ChannelPlugin {
  start(ctx: ChannelContext): Promise<() => void>
}
