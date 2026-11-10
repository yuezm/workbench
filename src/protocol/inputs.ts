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
import type {
  GateCheck,
  GateVerdict,
  RunErrorCode,
  RunEventRow,
  RunTerminalStatus,
  RunUsage,
} from './entities'
import type { FindingAddress, ReviewArtifact, ReviewFindingInput } from './review'

/** 宿主内部输入名全集：不经 IPC，只由宿主（scheduler / clock / reconcile / 通道 hub）发。 */
export const HOST_INPUT_NAMES = [
  'run.claim',
  'run.heartbeat',
  'run.receipt',
  'run.frames',
  'run.host_settled',
  'run.cancel',
  'clock.tick',
  'card.delivered',
  'card.delivery_failed',
  'event.received',
] as const

export type HostInputName = (typeof HOST_INPUT_NAMES)[number]

/** 输入名全集：命令名 + 宿主内部输入名（校验层的白名单）。 */
export const INPUT_NAMES = [...COMMAND_NAMES, ...HOST_INPUT_NAMES] as const

export type InputName = (typeof INPUT_NAMES)[number]

// ---------- 执行器回执 ----------

/**
 * 要拍板的事项（回执输入）：M4 起仍只是回执字段，不是投影行——内核为每条 `ask`
 * 产一条带完整 `Card` 行的 `card.opened`（版本 / 投递状态由 `Card` 承载）。
 */
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
 * Agent 派生的一项子任务（M8，回执 `spawn[]`）：
 * 只声明「拆成哪件事」，**不指定派活目标 / 权限 / 目录 / 父任务 id**——
 * `parentTaskId`、`origin`、`threadId` 由内核从当前 run 推导。
 */
export interface SpawnTask {
  /** 子任务标题（必填，≤200） */
  subject: string
  /** 描述 / 验收（≤2000；作资料，不拼指令） */
  summary?: string
  /** 落点阶段（可选；须属父任务工作流；缺省按阶段 `subtaskStageId` 或父任务当前阶段） */
  stageId?: string
  /** 批次号（可选，1..999；v1 不区分批次，仅入账） */
  batch?: number
  /** 幂等键（可选；同一父任务下相同 key 只建一次） */
  key?: string
}

/**
 * 一条验收自评（M21）：回执 `acceptance[]` 逐条声明本阶段验收条目的达成情况。
 *
 * `no` 是 **1 基序号**，对应阶段 `acceptance` 数组的下标；越界条目一律丢弃，
 * 缺项按**未达**处理（fail-closed）——「没说」不等于「达成了」。
 */
export interface AcceptanceCheck {
  no: number
  met: boolean
  /** 证据（命令 / 链接 / 一句话说明）；未达时写清差在哪 */
  evidence?: string
}

/**
 * 一轮执行的回执：执行器 → 宿主 → `run.receipt` 输入 → 内核。
 * `later / events / notices / resolves / spawn` 留到 M4/M6/M8 处理。
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
  /** 派生子任务（M8）：内核直接建 `origin='spawn'` 子任务，不依赖规则 */
  spawn?: SpawnTask[]
  /** 线程笔记（M6.5）：每条 ≤2000 字；run 挂在线程上时由内核记 `thread.note_appended` */
  notes?: string[]
  errorCode?: RunErrorCode
  exitCode?: number
  durationMs?: number
  /** 续接失败：执行器已按新会话重试过一次仍被拒 */
  resumeRejected?: boolean
  /**
   * 闸门判定（M11）：只对闸门阶段有意义。`pass` 走通过分支，`fail` 消耗一次预算。
   * 缺省 = 没给结论，任务原地停住等人（既不白过也不烧预算）。
   */
  verdict?: GateVerdict
  /** 判定证据（M11）：闸门阶段应随 `verdict` 一起给，内核用退出码交叉校验结论 */
  checks?: GateCheck[]
  /**
   * 评审清单（M14）：本轮评定出的待改项。给了就产一条 `review.reported`（`rev` 自动递增），
   * 修复阶段会按阶段图取到它并逐条要求回应；`id` 不接受自报，由内核拼 `<reportId>#<key>`。
   */
  findings?: ReviewFindingInput[]
  /**
   * 逐条回应（M14）：修复轮对已定位报告的清单作答。`fixed` 必须带 `checkRef`
   * （指向同回执 `checks` 且退出码为 0）；`rejected` / `deferred` 必须写 `note`。
   * 仍有 `open` 条目且当前阶段正是该报告打回的目标阶段时，任务不推进（硬门）。
   */
  addresses?: FindingAddress[]
  /**
   * 正文引用（M14）：**宿主**把报告正文落到 `<userData>/artifacts/threads/<threadId>/` 后回填，
   * 内核只把它抄进报告行、不读文件。缺省 = 正文没落盘（索引段只给清单与报告 id）。
   */
  artifact?: ReviewArtifact
  /**
   * 验收自评（M21）：本阶段 `acceptance` 各条是否达成。阶段没声明验收时忽略；
   * 未全达且未超 `maxRounds` 时内核原地续一轮，不流转。
   */
  acceptance?: AcceptanceCheck[]
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
 * 运行帧批量入账（D6/D7）：帧 `seq` 由宿主按 run **全局单调**分配（跨 turn 递增），
 * 执行器本地 seq 丢弃；单批 ≤ `maxFramesPerBatch`，超出由宿主分包为多条输入。
 * 数据源始终是 `run.frames` 事实，实时旁路只影响显示。
 */
export interface RunFramesInput {
  type: 'run.frames'
  runId: string
  turn: number
  frames: RunEventRow[]
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

// ---------- 通道投递回写（M4） ----------

/**
 * 通道回报「已送达至少一个通道」（D9）：宿主 hub 在通道回调 `delivered` 后发。
 * 版本与卡片当前 `version` 不一致（迟到投递）或该版本已 delivered → 内核零事实。
 */
export interface CardDeliveredInput {
  type: 'card.delivered'
  cardId: string
  /** 卡片版本（1 基）；只有「被投递的那一版」才算数 */
  version: number
  /** 通道键（in-app / desktop / …），写进 `cards.deliveryRef` 与事实审计字段 */
  ref: string
}

/** 本轮所有通道投递失败（D9）：只把 `delivery` 置 failed，不改卡片状态，重启按 pending 补投。 */
export interface CardDeliveryFailedInput {
  type: 'card.delivery_failed'
  cardId: string
  version: number
  error: string
}

/** 宿主内部输入（判别联合，`type` 是输入名）。 */
export type HostInput =
  | RunClaimInput
  | RunHeartbeatInput
  | RunReceiptInput
  | RunFramesInput
  | RunHostSettledInput
  | RunCancelInput
  | ClockTickInput
  | CardDeliveredInput
  | CardDeliveryFailedInput
  | EventReceivedInput

// ---------- 事件入口（M6） ----------

/**
 * 外部事件入口（source 插件 / 宿主 / 测试注入）：产一条 `event.received` 事实，
 * 并立即按当前规则集匹配建任务（M6）。
 *
 * `hops` 缺省 1（外部来源）；执行器回执派生的事件仍走 `run.receipt` 的 `events[]`
 * （`hops = 父 run.hops + 1`），不经过这里。`detail` 由宿主落资料文件后把路径放进
 * `detailRef`；内核只入账引用，不拼进提示词。
 */
export interface EventReceivedInput {
  type: 'event.received'
  event: RawEvent
  /** 跳数（缺省 1；宿主 / 测试可显式给） */
  hops?: number
  /** 派生出该事件的 run（外部来源为 null） */
  originRunId?: string | null
  /** 资料文件路径（不是指令） */
  detailRef?: string | null
}

/** 内核唯一决策入口的入参（命令是它的子集）。 */
export type Input = Command | HostInput
