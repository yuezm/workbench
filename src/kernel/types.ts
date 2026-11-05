/**
 * 内核契约：事实、视图、决策、投影变更。
 *
 * 纯类型 + 版本常量；没有 IO / 时钟 / 随机数。宿主负责把 `now`、id 生成器、
 * 视图切片装好再调用 `decide`。
 *
 * M2 起投影集扩到「实体五表 + runs / run_events / conversations / messages」：
 * `ProjectionTable` 是投影全集，`View` 只装 decide 需要的那几片（`run_events`
 * 不进 View，事件只在写入 / 重建时经 `project` 落库）。M4 追加第 10 张 `cards`。
 * 事实 payload 里的实体行是完整行（含 lastProbe），这样 `project(fact)` 是纯函数：
 * 一行事实 → 一行投影，重建与实时写入走同一条路径。凭据类字段仍不进事实。
 */
import type {
  Agent,
  Card,
  Conversation,
  Message,
  RunEventRow,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../protocol/entities'
import type { FactPayload, FactType } from '../protocol/facts'
import type { Input } from '../protocol/inputs'
import type { AutomationRule, RuleFireRow, RuleSetRow } from '../protocol/rules'

export type Seq = number
export type Id = string
export type Iso = string

/**
 * 内核版本；参与投影指纹，行为变化时递增，启动即触发重建。
 * M4：卡片与派生事件入账；M6：规则集与 cron 触发投影。
 */
export const KERNEL_VERSION = 'm6.0.0'

export type Actor =
  | { kind: 'owner'; via: 'ui' | 'channel' }
  | {
      kind: 'host'
      /**
       * `channel`：通道 hub 回写投递状态（`card.delivered` / `card.delivery_failed`）——
       * 这是通道回报，不是调度器的决策，所以不复用 `scheduler` 语义（M4 D9）。
       */
      via: 'timer' | 'scheduler' | 'reconcile' | 'timeout' | 'cancel' | 'channel'
    }
  | { kind: 'kernel' }

/**
 * 投影表全集：只有这些表可由事实重建（`host` 的清空白名单与指纹必须与之一致）。
 * M2 在实体五表之后追加运行生命周期相关的四张表；M4 追加卡片表（第 10 张）；
 * M6 追加规则集与规则触发记录（第 11、12 张）。
 */
export const PROJECTION_TABLES = [
  'tasks',
  'workflows',
  'workflow_stages',
  'agents',
  'runtimes',
  'runs',
  'run_events',
  'conversations',
  'messages',
  'cards',
  'rule_sets',
  'rule_fires',
] as const

export type ProjectionTable = (typeof PROJECTION_TABLES)[number]

export type ProjectionRow =
  | Task
  | Workflow
  | WorkflowStage
  | Agent
  | Runtime
  | RunRow
  | RunEventRow
  | Conversation
  | Message
  | Card
  | RuleSetRow
  | RuleFireRow

export interface FactDraft<T extends FactType = FactType> {
  type: T
  actor: Actor
  at: Iso
  cause?: Seq
  hops?: number
  payload: FactPayload<T>
}

export interface Fact<T extends FactType = FactType> extends FactDraft<T> {
  seq: Seq
}

/** 事实 → 投影变更；`row === null` 为删除。 */
export interface Change {
  table: ProjectionTable
  key: Id
  row: ProjectionRow | null
}

/** 宿主按 `viewSpec` 装载的只读切片；内核不查库。 */
export interface View {
  seq: Seq
  workflows: Map<Id, Workflow>
  stages: Map<Id, WorkflowStage>
  agents: Map<Id, Agent>
  runtimes: Map<Id, Runtime>
  tasks: Map<Id, Task>
  /** M2：运行投影（领取 / 租约 / 终态判定都只读它，不查非投影表） */
  runs: Map<Id, RunRow>
  /** M4：卡片投影（回答校验、同 key 去重、续接提示词都只读它） */
  cards: Map<Id, Card>
  conversations: Map<Id, Conversation>
  messages: Map<Id, Message>
  /** 存在 queued/running/waiting run 的任务；「执行中」只认它，不由 UI 推导。 */
  activeTaskIds: Set<Id>
  /** M6：当前规则集（整批替换；空集为 `[]`） */
  rules: AutomationRule[]
  /** M6：规则版本（随 `rules.replaced` 递增；无规则集为 0） */
  rulesVersion: number
  /** M6：本版规则集的替换时刻（cron 规则首次触发的基线）；无规则集为 null */
  ruleSetReplacedAt: Iso | null
  /** M6：规则 id → 最近一次 cron 触发的计划时刻（去重与「只补最近一次」） */
  ruleFiredAt: Map<Id, Iso>
}

/**
 * 内核限制：容量 / 租约 / 退避 / 超时 / 帧批次。
 *
 * `maxStagesPerWorkflow` 与 `maxArrayLength` 是 M1 留下的边界保护（阶段数量、
 * 事实 payload 数组长度）；其余取 SPEC-kernel「类型契约」的原值，宿主可注入缩短
 * （测试用），但语义不变。
 */
export interface Limits {
  /** 工作流阶段数上限（与 `protocol/validate` 的 stages 上限一致） */
  maxStagesPerWorkflow: number
  /** 事实 payload 里数组字段的上限（重建/装载的边界保护） */
  maxArrayLength: number
  /** 跳数熔断：`hops > maxHops` 只记 `event.dropped` */
  maxHops: number
  /** 领取租约时长 */
  leaseMs: number
  /** 心跳间隔（小于 leaseMs，留出续租失败的重试窗口） */
  heartbeatMs: number
  /** 累计失败次数上限：达到后落 `run.failed{executor_lost}` */
  maxAttempts: number
  /** 退避基数：`backoffBaseMs × 2^(attempts-1)` */
  backoffBaseMs: number
  /** 退避封顶（1 h） */
  backoffCapMs: number
  /** 单次运行超时（30 min），到期由 `clock.tick` 产 `run.failed{timeout}` */
  runTimeoutMs: number
  /** 取消宽限：cancel 帧后等待回执的时长 */
  cancelGraceMs: number
  /** SIGTERM 之后到 SIGKILL 的时长 */
  killAfterMs: number
  /** 单条 `run.frames` 事实的帧数上限，超出分包（不丢弃） */
  maxFramesPerBatch: number
}

export type IdKind =
  | 'workflow'
  | 'stage'
  | 'agent'
  | 'runtime'
  | 'task'
  | 'run'
  | 'message'
  | 'conversation'
  | 'card'
  /** 回执 `events[]` 派生的入账事件 id（M4 只记账，M6 规则用） */
  | 'event'
  /** M6：cron 触发记录 id（`rule_fires` 投影行） */
  | 'rule-fire'

/** 宿主在边界注入：时区、限制、id 生成器（内核不取随机数）。 */
export interface Environment {
  timezone: string
  limits: Limits
  nextId: (kind: IdKind) => Id
}

export type Reason = 'invalid_input' | 'not_found' | 'conflict' | 'forbidden' | 'unsupported'

/** 唯一决策结果；非法输入走 `reject`，不抛异常。 */
export interface Decision {
  facts: FactDraft[]
  reject?: { code: Reason; message: string }
}

/**
 * 宿主侧内核门面：store 只依赖这三个函数（+ 可选的 `nextWakeAt`），不直连具体实现。
 *
 * 参数写成方法签名（而非函数属性）：宿主注入的 `decide` / `viewSpec` 实现可以按
 * `Input` 收窄检查；调用方（store / clock）只依赖这里的契约。
 */
export interface KernelPort {
  decide(view: View, input: Input, now: Iso, env: Environment): Decision
  project(fact: Fact): Change[]
  viewSpec(input: Input): ProjectionTable[]
  /**
   * 下一次唤醒时刻（可选）：宿主时钟按它排唯一定时器。
   * 未注入时 `Store.nextWakeAt` 返回 null（时钟不排期），便于过渡期只装 decide/project/viewSpec。
   */
  nextWakeAt?(view: View, now: Iso, env: Environment): Iso | null
}
