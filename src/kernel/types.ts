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
  Project,
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
import type { PluginSettingsRow } from '../protocol/plugins'
import type { ThreadRow } from '../protocol/thread'
import type { TaskComment } from '../protocol/task-comment'
import type { ReviewReport } from '../protocol/review'

export type Seq = number
export type Id = string
export type Iso = string

/**
 * 内核版本；参与投影指纹，行为变化时递增，启动即触发重建。
 * M4：卡片与派生事件入账；M6：规则集与 cron 触发投影；M6.5：线程实体与事件合并；
 * M7：插件设置投影、跨工作流交接、外部插件与 webhook 端口；
 * M7.5：任务上下文 / 反馈（`task_comments` 投影 + 提示词反馈段）；
 * M10：项目（`projects` 第 16 张投影表 + 任务必须挂在项目下 + 运行工作目录取项目文件夹）；
 * M11：项目升为聊天与任务共用的顶层上下文（`Conversation.projectId`、任务可省项目落默认目录、
 * 删项目把会话归默认目录）；
 * M12：卡片加显式 `kind`（`cards.kind` 投影列）。投影列变了却没动版本，M12 前的库里那一列会按
 * ALTER 的默认值写成 ask，旧的信息卡全部冒充「待审批」，所以这里必须递增以触发重建。
 * M14：评审结论（`review_reports` 第 17 张投影表）——修理阶段要按阶段图取评审结论，
 * 而不是从被截断的 `runs.output` 摘要里猜。
 * M18：工作流内置四个阶段（`workflow_stages.builtin` 投影列）——老库的列一旦补出来，
 * 启动补齐按名认领 / 补建内置阶段，所以这里递增以触发一次重建。
 * M29：派单（`workflow_stages.handoffs_json`）——M7 的交接两列不再写入，存量行按
 * ALTER 的默认值会是空清单；不重建就等于把已有工作流的交接配置静默清零，
 * 所以这里必须递增，让 `normalizeStage` 按老事实的两列重新归一。
 * M30：派单来源 run（`tasks.handoff_from_run_id`）——去重粒度从「(任务, 阶段)」换成
 * 「这一次离开」，同一阶段第二次成功要能再派一张单。
 */
export const KERNEL_VERSION = 'M30.0.0'

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
 * M6 追加规则集与规则触发记录（第 11、12 张）；M6.5 追加线程（第 13 张）；
 * M7 追加插件设置（第 14 张）；M7.5 追加任务上下文 / 反馈（第 15 张）；
 * M10 追加项目（第 16 张）；M14 追加评审结论（第 17 张）。
 */
export const PROJECTION_TABLES = [
  'tasks',
  'workflows',
  'workflow_stages',
  'agents',
  'runtimes',
  'projects',
  'runs',
  'run_events',
  'conversations',
  'messages',
  'cards',
  'rule_sets',
  'rule_fires',
  'threads',
  'plugin_settings',
  'task_comments',
  'review_reports',
] as const

export type ProjectionTable = (typeof PROJECTION_TABLES)[number]

export type ProjectionRow =
  | Task
  | Workflow
  | WorkflowStage
  | Agent
  | Runtime
  | Project
  | RunRow
  | RunEventRow
  | Conversation
  | Message
  | Card
  | RuleSetRow
  | RuleFireRow
  | ThreadRow
  | PluginSettingsRow
  | TaskComment
  | ReviewReport

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
  /** M10：项目投影（任务归属校验与运行工作目录都只读它） */
  projects: Map<Id, Project>
  tasks: Map<Id, Task>
  /** M2：运行投影（领取 / 租约 / 终态判定都只读它，不查非投影表） */
  runs: Map<Id, RunRow>
  /** M4：卡片投影（回答校验、同 key 去重、续接提示词都只读它） */
  cards: Map<Id, Card>
  conversations: Map<Id, Conversation>
  messages: Map<Id, Message>
  /** M6.5：线程投影（事件归并、复用任务、并发闸门、上下文派生都只读它） */
  threads: Map<Id, ThreadRow>
  /**
   * M15：产物落盘根（`<userData>/artifacts`）。宿主装载视图时注入，内核只拿它拼
   * 「任务索引」里的产物路径，**不读文件**。缺省 / null 时索引只给 runId，不给路径
   * （测试与未配置产物的场景）。
   */
  artifactsRoot?: string | null
  /** M7.5：任务上下文 / 反馈（拼提示词时按 taskId 取；待落库的新评论经 options 传） */
  taskComments: Map<Id, TaskComment>
  /** M14：评审结论（修复阶段按阶段图定位、索引段渲染、逐条覆盖检查都只读它） */
  reviewReports: Map<Id, ReviewReport>
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
  /** M7：插件设置快照（整批替换；空快照为空数组） */
  pluginSettings: PluginSettingsRow['settings']
  /** M7：插件设置版本（随 `plugins.replaced` 递增；无快照为 0） */
  pluginSettingsVersion: number
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
  /** 单次运行超时缺省值（60 min），到期由 `clock.tick` 产 `run.failed{timeout}`；阶段可用 `runTimeoutMs` 覆盖 */
  runTimeoutMs: number
  /** 取消宽限：cancel 帧后等待回执的时长 */
  cancelGraceMs: number
  /** SIGTERM 之后到 SIGKILL 的时长 */
  killAfterMs: number
  /** 单条 `run.frames` 事实的帧数上限，超出分包（不丢弃） */
  maxFramesPerBatch: number
  /** 单条回执 `spawn[]` 上限（M8；可选，缺省取 32） */
  maxSpawnItems?: number
  /** 派生子任务深度上限（M8；可选，缺省取 8） */
  maxSpawnDepth?: number
}

export type IdKind =
  | 'workflow'
  | 'stage'
  | 'agent'
  | 'runtime'
  /** M10：项目 id（`projects` 投影行） */
  | 'project'
  | 'task'
  | 'run'
  | 'message'
  | 'conversation'
  | 'card'
  /** 回执 `events[]` 派生的入账事件 id（M4 只记账，M6 规则用） */
  | 'event'
  /** M6：cron 触发记录 id（`rule_fires` 投影行） */
  | 'rule-fire'
  /** M6.5：线程 id 与线程笔记 id（`threads` 投影行 / 笔记） */
  | 'thread'
  | 'thread-note'
  /** M7.5：任务上下文 / 反馈 id（`task_comments` 投影行） */
  | 'task-comment'

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
