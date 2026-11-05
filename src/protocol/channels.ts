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

/** 卡片 / 版本等业务 id 的字符串别名（与 `kernel/types` 的 `Id` 同形，protocol 不依赖 kernel）。 */
type Id = string

/** 通道端口版本：上下文形状变化时递增（M4 = 1）；外部通道（M7）按它做兼容判断。 */
export const CHANNEL_PORT_VERSION = 1

/** 通道插件用到的能力子集（`src/sdk` 的 `Sdk` 结构上覆盖它）。 */
export interface ChannelSdk {
  /** 结构化日志（宿主加插件 id 前缀）；不记卡片全文。 */
  log(line: string): void
  /** 当前时刻（毫秒）。 */
  now(): number
  /** 系统通知：需要 manifest 声明 `capabilities: ['notify']`。 */
  notify(title: string, body: string): void
}

/** 投递回调：通道把「已送达至少一个通道」的事实回报给宿主（写 `card.delivered`）。 */
export type ChannelDelivered = (cardId: Id, version: number, ref: string) => Promise<void>

/** 回答回调：经宿主发 `card.answer`（`via: 'channel'`），返回值表示内核是否接受。 */
export type ChannelAnswer = (cardId: Id, optionIndex: number) => Promise<void>

/**
 * 通道插件启动上下文。
 *
 * - `onCard`：订阅卡片投递（宿主按注册表顺序分发 `card.opened` / `card.updated`）；
 *   返回退订函数。启动时宿主还会补投 `delivery='pending'` 的 open 卡。
 * - `delivered` / `answer`：通道 → 宿主的两个回调；投递状态只经事实回写，不直写投影。
 * - `signal`：宿主退出或停用通道时 abort。
 */
export interface ChannelContext {
  sdk: ChannelSdk
  onCard(handler: (card: Card) => void): () => void
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
