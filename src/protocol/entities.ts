/**
 * 投影表（tasks / workflows / workflow_stages / agents / runtimes，M2 起加
 * runs / run_events / conversations / messages，M4 加 cards）的行类型与输入类型，
 * 以及命令/事实/视图共用的枚举常量。
 *
 * 契约层是 kernel 唯一允许依赖的模块（kernel 只 `import type`，运行期不依赖）；
 * M5 起 preload / renderer 直接从这里与 `protocol/{commands,views,ipc}.ts` 取类型
 * （`shared/ai-workflow-api.ts` 已删除），因此字段名与仓库现有列映射必须逐字对应。
 */

/**
 * 实体表白名单（M1 五张配置/任务表）：`snapshot.imported` 的实体表联合与
 * 导入校验用它。投影全集见 `kernel/types.ts` 的 `PROJECTION_TABLES`。
 */
export const ENTITY_TABLES = [
  'tasks',
  'workflows',
  'workflow_stages',
  'agents',
  'runtimes',
] as const

export type EntityTable = (typeof ENTITY_TABLES)[number]

// ---------- 运行时 ----------

/**
 * 执行器键（M3）：运行时配置指向 `src/plugins/registry.ts` 里的执行器插件。
 * 只校验形状（slug），**不校验取值**——取值合法性由宿主入口按注册表判断，
 * 内核因此不认识任何产品名（SPEC-kernel「派活单位」）。
 */
export const EXECUTOR_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/**
 * 参数模板占位符白名单（`command` 执行器的 `argsTemplate`）。
 * 提示词只能替换成独立 argv 元素或走 stdin，**不得拼进命令行字符串**。
 */
export const ARGV_PLACEHOLDERS = ['model', 'effort', 'cwd', 'context', 'prompt'] as const

export type ArgvPlaceholder = (typeof ARGV_PLACEHOLDERS)[number]

/** 非交互权限：stdio 传输没有审批往返，越界操作直接失败 */
export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** 运行时健康状态（持久化的是最近一次探测结论） */
export const PROBE_STATES = ['ready', 'unavailable'] as const

export type RuntimeProbeState = (typeof PROBE_STATES)[number]

/** 一次探测的结论（--probe 帧 + CLI 版本 + 可执行文件解析） */
export interface RuntimeProbe {
  state: RuntimeProbeState
  /** 解析到的可执行文件绝对路径；解析失败为 null */
  path: string | null
  /** CLI 版本（dsh --version）；读不到为 null */
  cliVersion: string | null
  /** 协议版本（--probe 帧的 protocol_version）；失败为 null */
  protocolVersion: number | null
  /** 协议插件版本（--probe 帧的 plugin_version，可空） */
  pluginVersion: string | null
  /** 失败原因；ready 时为 null */
  error: string | null
  /** 输出尾部（诊断用，已截断） */
  output: string
  /** 探测耗时（毫秒） */
  elapsedMs: number
  /** 探测完成时间（ISO） */
  checkedAt: string
}

/**
 * 运行时配置 = **一条连接**：用哪个执行器协议、怎么把 CLI 起来、可选启动参数、是否可用。
 *
 * 执行期的配置（模型、思考强度、并发上限、访问权限、工作目录、环境变量）在智能体上
 * （见 `Agent`）；执行器插件也据此只从 `Turn` 读执行配置，从 `ExecutorContext.runtime`
 * 只读连接字段。
 */
export interface Runtime {
  id: string
  name: string
  /** 执行器插件键（M3）：决定「怎么调起一轮」，不决定派给谁 */
  executorKey: string
  /** 启动命令：命令名或绝对路径（默认值由执行器插件 manifest 提供） */
  command: string
  /** 启动 profile（dsh 用它选 --stdio/--probe；其它执行器可为空串） */
  profile: string
  /** `command` 的参数模板（JSON 数组文本，`command` 执行器用；空串 = 无参数） */
  argsTemplate: string
  /** 停用后不再派发执行 */
  enabled: boolean
  createdAt: string
  /** 最近一次探测结论；从未探测为 null */
  lastProbe: RuntimeProbe | null
}

export interface RuntimeInput {
  name: string
  executorKey?: string
  command?: string
  profile?: string
  /** `command` 执行器的参数模板（JSON 数组文本） */
  argsTemplate?: string
  enabled?: boolean
}

/**
 * 本机已安装的 agent CLI 探测结果（用于表单预填，不自动创建运行时）。
 *
 * M3 起由执行器插件各自的 `detect()` 汇总：`executorKey` 由注册表填，
 * `supported` = 注册表里是否存在该执行器（保留三态 UI 行为）。
 */
export interface DetectedRuntime {
  /** CLI 命令名，如 dsh / claude */
  command: string
  /** 展示名，如 "DeepSeek Harness" */
  label: string
  /** 可执行文件绝对路径 */
  path: string
  /** 对应的执行器插件键；本机已装但无插件时为 '' */
  executorKey: string
  /** 是否已有执行器插件可接入（registry 里存在该 key） */
  supported: boolean
}

/**
 * 运行时的动态负载（不落库，按 runs 现算；`runtimes.statuses` 视图与调度器同口径）。
 *
 * 并发上限不在这里：它是智能体的设置，同一个连接上可以挂多个智能体、各有各的窗口。
 */
export interface RuntimeStatus {
  runtimeId: string
  workload: {
    running: number
    queued: number
  }
}

/**
 * 运行时表单可选的执行器（只读，来自插件注册表）。
 *
 * `command` / `profile` 是该插件 manifest 声明的表单默认值；新建运行时选执行器时
 * 用它预填，用户仍可改。数组顺序即注册表顺序（UI 下拉顺序）。
 */
export interface RuntimeExecutorChoice {
  key: string
  label: string
  command: string
  profile: string
}

/** 执行器 `models()` 的模型目录项；字段与旧 `RuntimeModelOption` 一致 */
export interface RuntimeModelOption {
  /** provider/model 形式的 id，可直接写入 `Agent.model` */
  id: string
  label: string
  provider: string
  /** 是否为 CLI 默认模型 */
  default: boolean
  /** 支持的推理强度（thinking level） */
  thinkingLevels: string[]
  defaultThinkingLevel: string | null
}

// ---------- 项目 ----------

/**
 * 项目（M10）：本地一个文件夹 + 名字，是任务的容器与执行工作目录。
 *
 * - 任务必须挂在项目下（`Task.projectId`）：人建任务时内核要求项目存在；
 *   派生 / 交接任务继承来源任务的项目；v2 存量与旧事实没有项目，按 null 归一（「未归属」）。
 * - `path` 是绝对路径，也是该项目任务的运行工作目录（`RunRow.cwd`）：内核只做形状校验，
 *   目录是否存在 / 可写由宿主（文件夹选择器）与执行器负责。
 * - `updatedAt` 只在改名 / 换目录 / 改备注时更新（`project.updated` 携带完整行）。
 */
export interface Project {
  id: string
  name: string
  /** 本地文件夹绝对路径（工作目录） */
  path: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface ProjectInput {
  name: string
  path: string
  description?: string
}

// ---------- 智能体 ----------

/** 智能体环境变量上限（每个变量一个键值对；键必须是合法环境变量名）。 */
export const AGENT_ENV_LIMITS = { maxVars: 32, maxKeyChars: 64, maxValueChars: 1000 } as const

/** 环境变量名：字母或下划线开头，后接字母数字下划线（与 POSIX 口径一致）。 */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 智能体 = 派活目标 + 执行配置。
 *
 * - 连接是运行时的事（`runtimeId` → 命令/profile/参数模板/执行器协议）；
 * - 执行配置是智能体的事：模型、思考强度、并发上限、访问权限、工作目录、环境变量。
 *   派活时内核据此写 `run.cwd` / `run.access`，激活时宿主据此拼 `Turn`。
 */
export interface Agent {
  id: string
  name: string
  description: string
  runtimeId: string
  systemPrompt: string
  /** 模型 id（provider/model 形式）；null = 用 CLI 默认模型 */
  model: string | null
  /** 思考强度；null = 用模型默认 */
  reasoningEffort: string | null
  /** 并发上限（同一智能体同时执行的任务数） */
  maxConcurrent: number
  /** 访问权限（沙箱基线）；派活时映射成 `run.access` */
  permissionMode: PermissionMode
  /** 执行工作目录；null = 用项目的文件夹 / 主进程当前目录 */
  workdir: string | null
  /** 追加给子进程的环境变量（键值都原样传给执行器） */
  env: Record<string, string>
  createdAt: string
}

export interface AgentInput {
  name: string
  description?: string
  runtimeId: string
  systemPrompt?: string
  model?: string | null
  reasoningEffort?: string | null
  maxConcurrent?: number
  permissionMode?: PermissionMode
  workdir?: string | null
  env?: Record<string, string>
}

// ---------- 工作流 / 阶段 ----------

/** 阶段入口模式：none = 停留，agent = 交给阶段绑定的智能体，user = 等人 */
export const ENTRY_MODES = ['none', 'agent', 'user'] as const

export type EntryMode = (typeof ENTRY_MODES)[number]

/**
 * 阶段类别（M18）：看板与编辑器按类别取色，也决定默认流转怎么走。
 *
 * - `pending`（未开始）：任务还没动，只有内置「待办」；
 * - `active`（进行中）：内置「已阻塞」+ 全部自己添加的阶段；
 * - `done`（已完成）：内置「已完成」，默认流转的终点；
 * - `closed`（已关闭）：内置「已取消」，只能手动进入。
 */
export const STAGE_KINDS = ['pending', 'active', 'done', 'closed'] as const

export type StageKind = (typeof STAGE_KINDS)[number]

/**
 * 系统内置阶段的键（M18）：每个工作流必有这四个阶段，删不掉、改不了名，
 * 其余字段（进入时交给 / 智能体 / 要干什么 / 闸门 / 流转目标）照常可改。
 *
 * 顺序即看板顺序：待办 → 自己添加的阶段 → 已阻塞 → 已完成 → 已取消。
 * 「已完成」「已取消」是终态，不允许再交接。
 */
export const BUILTIN_STAGE_KEYS = ['todo', 'blocked', 'done', 'cancelled'] as const

export type BuiltinStageKey = (typeof BUILTIN_STAGE_KEYS)[number]

/** 内置阶段的固定名称（改名请求由内核拒绝，投影里恒为这张表的值）。 */
export const BUILTIN_STAGE_NAMES: Readonly<Record<BuiltinStageKey, string>> = {
  todo: '待办',
  blocked: '已阻塞',
  done: '已完成',
  cancelled: '已取消',
}

/** 内置阶段 → 类别。 */
export function builtinStageKind(key: BuiltinStageKey): StageKind {
  switch (key) {
    case 'todo':
      return 'pending'
    case 'blocked':
      return 'active'
    case 'done':
      return 'done'
    case 'cancelled':
      return 'closed'
  }
}

/** 阶段的类别：内置阶段按键取，自己添加的阶段一律「进行中」。 */
export function stageKindOf(stage: { builtin?: BuiltinStageKey | null }): StageKind {
  return stage.builtin ? builtinStageKind(stage.builtin) : 'active'
}

/** 名称是否被内置阶段占用（自己添加的阶段不能叫这些名字）。 */
export function isBuiltinStageName(name: string): boolean {
  return BUILTIN_STAGE_KEYS.some((key) => BUILTIN_STAGE_NAMES[key] === name.trim())
}

/**
 * 子任务全部结束时父任务的处理（M8）：
 * `wake` = 唤醒父 Agent 续接决定；`notify` = 只开信息卡等人；`complete` = 父任务直接完成。
 */
export const ON_CHILDREN_SETTLED = ['wake', 'notify', 'complete'] as const

export type OnChildrenSettled = (typeof ON_CHILDREN_SETTLED)[number]

/** 阶段是否允许 Agent 派生子任务（M8）：`off` = 一律丢弃；`agent` = 由 Agent 自决。 */
export const SPAWN_POLICIES = ['off', 'agent'] as const

export type SpawnPolicy = (typeof SPAWN_POLICIES)[number]

/**
 * 闸门判定（M11）：阶段 run 正常结束后，由智能体对「这一阶段做成了没有」下结论。
 * 与 `run.status` 正交——`succeeded` 只说明执行器跑完了，`fail` 才是业务上没过。
 */
export const GATE_VERDICTS = ['pass', 'fail'] as const

export type GateVerdict = (typeof GATE_VERDICTS)[number]

/** 判定证据：模型自报跑了什么、退出码是多少；内核用它交叉校验 `verdict`。 */
/** 验收条目上限（M20）：条数与单条长度都由内核归一，UI 只做提示。 */
export const ACCEPTANCE_LIMITS = { maxItems: 12, maxChars: 200 } as const

/**
 * 阶段内轮次上限（M21）：run 结束但验收未全达时原地续一轮的次数。
 *
 * 下限 1 = 不续轮（老行为）；上限 5 = 防烧 token 的硬护栏。
 */
export const STAGE_ROUND_LIMITS = { min: 1, max: 5 } as const

/**
 * 阶段单轮运行超时（M26）：不配就取全局缺省 `limits.runTimeoutMs`（60 min）。
 *
 * 下限 5 分钟 = 低于这个值只会把还在推理的 run 掐死；上限 4 小时 = 防悬空烧钱的硬护栏。
 * 单位毫秒，与 `RunRow.deadlineAt` 的计算口径一致。
 */
export const STAGE_TIMEOUT_LIMITS = { minMs: 5 * 60_000, maxMs: 240 * 60_000 } as const

export interface GateCheck {
  /** 实际执行的命令（如 `pnpm check`） */
  cmd: string
  exitCode: number
}

/**
 * 判定者（M32，原闸门配置收窄）：只回答「谁给结论、放行护栏多大」，去向在 `exits` 里。
 *
 * 判定发生在该阶段 run 正常结束之后，读回执的 `verdict`：
 * - `pass` → 走 `exits.passed`；
 * - `fail` 且未达护栏 → 走 `exits.failed`，任务上的连续未通过次数 +1；
 * - `fail` 且已达护栏 → **放行**（改走 `exits.passed`），由内核打 `gate:degraded` 标签留痕。
 *
 * `maxFails = null` 表示不设护栏（失败永远按 `exits.failed` 走）。执行出错不消耗预算。
 */
export interface JudgeConfig {
  /** 允许连续未通过的次数；null = 不设护栏 */
  maxFails: number | null
}

export interface JudgeInput {
  maxFails?: number | null
}

/** 离开阶段的触发条件（主去向表按它分组，恰好一条） */
export const STAGE_EXIT_GUARDS = ['done', 'errored', 'passed', 'failed'] as const

export type StageExitGuard = (typeof STAGE_EXIT_GUARDS)[number]

/** 主去向的动作 */
export const STAGE_EXIT_ACTIONS = ['goto', 'await', 'close', 'retry'] as const

export type StageExitAction = (typeof STAGE_EXIT_ACTIONS)[number]

/** 原地重跑的次数上限（1–5）：下限 1 = 只重跑一次，上限防烧 token。 */
export const STAGE_EXIT_RETRY_LIMITS = { min: 1, max: 5 } as const

/**
 * 主去向（M32）：一张工单离开本阶段时**只能**落到一个去处。
 *
 * - `goto`：同一张工单进另一个阶段；
 * - `await`：显式停在这里等人（不是「没有出口」，是「出口就是等人」）；
 * - `close`：本单结束并归档（工单模型里执行完就结束）；
 * - `retry`：原地再跑一轮，最多 `max` 次；用尽后按 `close` 收口并打 `stage:failed`（M33）。
 *
 * 派单（跨工作流建新工单）不在这里——它不终结本单，见 `StageHandoff`。
 */
export type StagePrimary =
  { do: 'goto'; stageId: string } | { do: 'await' } | { do: 'close' } | { do: 'retry'; max: number }

/** 出口表：每个触发条件最多一条主去向；保存时由内核补齐缺省。 */
export type StageExits = Partial<Record<StageExitGuard, StagePrimary>>

/**
 * 派单的触发条件（M29）：离开一个阶段有五种触发，每种都能单独指定要不要派单、派给谁。
 *
 * - `done`：执行器正常结束，且本阶段没有判定（判定的阶段跑完不构成去向）；
 * - `errored`：执行出错（非零退出 / 超时 / 失联），与业务过没过无关；
 * - `passed` / `failed`：判定的两侧（原闸门的通过与未通过）；
 * - `manual`：人工拖动卡片 / 点「完成任务」。
 */
export const STAGE_HANDOFF_GUARDS = ['done', 'errored', 'passed', 'failed', 'manual'] as const

export type StageHandoffGuard = (typeof STAGE_HANDOFF_GUARDS)[number]

/**
 * 一条派单（M29，取代 M7 的 `handoffWorkflowId` / `handoffStageId` 两列）：
 * 任务离开本阶段且触发条件命中时，在目标工作流建一张新工单。
 *
 * 派单**不终结本单**——本单的去向仍由 `onComplete` / `onReject` / `gate` 决定，
 * 所以同一个触发条件可以同时「进下一阶段」和「派一张单」，也可以只派单本单照旧流转。
 */
export interface StageHandoff {
  on: StageHandoffGuard
  /** 目标工作流（不能是自身） */
  workflowId: string
  /** 目标阶段（必须属于 `workflowId`）；null = 目标工作流首个阶段 */
  stageId: string | null
  /** 只对 `manual` 有意义：拖到更前阶段（返工）不派单。缺省 = true */
  forwardOnly?: boolean
}

export interface WorkflowStage {
  id: string
  workflowId: string
  name: string
  position: number
  entryMode: EntryMode
  agentId: string | null
  /**
   * 系统内置阶段的键（M18）：内置阶段恒有值，自己添加的阶段为 null。
   * 内置阶段不可删除、不可改名，位置由内核按类别归一。
   */
  builtin?: BuiltinStageKey | null
  /**
   * 出口表（M32）：每个触发条件一条主去向；取代 `on_complete_stage_id` / `on_reject_stage_id` /
   * 闸门两侧四列。老事实由 `normalizeStage` 按旧字段合成。
   */
  exits: StageExits
  /**
   * 派单（M29）：按触发条件分组的跨工作流交接。老事实缺该字段时按 M7 两列归一
   * （见 `kernel/workflow/stage-handoffs.ts#legacyHandoffs`）。
   */
  handoffs: StageHandoff[]
  /** M8：本阶段派生的子任务默认落点阶段；null = 父任务当前阶段 */
  subtaskStageId?: string | null
  /** M8：子任务全部结束时父任务处理；null = 按 entryMode 推断（agent→wake，否则 notify） */
  onChildrenSettled?: OnChildrenSettled | null
  /** M8：本阶段是否允许 Agent 派生子任务；null = 按 `agent` 处理 */
  spawnPolicy?: SpawnPolicy | null
  /**
   * 阶段要干什么（M9）：这个阶段的具体事项，纯文本、按原样拼进阶段任务提示词。
   * 老事实 / 存量导入缺该字段时按空串归一。
   */
  instructions?: string
  /**
   * 验收条目（M20）：本阶段「做完」的可判定口径，一条一句、独立成段拼进提示词。
   * 进入本阶段的任务跑完一轮后由回执 `acceptance[]` 逐条自评；`[]` = 未声明（不做自评）。
   * 老事实 / 存量导入缺该字段时按空数组归一。
   */
  acceptance?: readonly string[]
  /**
   * 阶段内轮次上限（M21）：run 结束但验收未全达时原地续一轮，不流转；
   * `null` / 缺省 = 1（不续轮，老行为）。
   */
  maxRounds?: number | null
  /**
   * 单轮运行超时（M26）：本阶段一次 run 最长跑多久（毫秒）。
   * `null` / 缺省 = 用全局缺省 `limits.runTimeoutMs`（60 min）。
   */
  runTimeoutMs?: number | null
  /**
   * 判定者（M32，原闸门）：非 null 时本阶段读回执 `verdict` 决定走 `exits.passed` 还是
   * `exits.failed`。老事实 / 存量导入缺该字段时按 null 归一（不判定）。
   */
  judge: JudgeConfig | null
}

/** 出口表的一行（保存形态）：`stageIndex` 是 `stages` 数组下标。 */
export interface StageExitInput {
  on: StageExitGuard
  do: StageExitAction
  /** do='goto' 时的目标下标 */
  stageIndex?: number | null
  /** do='retry' 时的重跑上限（1–5） */
  max?: number | null
}

export interface StageInput {
  /** 更新时回传既有阶段 id（保留历史、不重建）；新建时忽略 */
  id?: string
  name: string
  entryMode: EntryMode
  /**
   * 内置阶段的键（M18）：UI 提交内置阶段时带上，内核据此锁名、锁位、锁类别。
   * 自己添加的阶段不填（填了由内核拒绝）。
   */
  builtin?: BuiltinStageKey | null
  agentId?: string | null
  /**
   * 出口表（M32）：每项一个触发条件 + 一个主去向；`stageIndex` 是 `stages` 数组下标。
   * 缺省的触发条件由内核补齐（done → 下一阶段，errored / failed → await）。
   */
  exits?: readonly StageExitInput[]
  /**
   * 派单（M29，可空 = 不派单）：按触发条件分组的跨工作流交接；
   * 目标工作流 / 阶段的存在性与自指由内核按视图判。
   */
  handoffs?: readonly StageHandoff[]
  /** 子任务默认落点阶段 id（M8，可空 = 父任务当前阶段；须属于本工作流） */
  subtaskStageId?: string | null
  /** 子任务全部结束时的父任务处理（M8，可空 = 按 entryMode 推断） */
  onChildrenSettled?: OnChildrenSettled | null
  /** 是否允许 Agent 派生子任务（M8，可空 = agent） */
  spawnPolicy?: SpawnPolicy | null
  /** 阶段要干什么（M9，可空 = 空串）：本阶段具体事项，会拼进阶段任务提示词交给智能体 */
  instructions?: string
  /**
   * 验收条目（M20，可空 = 空数组）：一条一句的可判定口径；超过 `ACCEPTANCE_LIMITS`
   * 会被内核截断/去重，不做静默丢弃以外的补偿。
   */
  acceptance?: readonly string[]
  /** 阶段内轮次上限（M21，可空 = 1）：run 结束但验收未全达时原地续一轮的次数 */
  maxRounds?: number | null
  /** 单轮运行超时（M26，可空 = 全局缺省 60 min）：本阶段一次 run 的最长时长（毫秒） */
  runTimeoutMs?: number | null
  /** 判定者（M32，可空 = 不判定）：非空时本阶段按回执 `verdict` 走 passed / failed 两侧 */
  judge?: JudgeInput | null
}

export interface Workflow {
  id: string
  name: string
  description: string
  createdAt: string
}

export interface WorkflowWithStages extends Workflow {
  stages: WorkflowStage[]
}

export interface WorkflowInput {
  name: string
  description?: string
  stages: StageInput[]
}

// ---------- 任务 ----------

/** 任务状态：active = 看板上进行中，completed = 移出看板 */
export const TASK_STATUSES = ['active', 'completed'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * 任务来源（M6/M7/M8）：`manual` = 人手建；`rule` = 自动化规则命中（含 cron / 手动触发）；
 * `handoff` = 跨工作流交接产物（来源任务的某阶段完成时在目标工作流建的任务）；
 * `spawn` = Agent 回执 `spawn[]` 派生出的子任务。
 * 规则任务记录 `ruleId` 与 `externalRef`；交接任务记录 `handoffFromTaskId` / `handoffFromStageId`；
 * spawn 任务记录 `spawnedByRunId` / `batchNo` / `spawnKey`，并以 `parentTaskId` 挂父任务。
 */
export const TASK_ORIGINS = ['manual', 'rule', 'handoff', 'spawn'] as const

export type TaskOrigin = (typeof TASK_ORIGINS)[number]

export interface Task {
  id: string
  title: string
  description: string
  workflowId: string
  /**
   * 所属项目（M10）：人建任务时必须给定（内核校验项目存在），派生 / 交接任务继承来源任务，
   * v2 存量与旧事实按 null 归一（界面上归入「未归属」）。
   */
  projectId: string | null
  currentStageId: string | null
  status: TaskStatus
  /** 本阶段原地重跑过几次（M33）：进入新阶段清零，`retry` 出口用它计预算。 */
  stageFails: number
  /**
   * 闸门预算（M11）：**当前阶段**连续未通过次数。进入阶段时清零（失败回环保留累计值），
   * 闸门判定 `pass` 或预算耗尽放行时清零。老事实 / 存量导入缺该字段时按 0 归一。
   */
  gateFails?: number
  /** 来源；v2 存量与手工任务为 `manual` */
  origin: TaskOrigin
  /** 命中/触发的规则；手工任务为 null */
  ruleId: string | null
  /** 规则入口键（同规则去重）；手工任务与无键规则触发为 null */
  externalRef: string | null
  /** 规则声明并落到任务上的标签（看板只读展示，不参与派活） */
  labels: string[]
  /** 所属线程（M6.5）：事件任务挂外部入口线程，手工任务挂隐式线程；旧行按 null 归一 */
  threadId: string | null
  /** 父任务（派生 / spawn 建的任务必填；无派生为 null）；看板据此展示任务树 */
  parentTaskId: string | null
  /** M8：派生出本任务的 run（`origin='spawn'` 时非 null；内核从 run.taskId 推导） */
  spawnedByRunId?: string | null
  /** M8：子任务批次（≥1；未分批为 null；v1 不区分批次） */
  batchNo?: number | null
  /** M8：spawn 幂等键（同一父任务下唯一；非 spawn 为 null） */
  spawnKey?: string | null
  /** 交接来源任务（M7，`origin='handoff'` 时非 null）：本任务由哪个任务的阶段完成产出 */
  handoffFromTaskId: string | null
  /** 交接来源阶段（M7，`origin='handoff'` 时非 null）：触发交接的阶段 id */
  handoffFromStageId: string | null
  /**
   * 派单来源 run（M30）：这一次「离开阶段」的结算来自哪一轮。
   * 同一 run 只派一批（重放 / 重复处理不重复建单）；人工拖动 / 完成任务没有 run，按 null 落。
   */
  handoffFromRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskInput {
  title: string
  description?: string
  workflowId: string
  /**
   * 所属项目（M10 必填 → M11 可选）：给了就必须存在，任务的运行工作目录取该项目文件夹；
   * 省 / null = 默认目录（与聊天同口径，`Task.projectId` 落 null）。
   */
  projectId?: string | null
  /** 起始阶段；缺省为首阶段 */
  stageId?: string
  /** M8：人工挂子任务时的父任务 id（校验父存在、同工作流、active） */
  parentTaskId?: string
}

// ---------- 运行 ----------

/**
 * 运行状态：`waiting` = 回执带 `ask[]` 挂起等回答（释放租约与并发位，但仍算「执行中」）。
 * 取值顺序即 UI/文档的展示顺序，`queued` → `running` → 终态，`waiting` 是运行中的一种。
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

/** 终态子集：执行器回执与宿主兜底只能落到这三个。 */
export const RUN_TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const

export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number]

/**
 * 运行失败归类：UI 按此给出可操作提示。
 * `executor_lost` 是 M2 新增的第 10 个取值（租约过期达 `maxAttempts` 后宿主兜底），
 * 只增不改，语义见 SPEC-kernel「调度」。
 */
export const RUN_ERROR_CODES = [
  'spawn_failed',
  'exit_nonzero',
  'run_failed',
  'timeout',
  'cancelled',
  'protocol_error',
  'no_result',
  'runtime_missing',
  'runtime_disabled',
  'executor_lost',
] as const

export type RunErrorCode = (typeof RUN_ERROR_CODES)[number]

/** 运行目的：`stage` = 阶段执行（挂任务），`chat` = 聊天轮次（挂对话）。 */
export const RUN_PURPOSES = ['stage', 'chat'] as const

export type RunPurpose = (typeof RUN_PURPOSES)[number]

/** 运行事件类型（协议帧归一后的增量类型） */
export const RUN_EVENT_TYPES = ['status', 'text', 'thinking', 'tool_call', 'tool_result'] as const

export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

/** 运行事件（协议帧归一）；IPC 事件流与 `run.frames` 事实的帧共用这一形状。 */
export interface RunEvent {
  seq: number
  type: RunEventType
  /** text / thinking 的增量文本 */
  text?: string
  /** tool_call / tool_result 的工具名 */
  tool?: string
  /** tool_call / tool_result 的调用 id */
  callId?: string
  /** tool_call 的参数（JSON 字符串） */
  input?: string
  /** tool_result 的输出 */
  output?: string
  /** tool_result 是否失败 */
  isError?: boolean
  /** status 事件的阶段文案（如 running） */
  status?: string
}

/**
 * `run_events` 投影行：事件挂到 run 上。
 * 事实里 `run.frames` 的帧已由宿主按 run 分配全局单调 `seq`（D6），
 * 所以主键是 `(runId, seq)`，`Change.key = '<runId>:<seq>'`。
 */
export interface RunEventRow extends RunEvent {
  runId: string
}

/** 一次运行的 token 用量（按协议帧累加；终态事实携带最终值覆盖） */
export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * IPC 运行行（renderer / preload 看到的 `Run`）：字段与 M1 完全一致，IPC 形状不变。
 * 投影行在它之上多了调度列（见 `RunRow`），调度列不外露给 IPC。
 */
export interface Run {
  id: string
  taskId: string
  stageId: string | null
  agentId: string | null
  /** 执行该 run 的运行时（运行时被删后置空） */
  runtimeId: string | null
  status: RunStatus
  prompt: string
  /** 最终文本输出（事件流的 text 汇总） */
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  /** CLI 进程退出码；未能启动或超时后强杀为 null */
  exitCode: number | null
  /** 协议会话 id（可用于续接） */
  sessionId: string | null
  usage: RunUsage | null
  /** 执行耗时（毫秒） */
  durationMs: number | null
  /**
   * 本轮的**实际**权限级别（`read` / `edit` / `full`）。
   *
   * 不等于智能体上配的 `permissionMode`：闸门阶段内核会把它抬到 `full`
   * （`kernel/task-effects.ts#runAccessOf`），所以任务详情展示的是这个值。
   * 投影行里一直有它，之前只是没进 IPC 契约。
   */
  access: Access
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

/**
 * `runs` 投影行：IPC 行 + 调度状态。
 *
 * - `taskId` 可空：聊天 run 不挂任务（D8；`runs.byTask` 只返回 `purpose='stage'`）。
 * - `attempt` = 当前第几次领取（1 基，来自 `run.claimed`）；
 *   `attempts` = 累计失败次数（来自 `run.abandoned`，达到 `maxAttempts` 落终态）。
 */
export interface RunRow extends Omit<Run, 'taskId'> {
  purpose: RunPurpose
  taskId: string | null
  /** 聊天 run 挂的对话；阶段 run 为 null */
  conversationId: string | null
  /** 命中/触发来源（阶段 run 记规则版本；手工任务为 null/0） */
  ruleId: string | null
  rulesVersion: number
  /** 执行器键：取自运行时配置的 `executorKey`（M3），决定「怎么调起」 */
  executorKey: string
  threadId: string | null
  /** 执行目录（来自项目 / 阶段配置，不由事件携带） */
  cwd: string
  skill: string | null
  /** 提示词里的资料文件引用（不是指令） */
  promptRef: string | null
  /** 触发本轮的原始事件 id（合并入口） */
  eventIds: string[]
  /** 跳数（事件被 Agent 再派生的层数） */
  hops: number
  /** 第几轮（续接递增，1 基） */
  turn: number
  /** 上一轮的协议会话 id；首轮为 null */
  resumeSessionId: string | null
  threadContextRef: string | null
  /** 入队事实的 seq（领取 FIFO 的稳定序号；由 `project` 在 run.queued 时写入） */
  queueSeq: number
  /** 本次领取凭证 `<runId>:<attempt>`；未领取/终态为 null */
  leaseId: string | null
  attempt: number
  attempts: number
  leaseUntil: string | null
  /** 最早可领取时刻（退避 / 等待回答后续接）；null = 立即可领 */
  notBefore: string | null
  /** 运行超时时刻（领取时写 `now + runTimeoutMs`，D5） */
  deadlineAt: string | null
  /** 已请求取消（`run.cancel_requested`），宿主管完终止流程后落终态 */
  cancelRequested: boolean
  /**
   * 阶段交付物（M28）：本轮产出的分支 / 基线 / 提交 / 文件 / 门禁证据。
   *
   * 由回执 `deliverables` 写入（写前过 `normalizeDeliverables` 补齐缺项），没声明为 null。
   * 加它的原因：实测合并阶段拿到的是散文（「分支 feat/x，提交 abc123」），它只能重新
   * `git log` / `git worktree list` 考古（线程 `27787670` 的合并 run 前 40 帧里 12 次在做
   * 这件事）。结构化后下游直接读。
   */
  deliverables: RunDeliverables | null
}

/** 交付物条目上限（校验与提示词裁剪共用）。 */
export const DELIVERABLE_LIMITS = {
  /** 提交数上限 */
  maxCommits: 20,
  /** 文件路径数上限 */
  maxFiles: 40,
  /** 单个字符串（分支名 / 路径 / 提交）的码点上限 */
  maxChars: 200,
} as const

/** 阶段交付物（回执 `deliverables`，M28）。落库后的形态：五项都在，没有的写 null / 空数组。 */
export interface RunDeliverables {
  /** 工作分支；不产分支的阶段为 null */
  branch: string | null
  /** 基线（如 `develop` / 某个 commit） */
  base: string | null
  /** 提交列表（短 hash 即可） */
  commits: string[]
  /** 产出/改动文件（相对项目根） */
  files: string[]
  /** 门禁证据（命令 + 退出码），与闸门 `checks` 同形 */
  gates: GateCheck[]
}

/**
 * 回执侧的交付物输入：**只声明本阶段真产出的项**（README 与回执说明都这么写，
 * 校验也允许 `{branch}` 这种形状），缺项由 `normalizeDeliverables` 补齐。
 *
 * 两者分开的原因：`RunDeliverables` 是落库形态，下游（线程上下文）按「五个字段都在」读；
 * 若让输入类型兼任落库类型，省略项的 `undefined` 会一路穿到 `items.commits.length` 上——
 * 一条合法回执就能把下游提示词构建打崩。
 */
export type RunDeliverablesInput = Partial<RunDeliverables>

/** 回执输入 → 落库形态：缺项补 `null` / `[]`，其余按原值（校验已挡过形状）。 */
export function normalizeDeliverables(input: RunDeliverablesInput): RunDeliverables {
  return {
    branch: input.branch ?? null,
    base: input.base ?? null,
    commits: [...(input.commits ?? [])],
    files: [...(input.files ?? [])],
    gates: [...(input.gates ?? [])],
  }
}

/** 运行权限级别（协议帧 access 语义；由智能体的 `permissionMode` 映射而来）。 */
export const ACCESS_LEVELS = ['read', 'edit', 'full'] as const

export type Access = (typeof ACCESS_LEVELS)[number]

/** 智能体权限模式 → 运行权限级别（派活时写进 `run.access`）。 */
export const ACCESS_BY_PERMISSION: Record<PermissionMode, Access> = {
  'read-only': 'read',
  'workspace-write': 'edit',
  'danger-full-access': 'full',
}

/** 反查（执行器按 `Turn.access` 还原 CLI 权限参数）；不在表里的按可写处理。 */
export function permissionModeOfAccess(access: Access): PermissionMode {
  switch (access) {
    case 'read':
      return 'read-only'
    case 'full':
      return 'danger-full-access'
    default:
      return 'workspace-write'
  }
}

// ---------- 卡片（审批） ----------

/**
 * 卡片状态：`open` = 等人回答（run 处于 `waiting`）；`answered` = 已选过选项；
 * `resolved` = 被关闭（智能体回执 `resolves` / 人工 `card.resolve` / run 取消）。
 * 取值顺序即展示顺序。
 */
export const CARD_STATUSES = ['open', 'answered', 'resolved'] as const

export type CardStatus = (typeof CARD_STATUSES)[number]

/**
 * 投递状态（单列，不按通道拆表）：`pending` = 尚未送达任何通道；`delivered` = 至少一个
 * 通道已 ack；`failed` = 本轮所有通道都失败。`cards.deliveryRef` 记最后一个成功通道。
 */
export const CARD_DELIVERIES = ['pending', 'delivered', 'failed'] as const

export type CardDelivery = (typeof CARD_DELIVERIES)[number]

/**
 * 卡片类型（M12）：**通知口径的唯一判据**，不再靠「`options` 是否为空」隐式推断。
 *
 * - `ask`：要人作答（`options` 非空），阻塞 run 的续接——系统通知只对这种卡弹；
 * - `notice`：只知会（回执 `notices`，`options` 空），不阻塞续接、**不发系统通知**，
 *   只在应用内通知区与任务详情里出现（打扰级别人为「查看级」，见 SPEC-ai-workflow）。
 *
 * 老事实（M4–M11 落库）没有该字段，由 `kernel/project` 按当时的口径归一：
 * `options` 非空 = `ask`，否则 `notice`。
 */
export const CARD_KINDS = ['ask', 'notice'] as const

export type CardKind = (typeof CARD_KINDS)[number]

/** 回答来源：`ui` = in-app 界面，`channel` = 通道插件回传（记 `card.answered.by`）。 */
export const CARD_ANSWER_VIA = ['ui', 'channel'] as const

export type CardAnswerVia = (typeof CARD_ANSWER_VIA)[number]

/** 关闭原因：`agent` = 回执 `resolves`，`manual` = `card.resolve`，`cancelled` = run 取消。 */
export const CARD_RESOLVE_REASONS = ['agent', 'manual', 'cancelled', 'expired'] as const

export type CardResolveReason = (typeof CARD_RESOLVE_REASONS)[number]

/**
 * `cards` 投影行（第 10 张投影表，M4）：带完整行由事实携带，`project` 只做
 * 「一行事实 → 一行投影」，重建无需回查。
 *
 * 卡片正文是智能体产出的文字：只能作为平台/通知 API 的参数，不得拼进命令行、
 * 脚本或 HTML（SPEC-plugins「channel」）。投递按 `(id, version)` 去重：同一版本只投一次，
 * 更新（`version+1`）重新进 `pending`。
 */
export interface Card {
  id: string
  runId: string
  /** 阶段 run 挂的任务；聊天 run 为 null */
  taskId: string | null
  /** 聊天 run 挂的对话；阶段 run 为 null */
  conversationId: string | null
  title: string
  text: string
  /** 卡片类型（M12）：`ask` = 要人作答并阻塞续接，`notice` = 只知会且不打扰 */
  kind: CardKind
  /** 可选项文案；回答时回传下标。信息卡（`notices`）为空数组 */
  options: string[]
  /** 稳定键：同一 run 内同 key 的 open 卡再次出现时产 `card.updated` */
  key: string | null
  /** 卡片版本（1 基；更新 +1，投递按版本去重） */
  version: number
  status: CardStatus
  delivery: CardDelivery
  /** 最后一个成功投递的通道 ref（如 `in-app` / `desktop`）；从未投递为 null */
  deliveryRef: string | null
  /** 选中的选项下标（`answered` 后）；信息卡与未回答为 null */
  optionIndex: number | null
  /** 回答来源（`answered` 后）；未回答为 null */
  answeredBy: CardAnswerVia | null
  answeredAt: string | null
  createdAt: string
  updatedAt: string
}

// ---------- 对话 / 消息 ----------

/** 消息角色：user = 人发的，assistant = 智能体回的 */
export const CHAT_ROLES = ['user', 'assistant'] as const

export type ChatRole = (typeof CHAT_ROLES)[number]

/**
 * 一段独立对话：绑定一个智能体，不挂任务、不推进阶段（`purpose='chat'` 的 run 挂在它上面）。
 *
 * M11 起对话和任务共用同一个**项目**维度：项目是顶层上下文，聊天与任务都落在项目上；
 * 没有项目（`projectId: null`）= 默认目录（宿主的 `~/.workbench` / `WORKBENCH_WORKDIR`）。
 */
export interface Conversation {
  id: string
  title: string
  agentId: string
  /**
   * 所属项目（M11）：新建对话时由命令携带，之后不再改；项目删除时内核把会话归到默认目录。
   * 老事实 / 存量行缺该字段，按 null 归一（默认目录）。
   */
  projectId: string | null
  /** 上一轮的协议会话 id；下一轮用它续接，避免整段历史重发 */
  sessionId: string | null
  /**
   * 归档时间（M9）：非 null 表示已归档，聊天清单默认不展示；
   * 老事实 / 存量行缺该字段时按 null 归一。
   */
  archivedAt?: string | null
  createdAt: string
  updatedAt: string
}

/** 一条聊天消息；`runId` 只出现在 `message.appended` 事实里（对话轮次归属），不进投影行 */
export interface Message {
  id: string
  conversationId: string
  role: ChatRole
  content: string
  /** 该条助手消息的失败原因（非零退出 / 超时 / 取消）；成功与用户消息为 null */
  error: string | null
  createdAt: string
}
