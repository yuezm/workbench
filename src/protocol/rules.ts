/**
 * 自动化规则契约（M6）。
 *
 * 规则只建任务、不直接派活：命中后产 `task.created`，任务进入阶段后仍由
 * `entry_mode` 决定交给智能体 / 等人 / 停留。规则整批替换（`rules.replace`），
 * 版本随 `rules.replaced` 递增；非法整批拒绝、旧版继续生效。
 *
 * 形状上限在这里定义一次：`protocol/validate` 用它校验不可信输入，
 * 内核 `kernel/rules` 用它做决策前的前置校验（两端同一口径）。
 */

/** 规则字段上限（renderer / 内核共用；超限拒收，不截断）。 */
export const RULE_LIMITS = {
  /** 单次替换的规则条数 */
  rules: 100,
  /** 规则 id（renderer 生成，内核校验唯一与非空） */
  id: 128,
  /** 规则名 */
  name: 80,
  /** 事件来源（`*` 或小写标识） */
  source: 64,
  /** 单条规则的 type 匹配模式数量 */
  types: 20,
  /** 单个 type 匹配模式长度 */
  typePattern: 100,
  /** 任务标签数量与单个标签长度 */
  labels: 10,
  label: 32,
  /** 规则附加 prompt 长度 */
  prompt: 2000,
  /** 同规则并行数上限（M6 只存储，M6.5 线程落地时生效） */
  parallel: 8,
  /** cron 表达式长度 */
  cron: 100,
} as const

/** `titleFrom`：规则任务标题取事件的 `subject`（缺省）或 `summary`。 */
export const RULE_TITLE_FROM = ['subject', 'summary'] as const
export type RuleTitleFrom = (typeof RULE_TITLE_FROM)[number]

/** 线程归并键：缺省 `subject`（M6 只用于同规则去重，M6.5 线程按它归并）。 */
export const RULE_THREAD_KEY_FROM = ['subject', 'externalRef'] as const
export type RuleThreadKeyFrom = (typeof RULE_THREAD_KEY_FROM)[number]

/** 线程内已有任务时的策略（M6 只存储，M6.5 生效）。 */
export const RULE_ON_EXISTING = ['reuse-task', 'new-task'] as const
export type RuleOnExisting = (typeof RULE_ON_EXISTING)[number]

/** 合并策略（M6 只存储，M6.5 生效；缺省事件规则按 subject）。 */
export const RULE_MERGE = ['subject', 'none'] as const
export type RuleMerge = (typeof RULE_MERGE)[number]

/**
 * 事件型条件：`source` 精确匹配或 `*`；`types` 支持精确、`*`、前缀 `x.*`。
 */
export interface RuleEventWhen {
  source: string
  types: string[]
}

/** cron 型条件：5 字段表达式，由内核 `kernel/cron` 解析（非法整批拒绝）。 */
export interface RuleCronWhen {
  cron: string
}

/**
 * 规则目标：建任务到哪个工作流 / 起始阶段（缺省首阶段）。
 * `task.titleFrom` 缺省 `subject`；`thread` / `parallel` / `merge` 属于 M6.5 线程语义，
 * M6 只校验与存储。
 */
export interface RuleTarget {
  workflowId: string
  stageId?: string
  task?: {
    titleFrom?: RuleTitleFrom
    labels?: string[]
  }
  thread?: {
    keyFrom: RuleThreadKeyFrom
    onExisting?: RuleOnExisting
  }
}

/**
 * 自动化规则（SPEC-kernel「规则」）。
 * `when` 二选一：事件条件或 cron；同一事件命中多条规则时全部建任务，不排序。
 */
export interface AutomationRule {
  id: string
  name: string
  when: RuleEventWhen | RuleCronWhen
  to: RuleTarget
  /** 追加到本轮提示词的规则说明（固定文本，不拼外部事件正文） */
  prompt?: string
  /** 同规则并行数（缺省 1；M6.5 生效） */
  parallel?: number
  /** 合并策略（缺省事件规则按 subject；M6.5 生效） */
  merge?: RuleMerge
  enabled: boolean
}

/** 事件型条件判别：有 `cron` 即 cron 规则。 */
export const isCronRule = (rule: AutomationRule): rule is AutomationRule & { when: RuleCronWhen } =>
  'cron' in rule.when

/**
 * 规则集投影行（`rule_sets` 单行，`id='current'`）。
 *
 * 整批替换语义：`rules.replaced` 一次事实携带完整行，`project` 只做整行 upsert；
 * 版本与 `replacedAt` 同属一行，避免「规则删空后版本丢失」。
 */
export interface RuleSetRow {
  id: 'current'
  version: number
  /** 本次替换的事实时间（cron 规则首次触发的基线） */
  replacedAt: string
  rules: AutomationRule[]
}

/**
 * 规则触发投影行（`rule_fires`，append-only）。
 *
 * 只记 cron 到点触发（手动 `rule.trigger` 不记，追溯靠 `task.created` 的 `ruleId`）；
 * `scheduledFor` 是计划时刻（用于去重与「只补最近一次」），`taskId=null` 表示该次
 * 触发只记账（目标工作流/阶段已不存在）。
 */
export interface RuleFireRow {
  id: string
  ruleId: string
  version: number
  scheduledFor: string
  firedAt: string
  taskId: string | null
}

/** 规则集聚合视图（`rules.all`）：版本 + 当前规则清单。 */
export interface RuleSetView {
  version: number
  rules: AutomationRule[]
}
