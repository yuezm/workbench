/**
 * 输入契约（M2）：`Input = Command | HostInput`。
 *
 * 内核唯一决策入口 `decide(view, input, now, env)` 的入参是 `Input`：命令来自
 * renderer / IPC（带 `commandId` 幂等键），宿主内部输入由调度器 / 定时器 / 对账发
 * （不经 IPC，也没有 `commandId`——幂等由租约与回执哈希保证，D9）。
 *
 * 事实名与输入名不是一回事：`run.heartbeat` 是输入，它产的事实叫
 * `run.lease_extended`（D1）；`run.cancel` 产 `run.cancel_requested`。
 *
 * `Receipt` 是执行器一轮执行的回报（SPEC-plugins「executor」），D15 要求它原样
 * 带回 `leaseId` 与 `turn`，内核据此拒绝迟到尝试。`Turn` 属于执行器端口契约，
 * 随 host 执行链（T9）落地，不在这里。
 */
import type { Command } from './commands'
import { COMMAND_NAMES } from './commands'
import type { RunErrorCode, RunTerminalStatus, RunUsage } from './entities'

/** 宿主内部输入名全集：不经 IPC，只由宿主（scheduler / clock / reconcile / chat 入口）发。 */
export const HOST_INPUT_NAMES = [
  'run.claim',
  'run.heartbeat',
  'run.receipt',
  'run.host_settled',
  'run.cancel',
  'clock.tick',
  'conversation.create',
  'conversation.send',
  'conversation.rename',
  'conversation.remove',
] as const

export type HostInputName = (typeof HOST_INPUT_NAMES)[number]

/** 输入名全集：命令名 + 宿主内部输入名（校验层的白名单）。 */
export const INPUT_NAMES = [...COMMAND_NAMES, ...HOST_INPUT_NAMES] as const

export type InputName = (typeof INPUT_NAMES)[number]

// ---------- 执行器回执 ----------

/** 要拍板的事项（卡片雏形）；M4 接通道时补版本与投递字段。 */
export interface Ask {
  title: string
  /** 正文（可空） */
  text?: string
  /** 可选项文案；回答时回传下标 */
  options: string[]
  /** 稳定键，重复回执按它去重（可空） */
  key?: string
}

/** 执行器派生的原始事件（M4/M6 经规则建任务用）；M2 只校验形状，不处理。 */
export interface RawEvent {
  source: string
  /** kebab-case，如 issues.opened */
  type: string
  /** 事项标识，用于合并 */
  subject: string
  /** 摘要（≤200 字） */
  summary?: string
  /** 全文，由宿主流资料文件 */
  detail?: string
  link?: string
  dedupeKey?: string
}

/**
 * 一轮执行的回执：执行器 → 宿主 → `run.receipt` 输入 → 内核。
 * `later / events / notices / resolves` 留到 M4/M6 处理：M2 适配层不产出，
 * 内核校验时接受但忽略（D15）。
 */
export interface Receipt {
  status: RunTerminalStatus
  /** 原样回传 `Turn.leaseId`：内核据此拒绝迟到尝试 */
  leaseId: string
  /** 原样回传 `Turn.turn` */
  turn: number
  output?: string
  sessionId?: string
  usage?: RunUsage
  /** 失败原因文案（给人看；`errorCode` 是归类）。M2 补：终态 `runs.error` 与 chat 失败消息都用它 */
  error?: string
  ask?: Ask[]
  notices?: string[]
  /** 关掉的旧卡片 id */
  resolves?: string[]
  /** 约时间复查（ISO） */
  later?: string
  events?: RawEvent[]
  errorCode?: RunErrorCode
  exitCode?: number
  durationMs?: number
  /** 续接失败：执行器已按新会话重试过一次仍被拒 */
  resumeRejected?: boolean
}

// ---------- 运行 ----------

/** 领取：宿主按运行时发起；`capacity` 是本次最多领取数（1–8，且不超过剩余并发窗口）。 */
export interface RunClaimInput {
  type: 'run.claim'
  runtimeId: string
  capacity: number
}

/** 心跳续租：`leaseId` 必须匹配当前租约，否则内核不产事实 */
export interface RunHeartbeatInput {
  type: 'run.heartbeat'
  runId: string
  leaseId: string
}

/** 回执：run 属于该运行时、`leaseId` 与 `turn` 匹配当前轮，否则只记 `run.receipt_rejected` */
export interface RunReceiptInput {
  type: 'run.receipt'
  runId: string
  receipt: Receipt
}

/**
 * 宿主兜底终态（D14）：执行器不可达 / 超时无回执 / 取消无回执时，由宿主写终态。
 * 仅宿主 actor 可发，`errorCode` 取 `timeout` / `executor_lost` / `cancelled` 之一。
 */
export interface RunHostSettledInput {
  type: 'run.host_settled'
  runId: string
  leaseId?: string
  turn?: number
  status: RunTerminalStatus
  errorCode?: RunErrorCode
  error?: string
  output?: string
  sessionId?: string
  usage?: RunUsage
  exitCode?: number
  durationMs?: number
}

/** 取消请求：只对 queued/running/waiting 有效；终止进程由宿主按取消时序执行 */
export interface RunCancelInput {
  type: 'run.cancel'
  runId: string
}

/** 唯一定时器到点：内核据此产出租约过期 / 退避到期 / 超时等事实 */
export interface ClockTickInput {
  type: 'clock.tick'
}

// ---------- 对话 ----------

export interface ConversationCreateInput {
  type: 'conversation.create'
  agentId: string
  /** 首条消息可顺带给标题；缺省用「新对话」 */
  title?: string
}

/** 发一轮：先落用户消息再入队 `purpose='chat'` 的 run；被拒绝时不落消息 */
export interface ConversationSendInput {
  type: 'conversation.send'
  conversationId: string
  content: string
}

export interface ConversationRenameInput {
  type: 'conversation.rename'
  conversationId: string
  title: string
}

export interface ConversationRemoveInput {
  type: 'conversation.remove'
  conversationId: string
}

/** 宿主内部输入（判别联合，`type` 是输入名）。 */
export type HostInput =
  | RunClaimInput
  | RunHeartbeatInput
  | RunReceiptInput
  | RunHostSettledInput
  | RunCancelInput
  | ClockTickInput
  | ConversationCreateInput
  | ConversationSendInput
  | ConversationRenameInput
  | ConversationRemoveInput

/** 内核唯一决策入口的入参（命令是它的子集）。 */
export type Input = Command | HostInput
