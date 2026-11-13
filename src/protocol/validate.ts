/**
 * 输入形状校验：宿主入口在派发前调用，renderer 传入的数据按不可信处理。
 *
 * 两个入口：`validateCommand`（命令，M1 起）与 `validateInput`（命令 + 宿主内部输入，M2）。
 * 纯函数、不抛异常：非法输入返回 `{ ok: false, message }`，由宿主转成 IPC 错误码。
 * 只校验形状（必填 / 类型 / 长度上限 / 数组上限 / 枚举 / 数值范围）；
 * 引用是否存在、名称是否唯一、阶段流转是否合法由 `decide` 判断。
 */
import { COMMAND_NAMES, type Command, type CommandName } from './commands'
import {
  ACCEPTANCE_LIMITS,
  AGENT_ENV_LIMITS,
  ARGV_PLACEHOLDERS,
  BUILTIN_STAGE_KEYS,
  CARD_ANSWER_VIA,
  ENTRY_MODES,
  ENV_KEY_PATTERN,
  EXECUTOR_KEY_PATTERN,
  GATE_VERDICTS,
  DELIVERABLE_LIMITS,
  ON_CHILDREN_SETTLED,
  PERMISSION_MODES,
  PROBE_STATES,
  RUN_ERROR_CODES,
  RUN_EVENT_TYPES,
  RUN_TERMINAL_STATUSES,
  SCRIPT_FORBIDDEN_PLACEHOLDERS,
  SCRIPT_LIMITS,
  SPAWN_POLICIES,
  STAGE_HANDOFF_GUARDS,
  STAGE_TIMEOUT_LIMITS,
} from './entities'
import { HOST_INPUT_NAMES, type HostInputName, type Input } from './inputs'
import { CAPABILITIES, PLUGIN_KINDS } from './manifest'
import { PLUGIN_ID_PATTERN } from './plugin-host'
import { PLUGIN_SETTING_LIMITS } from './plugins'
import {
  RULE_LIMITS,
  RULE_MERGE,
  RULE_ON_EXISTING,
  RULE_THREAD_KEY_FROM,
  RULE_TITLE_FROM,
} from './rules'
import { VIEW_IDS, VIEW_PARAM_FIELDS, type ViewId } from './views'
import { THREAD_LIMITS } from './thread'
import { TASK_COMMENT_LIMITS } from './task-comment'
import { FINDING_DISPOSITIONS, REVIEW_LIMITS, REVIEW_SEVERITIES } from './review'

/** 校验通过返回收窄后的命令；失败返回首条错误文案。 */
export type ValidateResult = { ok: true; command: Command } | { ok: false; message: string }

/** `validateInput` 的结果：命令与宿主内部输入共用。 */
export type ValidateInputResult = { ok: true; input: Input } | { ok: false; message: string }

/** 字段上限（字符数 / 数量）：超限一律拒收，不截断。 */
export const COMMAND_LIMITS = {
  commandId: 200,
  id: 200,
  /** 阶段 id：由内核生成，UI 回传时只做长度与类型兜底 */
  stageId: 64,
  name: 100,
  title: 200,
  description: 2000,
  systemPrompt: 20_000,
  /** 阶段「要干什么」正文上限（与系统提示词同量级） */
  stageInstructions: 20_000,
  command: 500,
  profile: 100,
  /** 执行器键（小写 slug，≤64） */
  executorKey: 64,
  /** 参数模板 JSON 文本上限 */
  argsTemplate: 4000,
  /** 参数模板最多项数 */
  argsTemplateItems: 20,
  /** 单个 argv 元素长度上限 */
  argsItem: 500,
  model: 200,
  workdir: 1000,
  probeOutput: 40_000,
  elapsedMs: 86_400_000,
  protocolVersion: 1_000_000,
  stages: 50,
  /** 单个阶段最多几条派单（同一触发条件可以扇出到多个工作流） */
  stageHandoffs: 5,
  maxConcurrent: 8,
  /** 领取容量上限：与运行时并发上限一致（1–8） */
  claimCapacity: 8,
  /** 租约 / 会话 / 幂等键等 id 类字符串 */
  leaseId: 200,
  sessionId: 200,
  /** 轮次 / 尝试次数等计数的整型上限（防御性，超限即非法） */
  turn: 1_000_000,
  /** 聊天正文上限（与旧 ChatService 的校验一致） */
  content: 20_000,
  /** 回执里的数组字段（ask / events / notices / resolves）上限 */
  receiptItems: 100,
  /** 选项文案条数上限 */
  askOptions: 20,
  /** 卡片补充说明上限（与卡片正文 `text` 同量级） */
  cardNote: 2000,
  /** 事件摘要上限（SPEC-kernel：≤200 字） */
  summary: 200,
  /** 时间戳字符串长度上限（ISO 8601 远小于此） */
  iso: 64,
  /** token 用量上限（单次运行不会超过） */
  tokens: 1_000_000_000_000,
  /** 单条 `run.frames` 输入的帧数上限（与 `Limits.maxFramesPerBatch` 同值；超出由宿主分包） */
  frames: 500,
  /** 帧 seq 上限（宿主按 run 全局单调分配，防御性上界） */
  frameSeq: 1_000_000_000,
  /** 事件跳数上限（与 `Limits.maxHops` 同值；超限由内核写 `event.dropped`） */
  maxHops: 8,
  /** 单条回执 `spawn[]` 上限（M8；超出整块忽略） */
  spawnItems: 32,
  /** 子任务批次号上限（M8） */
  spawnBatchMax: 999,
  /** 回执 `checks[]` 条数上限（M11；闸门证据，够覆盖常用命令即可） */
  gateChecks: 32,
  /** 单条闸门证据命令的文本上限（M11） */
  gateCmd: 500,
  /** 闸门允许未通过次数上限（M11；防御性上界，正常配 1–10） */
  gateMaxFails: 100,
} as const

type Obj = Record<string, unknown>
type Check = string | null

const asRecord = (value: unknown): Obj | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null

/** 必填字符串：非空、不超长。 */
const text = (value: unknown, label: string, max: number): Check => {
  if (typeof value !== 'string') return `${label}必须是字符串`
  if (value.trim() === '') return `${label}必填`
  if (value.length > max) return `${label}最长 ${max} 个字符`
  return null
}

/** 可选字符串：缺省或 null 视为未提供；空串允许（表示清空）。 */
const optionalText = (value: unknown, label: string, max: number): Check => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return `${label}必须是字符串`
  if (value.length > max) return `${label}最长 ${max} 个字符`
  return null
}

const required = (value: unknown, label: string, max: number): Check => {
  if (value === undefined || value === null) return `${label}必填`
  return text(value, label, max)
}

/** 聊天内容：空内容沿用旧 ChatService 的文案「消息内容不能为空」（UI 直接展示）。 */
const chatContent = (value: unknown): Check => {
  if (typeof value !== 'string' || value.trim() === '') return '消息内容不能为空'
  if (value.length > COMMAND_LIMITS.content) return `content最长 ${COMMAND_LIMITS.content} 个字符`
  return null
}

const requiredId = (value: unknown, label: string): Check =>
  required(value, label, COMMAND_LIMITS.id)

const optionalId = (value: unknown, label: string): Check =>
  value === undefined || value === null ? null : requiredId(value, label)

/** patch 里的名称：可以不传，传了就必须非空。 */
const optionalName = (value: unknown, label: string): Check =>
  value === undefined || value === null ? null : required(value, label, COMMAND_LIMITS.name)

const integerIn = (value: unknown, label: string, min: number, max: number): Check => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return `${label}必须是整数`
  if (value < min || value > max) return `${label}必须在 ${min} 到 ${max} 之间`
  return null
}

const optionalIntegerIn = (value: unknown, label: string, min: number, max: number): Check =>
  value === undefined || value === null ? null : integerIn(value, label, min, max)

const optionalBoolean = (value: unknown, label: string): Check => {
  if (value === undefined || value === null) return null
  return typeof value === 'boolean' ? null : `${label}必须是布尔值`
}

const enumOf = <T extends string>(value: unknown, label: string, allowed: readonly T[]): Check =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? null
    : `${label}取值必须是 ${allowed.join(' / ')}`

const requiredEnum = <T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): Check => (value === undefined || value === null ? `${label}必填` : enumOf(value, label, allowed))

const optionalEnum = <T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): Check => (value === undefined || value === null ? null : enumOf(value, label, allowed))

/** 占位符匹配：`{model}` 这类只允许小写字母（大小写不符按未知占位符拒收）。 */
const ARGV_PLACEHOLDER_RE = /\{([a-z]+)\}/g

/**
 * 执行器键：可选；给了就必须是小写 slug。
 * 取值是否存在对应插件由宿主入口按注册表判断（内核不认识产品名）。
 */
const optionalExecutorKey = (value: unknown): Check => {
  const error = optionalText(value, 'input.executorKey', COMMAND_LIMITS.executorKey)
  if (error) return error
  if (value === undefined || value === null) return null
  return EXECUTOR_KEY_PATTERN.test(value as string)
    ? null
    : 'input.executorKey 必须是小写 slug（字母开头，可含数字与连字符）'
}

/** 参数模板：JSON 数组文本；项数/单项长度受限，占位符必须在白名单内。 */
const optionalArgsTemplate = (value: unknown): Check => {
  const error = optionalText(value, 'input.argsTemplate', COMMAND_LIMITS.argsTemplate)
  if (error) return error
  if (value === undefined || value === null || value === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value as string)
  } catch {
    return 'input.argsTemplate 必须是 JSON 数组文本'
  }
  if (!Array.isArray(parsed)) return 'input.argsTemplate 必须是 JSON 数组文本'
  if (parsed.length > COMMAND_LIMITS.argsTemplateItems) {
    return `input.argsTemplate 最多 ${COMMAND_LIMITS.argsTemplateItems} 项`
  }
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== 'string') return `input.argsTemplate[${index}] 必须是字符串`
    if (item.length > COMMAND_LIMITS.argsItem) {
      return `input.argsTemplate[${index}] 最长 ${COMMAND_LIMITS.argsItem} 个字符`
    }
    for (const match of item.matchAll(ARGV_PLACEHOLDER_RE)) {
      const name = match[1] as string
      if (!(ARGV_PLACEHOLDERS as readonly string[]).includes(name)) {
        return `input.argsTemplate[${index}] 含未知占位符 {${name}}`
      }
    }
  }
  return null
}

// ---------- 各命令的载荷 ----------

const checkGate = (value: unknown, label: string): Check => {
  const gate = asRecord(value)
  if (!gate) return `${label} 必须是对象`
  return (
    integerIn(gate.maxFails, `${label}.maxFails`, 1, COMMAND_LIMITS.gateMaxFails) ??
    optionalIntegerIn(gate.onPassIndex, `${label}.onPassIndex`, 0, COMMAND_LIMITS.stages - 1) ??
    optionalIntegerIn(gate.onFailIndex, `${label}.onFailIndex`, 0, COMMAND_LIMITS.stages - 1)
  )
}

/**
 * 验收条目清单（M20）：数组、逐条文本、条数上限。空串条目由内核归一丢弃，
 * 这里只挡形状——写长了一句是文案问题，不该让整张工作流存不下去。
 */
const checkAcceptanceList = (value: unknown, label: string): Check => {
  if (!Array.isArray(value)) return `${label} 必须是数组`
  if (value.length > ACCEPTANCE_LIMITS.maxItems) {
    return `${label} 最多 ${ACCEPTANCE_LIMITS.maxItems} 条`
  }
  for (let i = 0; i < value.length; i += 1) {
    const error = text(value[i], `${label}[${i}]`, ACCEPTANCE_LIMITS.maxChars)
    if (error) return error
  }
  return null
}

/**
 * 派单清单（M29）：触发条件 + 目标工作流 / 阶段。目标的存在性、自指与从属由内核按视图判，
 * 这里只挡形状与条数。
 */
const checkHandoffs = (value: unknown, label: string): Check => {
  if (!Array.isArray(value)) return `${label} 必须是数组`
  if (value.length > COMMAND_LIMITS.stageHandoffs) {
    return `${label} 最多 ${COMMAND_LIMITS.stageHandoffs} 条`
  }
  for (let i = 0; i < value.length; i += 1) {
    const at = `${label}[${i}]`
    const handoff = asRecord(value[i])
    if (!handoff) return `${at} 必须是对象`
    const error =
      requiredEnum(handoff.on, `${at}.on`, STAGE_HANDOFF_GUARDS) ??
      requiredId(handoff.workflowId, `${at}.workflowId`) ??
      optionalId(handoff.stageId, `${at}.stageId`) ??
      optionalBoolean(handoff.forwardOnly, `${at}.forwardOnly`)
    if (error) return error
  }
  return null
}

/**
 * 阶段脚本（M40）：形状校验。命令不在这里——它只来自运行时连接（`runtime.command`）；
 * 参数逐项、环境变量复用智能体口径、超时与阶段同范围；占位符一律拒绝
 * （脚本没有提示词 / 模型 / 思考强度可展开）。
 */
const checkScript = (value: unknown, label: string): Check => {
  const script = asRecord(value)
  if (!script) return `${label} 必须是对象`
  return (
    requiredId(script.runtimeId, `${label}.runtimeId`) ??
    checkScriptArgs(script.args, `${label}.args`) ??
    optionalText(script.cwd, `${label}.cwd`, COMMAND_LIMITS.workdir) ??
    checkEnv(script.env, `${label}.env`) ??
    optionalIntegerIn(
      script.timeoutMs,
      `${label}.timeoutMs`,
      STAGE_TIMEOUT_LIMITS.minMs,
      STAGE_TIMEOUT_LIMITS.maxMs,
    )
  )
}

/** 脚本参数：字符串数组，项数与单项长度受 `SCRIPT_LIMITS` 约束，不允许占位符。 */
const checkScriptArgs = (value: unknown, label: string): Check => {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return `${label} 必须是字符串数组`
  if (value.length > SCRIPT_LIMITS.maxArgs) return `${label} 最多 ${SCRIPT_LIMITS.maxArgs} 项`
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (typeof item !== 'string') return `${label}[${index}] 必须是字符串`
    if (item.length > SCRIPT_LIMITS.maxArgChars) {
      return `${label}[${index}] 最长 ${SCRIPT_LIMITS.maxArgChars} 个字符`
    }
    const placeholder = /\{([a-z]+)\}/g
    for (const match of item.matchAll(placeholder)) {
      if ((SCRIPT_FORBIDDEN_PLACEHOLDERS as readonly string[]).includes(match[1])) {
        return `${label}[${index}] 不支持占位符 {${match[1]}}（脚本没有提示词 / 模型）`
      }
    }
  }
  return null
}

const checkStage = (value: unknown, label: string): Check => {
  const stage = asRecord(value)
  if (!stage) return `${label} 必须是对象`
  return (
    optionalText(stage.id, `${label}.id`, COMMAND_LIMITS.stageId) ??
    required(stage.name, `${label}.name`, COMMAND_LIMITS.name) ??
    requiredEnum(stage.entryMode, `${label}.entryMode`, ENTRY_MODES) ??
    // M18 内置阶段键：只认四个固定值，锁名 / 锁位 / 锁类别由内核按它判
    optionalEnum(stage.builtin, `${label}.builtin`, BUILTIN_STAGE_KEYS) ??
    optionalId(stage.agentId, `${label}.agentId`) ??
    // M40 阶段脚本：形状在这里挡；「与 entryMode 是否配套」由内核判
    (stage.script === undefined || stage.script === null
      ? null
      : checkScript(stage.script, `${label}.script`)) ??
    optionalIntegerIn(
      stage.onCompleteIndex,
      `${label}.onCompleteIndex`,
      0,
      COMMAND_LIMITS.stages - 1,
    ) ??
    optionalIntegerIn(
      stage.onRejectIndex,
      `${label}.onRejectIndex`,
      0,
      COMMAND_LIMITS.stages - 1,
    ) ??
    // M29 派单：触发条件枚举在这里挡，目标工作流 / 阶段的存在性由内核按视图判
    (stage.handoffs === undefined || stage.handoffs === null
      ? null
      : checkHandoffs(stage.handoffs, `${label}.handoffs`)) ??
    // M8 子任务：落点阶段存在性 / 从属由内核按视图判
    optionalId(stage.subtaskStageId, `${label}.subtaskStageId`) ??
    optionalEnum(stage.onChildrenSettled, `${label}.onChildrenSettled`, ON_CHILDREN_SETTLED) ??
    optionalEnum(stage.spawnPolicy, `${label}.spawnPolicy`, SPAWN_POLICIES) ??
    // M9 阶段要干什么：纯文本资料段，空串表示清空
    optionalText(stage.instructions, `${label}.instructions`, COMMAND_LIMITS.stageInstructions) ??
    // M34 验收条目：只有闸门阶段可配（由内核按 judge 判），这里只挡形状与条数
    (stage.acceptance === undefined || stage.acceptance === null
      ? null
      : checkAcceptanceList(stage.acceptance, `${label}.acceptance`)) ??
    // M26 单轮运行超时：5 min–4 h（毫秒），可空 = 用全局缺省
    optionalIntegerIn(
      stage.runTimeoutMs,
      `${label}.runTimeoutMs`,
      STAGE_TIMEOUT_LIMITS.minMs,
      STAGE_TIMEOUT_LIMITS.maxMs,
    ) ??
    // M11 闸门：次数范围与目标下标在此校验；是否指向自己 / 是否 agent 阶段由内核判
    (stage.gate === undefined || stage.gate === null
      ? null
      : checkGate(stage.gate, `${label}.gate`))
  )
}

const checkStages = (value: unknown, label: string): Check => {
  if (!Array.isArray(value)) return `${label} 必须是数组`
  if (value.length === 0) return `${label} 至少一个阶段`
  if (value.length > COMMAND_LIMITS.stages) return `${label} 最多 ${COMMAND_LIMITS.stages} 个阶段`
  for (let i = 0; i < value.length; i += 1) {
    const error = checkStage(value[i], `${label}[${i}]`)
    if (error) return error
  }
  return null
}

const checkWorkflowInput = (value: unknown): Check => {
  const input = asRecord(value)
  if (!input) return 'input 必须是对象'
  return (
    required(input.name, 'input.name', COMMAND_LIMITS.name) ??
    optionalText(input.description, 'input.description', COMMAND_LIMITS.description) ??
    checkStages(input.stages, 'input.stages')
  )
}

/** 环境变量：值必须全为字符串、键名合法、条数与长度受 `AGENT_ENV_LIMITS` 约束。 */
const checkEnv = (value: unknown, label: string): Check => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return `${label} 必须是键值对象`
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > AGENT_ENV_LIMITS.maxVars) {
    return `${label} 最多 ${AGENT_ENV_LIMITS.maxVars} 项`
  }
  for (const [key, raw] of entries) {
    if (key.length > AGENT_ENV_LIMITS.maxKeyChars || !ENV_KEY_PATTERN.test(key)) {
      return `${label} 的键非法: ${key}`
    }
    if (typeof raw !== 'string') return `${label}.${key} 必须是字符串`
    if (raw.length > AGENT_ENV_LIMITS.maxValueChars) {
      return `${label}.${key} 最长 ${AGENT_ENV_LIMITS.maxValueChars} 个字符`
    }
  }
  return null
}

/** 模型 id：可空；给了就必须是 `provider/model`（宿主据此拆成 Turn.model，写错就不再静默回退）。 */
const checkModelId = (value: unknown, label: string): Check => {
  const text = optionalText(value, label, COMMAND_LIMITS.model)
  if (text !== null) return text
  if (value === undefined || value === null) return null
  const raw = (value as string).trim()
  if (raw === '') return null
  const at = raw.indexOf('/')
  if (at <= 0 || at === raw.length - 1) return `${label}必须是 provider/model 形式`
  return null
}

/** 智能体输入：身份 + 执行配置（模型 / 思考强度 / 并发 / 访问权限 / 工作目录 / 环境变量）。 */
const checkAgentInput = (value: unknown, partial: boolean): Check => {
  const input = asRecord(value)
  if (!input) return 'input 必须是对象'
  const name = partial
    ? optionalName(input.name, 'input.name')
    : required(input.name, 'input.name', COMMAND_LIMITS.name)
  const runtimeId = partial
    ? optionalId(input.runtimeId, 'input.runtimeId')
    : requiredId(input.runtimeId, 'input.runtimeId')
  return (
    name ??
    optionalText(input.description, 'input.description', COMMAND_LIMITS.description) ??
    runtimeId ??
    optionalText(input.systemPrompt, 'input.systemPrompt', COMMAND_LIMITS.systemPrompt) ??
    checkModelId(input.model, 'input.model') ??
    optionalText(input.reasoningEffort, 'input.reasoningEffort', COMMAND_LIMITS.model) ??
    optionalEnum(input.permissionMode, 'input.permissionMode', PERMISSION_MODES) ??
    optionalText(input.workdir, 'input.workdir', COMMAND_LIMITS.workdir) ??
    optionalIntegerIn(
      input.maxConcurrent,
      'input.maxConcurrent',
      1,
      COMMAND_LIMITS.maxConcurrent,
    ) ??
    checkEnv(input.env, 'input.env')
  )
}

/** 运行时输入：只描述连接（执行器 / 命令 / profile / 参数模板 / 启停）。 */
const checkRuntimeInput = (value: unknown, partial: boolean): Check => {
  const input = asRecord(value)
  if (!input) return 'input 必须是对象'
  const name = partial
    ? optionalName(input.name, 'input.name')
    : required(input.name, 'input.name', COMMAND_LIMITS.name)
  return (
    name ??
    optionalExecutorKey(input.executorKey) ??
    optionalText(input.command, 'input.command', COMMAND_LIMITS.command) ??
    optionalText(input.profile, 'input.profile', COMMAND_LIMITS.profile) ??
    optionalArgsTemplate(input.argsTemplate) ??
    optionalBoolean(input.enabled, 'input.enabled')
  )
}

const checkTaskInput = (value: unknown): Check => {
  const input = asRecord(value)
  if (!input) return 'input 必须是对象'
  return (
    required(input.title, 'input.title', COMMAND_LIMITS.title) ??
    optionalText(input.description, 'input.description', COMMAND_LIMITS.description) ??
    requiredId(input.workflowId, 'input.workflowId') ??
    // M10 任务挂在项目下；M11 项目可选：省 = 默认目录（项目存在性由内核按视图判）
    optionalId(input.projectId, 'input.projectId') ??
    optionalId(input.stageId, 'input.stageId') ??
    // M8：人工挂子任务的父任务 id（存在性 / 同工作流 / active 由内核判）
    optionalId(input.parentTaskId, 'input.parentTaskId')
  )
}

/** 项目输入：名称与文件夹路径都必填；patch 里可只改其中一项（空串由内核拒）。 */
const checkProjectInput = (value: unknown, partial: boolean): Check => {
  const input = asRecord(value)
  if (!input) return 'input 必须是对象'
  const name = partial
    ? optionalName(input.name, 'input.name')
    : required(input.name, 'input.name', COMMAND_LIMITS.name)
  const path = partial
    ? optionalText(input.path, 'input.path', COMMAND_LIMITS.workdir)
    : required(input.path, 'input.path', COMMAND_LIMITS.workdir)
  return (
    name ?? path ?? optionalText(input.description, 'input.description', COMMAND_LIMITS.description)
  )
}

const checkProbe = (value: unknown): Check => {
  const probe = asRecord(value)
  if (!probe) return 'probe 必须是对象'
  return (
    requiredEnum(probe.state, 'probe.state', PROBE_STATES) ??
    optionalText(probe.path, 'probe.path', COMMAND_LIMITS.workdir) ??
    optionalText(probe.cliVersion, 'probe.cliVersion', COMMAND_LIMITS.model) ??
    optionalIntegerIn(
      probe.protocolVersion,
      'probe.protocolVersion',
      0,
      COMMAND_LIMITS.protocolVersion,
    ) ??
    optionalText(probe.pluginVersion, 'probe.pluginVersion', COMMAND_LIMITS.model) ??
    optionalText(probe.error, 'probe.error', COMMAND_LIMITS.description) ??
    optionalText(probe.output, 'probe.output', COMMAND_LIMITS.probeOutput) ??
    integerIn(probe.elapsedMs, 'probe.elapsedMs', 0, COMMAND_LIMITS.elapsedMs) ??
    required(probe.checkedAt, 'probe.checkedAt', COMMAND_LIMITS.id)
  )
}

/** app 事件类型：`<appId>.<event>` 形式的小写点分标识（如 pomodoro.completed）。 */
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

const checkEventType = (value: unknown): Check => {
  if (typeof value !== 'string') return 'eventType必须是字符串'
  if (value.length > COMMAND_LIMITS.name) return `eventType最长 ${COMMAND_LIMITS.name} 个字符`
  return EVENT_TYPE_PATTERN.test(value)
    ? null
    : 'eventType 必须是小写点分标识（如 pomodoro.completed）'
}

/** 规则来源：`*` 或小写标识（`:` 允许 app 来源写法，如 `app:pomodoro`）。 */
const RULE_SOURCE_PATTERN = /^(\*|[a-z][a-z0-9:_-]*)$/

/** 规则 type 匹配模式：精确、`*`、前缀 `x.*`。 */
const RULE_TYPE_PATTERN = /^(\*|[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*(\.\*)?)$/

/** 线程来源：小写标识（`app:<id>` 形式允许冒号），不允许 `*`。 */
const THREAD_SOURCE_PATTERN = /^[a-z][a-z0-9:_-]*$/

const checkThreadSource = (value: unknown): Check => {
  if (typeof value !== 'string') return 'source必须是字符串'
  if (value.length > THREAD_LIMITS.source) {
    return `source最长 ${THREAD_LIMITS.source} 个字符`
  }
  return THREAD_SOURCE_PATTERN.test(value)
    ? null
    : 'source 必须是小写标识（如 github / mail / app:pomodoro）'
}

const checkRuleWhen = (value: unknown, label: string): Check => {
  const when = asRecord(value)
  if (!when) return `${label} 必须是对象`
  const hasCron = when.cron !== undefined && when.cron !== null
  const hasEvent = when.source !== undefined || when.types !== undefined
  if (hasCron && hasEvent) return `${label} 只能二选一：cron 或 source+types`
  if (hasCron) return required(when.cron, `${label}.cron`, RULE_LIMITS.cron)
  if (!hasEvent) return `${label} 必须提供 cron 或 source+types`

  if (typeof when.source !== 'string') return `${label}.source 必须是字符串`
  if (when.source.length > RULE_LIMITS.source)
    return `${label}.source 最长 ${RULE_LIMITS.source} 个字符`
  if (!RULE_SOURCE_PATTERN.test(when.source)) {
    return `${label}.source 必须是小写标识或 *（如 github / app:pomodoro）`
  }
  if (!Array.isArray(when.types)) return `${label}.types 必须是数组`
  if (when.types.length === 0) return `${label}.types 至少 1 项`
  if (when.types.length > RULE_LIMITS.types) return `${label}.types 最多 ${RULE_LIMITS.types} 项`
  for (let i = 0; i < when.types.length; i += 1) {
    const pattern = when.types[i]
    if (typeof pattern !== 'string') return `${label}.types[${i}] 必须是字符串`
    if (pattern.length > RULE_LIMITS.typePattern) {
      return `${label}.types[${i}] 最长 ${RULE_LIMITS.typePattern} 个字符`
    }
    if (!RULE_TYPE_PATTERN.test(pattern)) {
      return `${label}.types[${i}] 必须是精确类型、* 或前缀 x.*`
    }
  }
  return null
}

const checkRuleTarget = (value: unknown, label: string): Check => {
  const to = asRecord(value)
  if (!to) return `${label} 必须是对象`
  const workflowError = requiredId(to.workflowId, `${label}.workflowId`)
  if (workflowError) return workflowError
  // M10：任务落在哪个项目（存在性由内核按视图判）
  const projectError = optionalId(to.projectId, `${label}.projectId`)
  if (projectError) return projectError
  const stageError = optionalId(to.stageId, `${label}.stageId`)
  if (stageError) return stageError

  if (to.task !== undefined && to.task !== null) {
    const task = asRecord(to.task)
    if (!task) return `${label}.task 必须是对象`
    const titleError = optionalEnum(task.titleFrom, `${label}.task.titleFrom`, RULE_TITLE_FROM)
    if (titleError) return titleError
    const labelsError = checkList(
      task.labels,
      `${label}.task.labels`,
      RULE_LIMITS.labels,
      (entry, at) => text(entry, at, RULE_LIMITS.label),
    )
    if (labelsError) return labelsError
  }

  if (to.thread !== undefined && to.thread !== null) {
    const thread = asRecord(to.thread)
    if (!thread) return `${label}.thread 必须是对象`
    const keyError = requiredEnum(thread.keyFrom, `${label}.thread.keyFrom`, RULE_THREAD_KEY_FROM)
    if (keyError) return keyError
    const onExistingError = optionalEnum(
      thread.onExisting,
      `${label}.thread.onExisting`,
      RULE_ON_EXISTING,
    )
    if (onExistingError) return onExistingError
  }
  return null
}

/** 单条规则形状校验（引用是否存在、cron 是否合法等语义由内核 `decide` 判）。 */
const checkRule = (value: unknown, label: string): Check => {
  const rule = asRecord(value)
  if (!rule) return `${label} 必须是对象`
  return (
    requiredId(rule.id, `${label}.id`) ??
    required(rule.name, `${label}.name`, RULE_LIMITS.name) ??
    checkRuleWhen(rule.when, `${label}.when`) ??
    checkRuleTarget(rule.to, `${label}.to`) ??
    optionalText(rule.prompt, `${label}.prompt`, RULE_LIMITS.prompt) ??
    optionalIntegerIn(rule.parallel, `${label}.parallel`, 1, RULE_LIMITS.parallel) ??
    optionalEnum(rule.merge, `${label}.merge`, RULE_MERGE) ??
    (typeof rule.enabled === 'boolean' ? null : `${label}.enabled 必须是布尔值`)
  )
}

// ---------- 插件设置（M7） ----------

/** 能力列表：枚举内、不重复、条数不超过能力全集。 */
const checkCapabilityList = (value: unknown, label: string): Check => {
  if (!Array.isArray(value)) return `${label} 必须是数组`
  if (value.length > CAPABILITIES.length) return `${label} 最多 ${CAPABILITIES.length} 项`
  const seen = new Set<string>()
  for (const [index, capability] of value.entries()) {
    if (
      typeof capability !== 'string' ||
      !(CAPABILITIES as readonly string[]).includes(capability)
    ) {
      return `${label}[${index}] 不是已声明的能力`
    }
    if (seen.has(capability)) return `${label}[${index}] 重复`
    seen.add(capability)
  }
  return null
}

const CONFIG_KEY_PATTERN = /^[a-z][A-Za-z0-9_-]{0,63}$/

/** 非 secret 配置值：只收标量；结构由 manifest 的 ConfigField 描述（内核不读 manifest）。 */
const checkPluginConfig = (value: unknown, label: string): Check => {
  if (value === undefined) return null
  const config = asRecord(value)
  if (!config) return `${label} 必须是对象`
  const keys = Object.keys(config)
  if (keys.length > PLUGIN_SETTING_LIMITS.configEntries) {
    return `${label} 最多 ${PLUGIN_SETTING_LIMITS.configEntries} 项`
  }
  for (const key of keys) {
    if (!CONFIG_KEY_PATTERN.test(key)) return `${label}.${key} 键名非法`
    const item = config[key]
    if (typeof item === 'boolean') continue
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return `${label}.${key} 必须是有限数字`
      continue
    }
    if (typeof item === 'string' && item.length <= PLUGIN_SETTING_LIMITS.configValue) continue
    return `${label}.${key} 必须是字符串 / 数字 / 布尔`
  }
  return null
}

/** secret 补丁：键名同 config 规则；值必须是字符串（≤上限）或 null（删除）。 */
const checkPluginSecrets = (value: unknown, label: string): Check => {
  if (value === undefined) return null
  const secrets = asRecord(value)
  if (!secrets) return `${label} 必须是对象`
  const keys = Object.keys(secrets)
  if (keys.length > PLUGIN_SETTING_LIMITS.configEntries) {
    return `${label} 最多 ${PLUGIN_SETTING_LIMITS.configEntries} 项`
  }
  for (const key of keys) {
    if (!CONFIG_KEY_PATTERN.test(key)) return `${label}.${key} 键名非法`
    const item = secrets[key]
    if (item === null) continue
    if (typeof item !== 'string') return `${label}.${key} 必须是字符串或 null`
    if (item.length > PLUGIN_SETTING_LIMITS.configValue) {
      return `${label}.${key} 最长 ${PLUGIN_SETTING_LIMITS.configValue} 个字符`
    }
  }
  return null
}

const checkPluginSetting = (value: unknown, label: string): Check => {
  const setting = asRecord(value)
  if (!setting) return `${label} 必须是对象`
  if (typeof setting.id !== 'string' || !PLUGIN_ID_PATTERN.test(setting.id)) {
    return `${label}.id 必须是小写 slug`
  }
  if (typeof setting.enabled !== 'boolean') return `${label}.enabled 必须是布尔值`
  return (
    requiredEnum(setting.kind, `${label}.kind`, PLUGIN_KINDS) ??
    checkCapabilityList(setting.granted, `${label}.granted`) ??
    checkPluginConfig(setting.config, `${label}.config`)
  )
}

const checkPayload = (type: CommandName, command: Obj): Check => {
  switch (type) {
    case 'workflow.create':
      return checkWorkflowInput(command.input)
    case 'workflow.update':
      return requiredId(command.id, 'id') ?? checkWorkflowInput(command.input)
    case 'workflow.remove':
      return requiredId(command.id, 'id')
    case 'agent.create':
      return checkAgentInput(command.input, false)
    case 'agent.update':
      return requiredId(command.id, 'id') ?? checkAgentInput(command.patch, true)
    case 'agent.remove':
      return requiredId(command.id, 'id')
    case 'runtime.create':
      return checkRuntimeInput(command.input, false)
    case 'runtime.update':
      return requiredId(command.id, 'id') ?? checkRuntimeInput(command.patch, true)
    case 'runtime.remove':
      return requiredId(command.id, 'id')
    case 'runtime.probe':
      return requiredId(command.id, 'id')
    case 'runtime.probed':
      return requiredId(command.id, 'id') ?? checkProbe(command.probe)
    case 'project.create':
      return checkProjectInput(command.input, false)
    case 'project.update':
      return requiredId(command.id, 'id') ?? checkProjectInput(command.patch, true)
    case 'project.remove':
      return requiredId(command.id, 'id')
    case 'task.create':
      return checkTaskInput(command.input)
    case 'task.move':
      return requiredId(command.id, 'id') ?? requiredId(command.stageId, 'stageId')
    case 'task.complete':
    case 'task.stop':
    case 'task.remove':
    case 'task.rerun':
      // 重新执行只带任务 id：阶段 / 智能体 / 运行时都由内核按视图现算
      return requiredId(command.id, 'id')
    case 'review.export':
      // M14：提升为文档只带任务与可选的报告版本；归属与「有没有报告」由内核判
      return requiredId(command.taskId, 'taskId') ?? optionalId(command.reportId, 'reportId')
    case 'task.comment':
      // 反馈正文只作资料（资料段）；`rerun` 只表示「顺带再跑一轮」的意图，能否跑由内核判
      return (
        requiredId(command.taskId, 'taskId') ??
        text(command.text, 'text', TASK_COMMENT_LIMITS.text) ??
        optionalBoolean(command.rerun, 'rerun')
      )
    case 'card.answer':
      // 下标上限与回执 `options` 的条数上限一致；越界值在此拒收（不查卡片，卡片存在性由 decide 判）。
      return (
        requiredId(command.cardId, 'cardId') ??
        integerIn(command.optionIndex, 'optionIndex', 0, COMMAND_LIMITS.askOptions - 1) ??
        optionalEnum(command.via, 'via', CARD_ANSWER_VIA) ??
        optionalText(command.note, 'note', COMMAND_LIMITS.cardNote)
      )
    case 'card.resolve':
      return requiredId(command.cardId, 'cardId')
    case 'chat.create':
      return (
        requiredId(command.agentId, 'agentId') ??
        optionalText(command.title, 'title', COMMAND_LIMITS.title) ??
        // M11：对话可以落到项目上（项目存在性由内核判）；省 = 默认目录
        optionalId(command.projectId, 'projectId')
      )
    case 'chat.send':
      return requiredId(command.conversationId, 'conversationId') ?? chatContent(command.content)
    case 'chat.remove':
    case 'chat.cancel':
      return requiredId(command.conversationId, 'conversationId')
    case 'chat.archive':
      return (
        requiredId(command.conversationId, 'conversationId') ??
        optionalBoolean(command.archived, 'archived')
      )
    case 'app.event':
      // appId / eventType 属于白名单的语义由宿主入口按 `APP_EVENTS` 再判一次；
      // 这里只做形状与长度校验（renderer 传的是不可信数据）。
      return (
        requiredId(command.appId, 'appId') ??
        checkEventType(command.eventType) ??
        required(command.subject, 'subject', COMMAND_LIMITS.title) ??
        optionalText(command.summary, 'summary', COMMAND_LIMITS.summary) ??
        optionalString(command.detail, 'detail') ??
        optionalText(command.link, 'link', COMMAND_LIMITS.workdir) ??
        optionalText(command.dedupeKey, 'dedupeKey', COMMAND_LIMITS.id)
      )
    case 'rules.replace':
      // 整批替换：逐条只校验形状；引用存在性 / cron 合法性 / id 唯一由内核判（整批拒绝）
      if (!Array.isArray(command.rules)) return 'rules 必须是数组'
      return checkList(command.rules, 'rules', RULE_LIMITS.rules, checkRule)
    case 'rule.trigger':
      return requiredId(command.ruleId, 'ruleId')
    case 'plugins.replace':
      // 整批替换：逐条只校验形状；id 唯一 / 授权 ⊆ 声明能力由内核与宿主视图分别判
      if (!Array.isArray(command.settings)) return 'settings 必须是数组'
      return checkList(
        command.settings,
        'settings',
        PLUGIN_SETTING_LIMITS.settings,
        checkPluginSetting,
      )
    case 'plugin.set':
      return (
        requiredId(command.pluginId, 'pluginId') ??
        optionalBoolean(command.enabled, 'enabled') ??
        (command.granted === undefined ? null : checkCapabilityList(command.granted, 'granted')) ??
        checkPluginConfig(command.config, 'config') ??
        checkPluginSecrets(command.secrets, 'secrets')
      )
    case 'thread.note':
      // 笔记正文只作资料；上限与回执 notes[] 同值
      return (
        requiredId(command.threadId, 'threadId') ??
        text(command.text, 'text', THREAD_LIMITS.noteText)
      )
    case 'thread.close':
      return requiredId(command.threadId, 'threadId')
    case 'thread.remove':
      return requiredId(command.threadId, 'threadId')
    case 'thread.bind':
      return (
        requiredId(command.threadId, 'threadId') ??
        checkThreadSource(command.source) ??
        required(command.externalRef, 'externalRef', THREAD_LIMITS.externalRef)
      )
  }
}

/** 校验一条来自 IPC / 插件的未知命令：合法则返回 `Command`，否则返回首条错误。 */
export function validateCommand(input: unknown): ValidateResult {
  const command = asRecord(input)
  if (!command) return { ok: false, message: '命令必须是对象' }

  const rawType = command.type
  if (typeof rawType !== 'string' || !(COMMAND_NAMES as readonly string[]).includes(rawType)) {
    return { ok: false, message: `未知命令: ${String(rawType)}` }
  }

  const commandIdError = required(command.commandId, 'commandId', COMMAND_LIMITS.commandId)
  if (commandIdError) return { ok: false, message: commandIdError }

  const error = checkPayload(rawType as CommandName, command)
  if (error) return { ok: false, message: error }

  return { ok: true, command: command as unknown as Command }
}

// ---------- 宿主内部输入（M2） ----------

/** 只校验类型、不设上限的字符串：运行输出正文长度不设限（协议帧原样入账）。 */
const optionalString = (value: unknown, label: string): Check => {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? null : `${label}必须是字符串`
}

/** 数组字段：类型、条数上限，再逐项校验。 */
const checkList = (
  value: unknown,
  label: string,
  max: number,
  item: (entry: unknown, itemLabel: string) => Check,
): Check => {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return `${label} 必须是数组`
  if (value.length > max) return `${label} 最多 ${max} 项`
  for (let i = 0; i < value.length; i += 1) {
    const error = item(value[i], `${label}[${i}]`)
    if (error) return error
  }
  return null
}

const checkUsage = (value: unknown, label: string): Check => {
  const usage = asRecord(value)
  if (!usage) return `${label} 必须是对象`
  return (
    integerIn(usage.inputTokens, `${label}.inputTokens`, 0, COMMAND_LIMITS.tokens) ??
    integerIn(usage.outputTokens, `${label}.outputTokens`, 0, COMMAND_LIMITS.tokens) ??
    integerIn(usage.cacheReadTokens, `${label}.cacheReadTokens`, 0, COMMAND_LIMITS.tokens) ??
    integerIn(usage.cacheWriteTokens, `${label}.cacheWriteTokens`, 0, COMMAND_LIMITS.tokens)
  )
}

const checkAsk = (value: unknown, label: string): Check => {
  const ask = asRecord(value)
  if (!ask) return `${label} 必须是对象`
  return (
    required(ask.title, `${label}.title`, COMMAND_LIMITS.title) ??
    optionalText(ask.text, `${label}.text`, COMMAND_LIMITS.description) ??
    (Array.isArray(ask.options)
      ? checkList(ask.options, `${label}.options`, COMMAND_LIMITS.askOptions, (option, at) =>
          text(option, at, COMMAND_LIMITS.title),
        )
      : `${label}.options 必须是数组`) ??
    optionalText(ask.key, `${label}.key`, COMMAND_LIMITS.id)
  )
}

const checkRawEvent = (value: unknown, label: string): Check => {
  const event = asRecord(value)
  if (!event) return `${label} 必须是对象`
  return (
    required(event.source, `${label}.source`, COMMAND_LIMITS.name) ??
    required(event.type, `${label}.type`, COMMAND_LIMITS.name) ??
    required(event.subject, `${label}.subject`, COMMAND_LIMITS.title) ??
    optionalText(event.summary, `${label}.summary`, COMMAND_LIMITS.summary) ??
    optionalString(event.detail, `${label}.detail`) ??
    optionalText(event.link, `${label}.link`, COMMAND_LIMITS.workdir) ??
    optionalText(event.dedupeKey, `${label}.dedupeKey`, COMMAND_LIMITS.id)
  )
}

/**
 * 回执 `spawn[]` 的单项（M8）：白名单式校验，只读取
 * `subject/summary/stageId/batch/key`；Agent 若塞 `parentTaskId` / `agentId` 等
 * 越权字段，一律不读取（内核按 run.taskId 推导父任务，派活目标由阶段决定）。
 */
const checkSpawnTask = (value: unknown, label: string): Check => {
  const item = asRecord(value)
  if (!item) return `${label} 必须是对象`
  return (
    required(item.subject, `${label}.subject`, COMMAND_LIMITS.title) ??
    optionalText(item.summary, `${label}.summary`, COMMAND_LIMITS.description) ??
    optionalId(item.stageId, `${label}.stageId`) ??
    optionalIntegerIn(item.batch, `${label}.batch`, 1, COMMAND_LIMITS.spawnBatchMax) ??
    optionalId(item.key, `${label}.key`)
  )
}

/** 运行帧（`run.frames` 的单帧）：`seq` 由宿主分配，`type` 是事件类型枚举，其余为可选负载。 */
const checkFrame = (value: unknown, label: string): Check => {
  const frame = asRecord(value)
  if (!frame) return `${label} 必须是对象`
  return (
    requiredId(frame.runId, `${label}.runId`) ??
    integerIn(frame.seq, `${label}.seq`, 1, COMMAND_LIMITS.frameSeq) ??
    requiredEnum(frame.type, `${label}.type`, RUN_EVENT_TYPES) ??
    optionalString(frame.text, `${label}.text`) ??
    optionalText(frame.tool, `${label}.tool`, COMMAND_LIMITS.name) ??
    optionalText(frame.callId, `${label}.callId`, COMMAND_LIMITS.id) ??
    optionalString(frame.input, `${label}.input`) ??
    optionalString(frame.output, `${label}.output`) ??
    optionalBoolean(frame.isError, `${label}.isError`) ??
    optionalText(frame.status, `${label}.status`, COMMAND_LIMITS.name)
  )
}

/** 帧批：1 帧起、≤ `frames` 帧；每帧的 `runId` 必须与输入一致（防跨 run 串帧）。 */
const checkFrames = (value: unknown, runId: unknown): Check => {
  if (!Array.isArray(value)) return 'frames 必须是数组'
  if (value.length === 0) return 'frames 至少 1 帧'
  if (value.length > COMMAND_LIMITS.frames) return `frames 最多 ${COMMAND_LIMITS.frames} 帧`
  for (let i = 0; i < value.length; i += 1) {
    const error = checkFrame(value[i], `frames[${i}]`)
    if (error) return error
  }
  for (const frame of value as Array<Record<string, unknown>>) {
    if (frame.runId !== runId) return 'frames[*].runId 必须与 runId 一致'
  }
  return null
}

/** 闸门证据（M11）：`{ cmd, exitCode }`，命令非空、退出码在合理区间。 */
const checkGateCheck = (value: unknown, at: string): Check => {
  const check = asRecord(value)
  if (!check) return `${at} 必须是对象`
  return (
    required(check.cmd, `${at}.cmd`, COMMAND_LIMITS.gateCmd) ??
    integerIn(check.exitCode, `${at}.exitCode`, -1_000_000, 1_000_000) ??
    // M34：指向第 n 条验收（1 基）；越界由内核按阶段配置丢弃
    optionalIntegerIn(check.acceptance, `${at}.acceptance`, 1, ACCEPTANCE_LIMITS.maxItems)
  )
}

/**
 * 阶段交付物（M28）：`{ branch?, base?, commits?, files?, gates? }`。
 *
 * 全部可选（只声明本阶段真产出的项）；给了就按形状校验——它是下游定位产物的坐标，
 * 「大概写写」会让合并阶段重新考古。`gates` 与闸门 `checks` 同形，直接复用条目校验。
 */
const checkDeliverables = (value: unknown): Check => {
  if (value === undefined || value === null) return null
  const at = 'receipt.deliverables'
  const record = asRecord(value)
  if (!record) return `${at} 必须是对象`
  const name = (field: 'branch' | 'base'): Check =>
    record[field] === undefined || record[field] === null
      ? null
      : optionalText(record[field], `${at}.${field}`, DELIVERABLE_LIMITS.maxChars)
  return (
    name('branch') ??
    name('base') ??
    checkList(record.commits, `${at}.commits`, DELIVERABLE_LIMITS.maxCommits, (item, where) =>
      text(item, where, DELIVERABLE_LIMITS.maxChars),
    ) ??
    checkList(record.files, `${at}.files`, DELIVERABLE_LIMITS.maxFiles, (item, where) =>
      text(item, where, DELIVERABLE_LIMITS.maxChars),
    ) ??
    checkList(record.gates, `${at}.gates`, COMMAND_LIMITS.gateChecks, checkGateCheck)
  )
}

/**
 * 评审条目（M14）：`{ key, severity, location?, claim, evidence?, requiredAction }`。
 * `key` 是报告内小标（内核据此拼 `<reportId>#<key>`），重复小标在 `checkFindings` 里拒。
 */
const checkReviewFinding = (value: unknown, at: string): Check => {
  const finding = asRecord(value)
  if (!finding) return `${at} 必须是对象`
  return (
    required(finding.key, `${at}.key`, REVIEW_LIMITS.key) ??
    requiredEnum(finding.severity, `${at}.severity`, REVIEW_SEVERITIES) ??
    optionalText(finding.location, `${at}.location`, REVIEW_LIMITS.location) ??
    required(finding.claim, `${at}.claim`, REVIEW_LIMITS.claim) ??
    optionalText(finding.evidence, `${at}.evidence`, REVIEW_LIMITS.evidence) ??
    required(finding.requiredAction, `${at}.requiredAction`, REVIEW_LIMITS.requiredAction)
  )
}

/** 清单整体：逐条形状 + 小标不重复（重复会让 finding id 撞车，无法逐条闭环）。 */
const checkFindings = (value: unknown): Check => {
  const list = checkList(value, 'receipt.findings', REVIEW_LIMITS.maxFindings, checkReviewFinding)
  if (list) return list
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  for (const entry of value as Obj[]) {
    const key = String(entry.key).trim()
    if (seen.has(key)) return `receipt.findings 的小标重复：${key}`
    seen.add(key)
  }
  return null
}

/**
 * 处置条目（M14）：`{ findingId, disposition, note?, checkRef? }`。
 * `fixed` 必须带 `checkRef`（内核还要核对它指向的同回执 `checks` 退出码为 0）；
 * `rejected` / `deferred` 必须带理由。
 */
const checkFindingAddress = (value: unknown, at: string): Check => {
  const address = asRecord(value)
  if (!address) return `${at} 必须是对象`
  const disposition = requiredEnum(address.disposition, `${at}.disposition`, FINDING_DISPOSITIONS)
  if (disposition) return disposition
  const shape =
    requiredId(address.findingId, `${at}.findingId`) ??
    optionalText(address.note, `${at}.note`, REVIEW_LIMITS.note) ??
    optionalText(address.checkRef, `${at}.checkRef`, COMMAND_LIMITS.gateCmd)
  if (shape) return shape
  if (address.disposition === 'fixed' && (address.checkRef ?? '') === '') {
    return `${at}.checkRef 必填（fixed 必须给出复核命令）`
  }
  if (address.disposition !== 'fixed' && (address.note ?? '') === '') {
    return `${at}.note 必填（不改 / 延后都要写理由）`
  }
  return null
}

/** 执行器回执：`leaseId` / `turn` 必填（D15），其余按 SPEC-plugins 逐项校验。 */
const checkReceipt = (value: unknown): Check => {
  const receipt = asRecord(value)
  if (!receipt) return 'receipt 必须是对象'
  return (
    requiredEnum(receipt.status, 'receipt.status', RUN_TERMINAL_STATUSES) ??
    required(receipt.leaseId, 'receipt.leaseId', COMMAND_LIMITS.leaseId) ??
    integerIn(receipt.turn, 'receipt.turn', 1, COMMAND_LIMITS.turn) ??
    optionalString(receipt.output, 'receipt.output') ??
    optionalText(receipt.sessionId, 'receipt.sessionId', COMMAND_LIMITS.sessionId) ??
    (receipt.usage === undefined || receipt.usage === null
      ? null
      : checkUsage(receipt.usage, 'receipt.usage')) ??
    checkList(receipt.ask, 'receipt.ask', COMMAND_LIMITS.receiptItems, checkAsk) ??
    checkList(receipt.notices, 'receipt.notices', COMMAND_LIMITS.receiptItems, (notice, at) =>
      text(notice, at, COMMAND_LIMITS.description),
    ) ??
    checkList(receipt.resolves, 'receipt.resolves', COMMAND_LIMITS.receiptItems, (id, at) =>
      required(id, at, COMMAND_LIMITS.id),
    ) ??
    optionalText(receipt.later, 'receipt.later', COMMAND_LIMITS.iso) ??
    checkList(receipt.events, 'receipt.events', COMMAND_LIMITS.receiptItems, checkRawEvent) ??
    checkList(receipt.spawn, 'receipt.spawn', COMMAND_LIMITS.spawnItems, checkSpawnTask) ??
    checkList(receipt.notes, 'receipt.notes', THREAD_LIMITS.notesPerReceipt, (note, at) =>
      text(note, at, THREAD_LIMITS.noteText),
    ) ??
    optionalEnum(receipt.errorCode, 'receipt.errorCode', RUN_ERROR_CODES) ??
    optionalText(receipt.error, 'receipt.error', COMMAND_LIMITS.description) ??
    optionalIntegerIn(receipt.exitCode, 'receipt.exitCode', -1_000_000, 1_000_000) ??
    optionalIntegerIn(receipt.durationMs, 'receipt.durationMs', 0, COMMAND_LIMITS.elapsedMs) ??
    optionalBoolean(receipt.resumeRejected, 'receipt.resumeRejected') ??
    optionalEnum(receipt.verdict, 'receipt.verdict', GATE_VERDICTS) ??
    checkList(receipt.checks, 'receipt.checks', COMMAND_LIMITS.gateChecks, checkGateCheck) ??
    // M28 阶段交付物：可选；形状不对整块拒（它是下游定位产物的坐标，不能含糊）
    checkDeliverables(receipt.deliverables) ??
    checkFindings(receipt.findings) ??
    checkList(
      receipt.addresses,
      'receipt.addresses',
      REVIEW_LIMITS.maxAddresses,
      checkFindingAddress,
    )
  )
}

const checkHostPayload = (type: HostInputName, input: Obj): Check => {
  switch (type) {
    case 'run.claim':
      return (
        requiredId(input.runtimeId, 'runtimeId') ??
        integerIn(input.capacity, 'capacity', 1, COMMAND_LIMITS.claimCapacity)
      )
    case 'run.heartbeat':
      return (
        requiredId(input.runId, 'runId') ??
        required(input.leaseId, 'leaseId', COMMAND_LIMITS.leaseId)
      )
    case 'run.receipt':
      return requiredId(input.runId, 'runId') ?? checkReceipt(input.receipt)
    case 'run.frames':
      return (
        requiredId(input.runId, 'runId') ??
        integerIn(input.turn, 'turn', 1, COMMAND_LIMITS.turn) ??
        checkFrames(input.frames, input.runId)
      )
    case 'run.host_settled':
      return (
        requiredId(input.runId, 'runId') ??
        optionalId(input.leaseId, 'leaseId') ??
        optionalIntegerIn(input.turn, 'turn', 1, COMMAND_LIMITS.turn) ??
        requiredEnum(input.status, 'status', RUN_TERMINAL_STATUSES) ??
        optionalEnum(input.errorCode, 'errorCode', RUN_ERROR_CODES) ??
        optionalText(input.error, 'error', COMMAND_LIMITS.description) ??
        optionalString(input.output, 'output') ??
        optionalText(input.sessionId, 'sessionId', COMMAND_LIMITS.sessionId) ??
        (input.usage === undefined || input.usage === null
          ? null
          : checkUsage(input.usage, 'usage')) ??
        optionalIntegerIn(input.exitCode, 'exitCode', -1_000_000, 1_000_000) ??
        optionalIntegerIn(input.durationMs, 'durationMs', 0, COMMAND_LIMITS.elapsedMs)
      )
    case 'run.cancel':
      return requiredId(input.runId, 'runId')
    case 'clock.tick':
      return null
    case 'card.delivered':
      // 通道投递回写：版本 1 基正整数（与回执/轮次同档上界），ref 是通道键
      return (
        requiredId(input.cardId, 'cardId') ??
        integerIn(input.version, 'version', 1, COMMAND_LIMITS.turn) ??
        required(input.ref, 'ref', COMMAND_LIMITS.description)
      )
    case 'card.delivery_failed':
      return (
        requiredId(input.cardId, 'cardId') ??
        integerIn(input.version, 'version', 1, COMMAND_LIMITS.turn) ??
        required(input.error, 'error', COMMAND_LIMITS.description)
      )
    case 'event.received':
      // 外部事件入口：形状与回执 events[] 的 RawEvent 同口径；语义（命中哪条规则）由内核判
      return (
        checkRawEvent(input.event, 'event') ??
        optionalIntegerIn(input.hops, 'hops', 0, COMMAND_LIMITS.maxHops) ??
        optionalId(input.originRunId, 'originRunId') ??
        optionalText(input.detailRef, 'detailRef', COMMAND_LIMITS.workdir)
      )
  }
}

/**
 * 校验一条来自任意边界的输入：命令走 `validateCommand`（行为不变），
 * 宿主内部输入按各自载荷校验；两者都不是则返回 `invalid_input` 语义的文案。
 */
export function validateInput(input: unknown): ValidateInputResult {
  const record = asRecord(input)
  if (!record) return { ok: false, message: '输入必须是对象' }

  const rawType = record.type
  if (typeof rawType === 'string' && (COMMAND_NAMES as readonly string[]).includes(rawType)) {
    const validated = validateCommand(record)
    return validated.ok ? { ok: true, input: validated.command } : validated
  }

  if (typeof rawType !== 'string' || !(HOST_INPUT_NAMES as readonly string[]).includes(rawType)) {
    return { ok: false, message: `未知输入: ${String(rawType)}` }
  }

  const error = checkHostPayload(rawType as HostInputName, record)
  if (error) return { ok: false, message: error }

  return { ok: true, input: record as unknown as Input }
}

// ---------- 视图查询（M5：query 动词入口） ----------

/** `query` 的校验结果：视图 id 必须是登记过的，参数按 `VIEW_PARAM_FIELDS` 收窄。 */
export type ValidateQueryResult =
  | { ok: true; view: ViewId; params: Record<string, string> | undefined }
  | { ok: false; message: string }

/**
 * 校验 renderer 传来的视图 id 与参数：未知视图、参数缺失/类型不对/超长一律拒收。
 * 无参数视图容忍 `undefined` / `null`；带参数视图缺字段直接拒绝（不静默当空串）。
 */
export function validateQuery(view: unknown, params?: unknown): ValidateQueryResult {
  if (typeof view !== 'string' || !(VIEW_IDS as readonly string[]).includes(view)) {
    return { ok: false, message: `未知视图: ${String(view)}` }
  }
  const field = VIEW_PARAM_FIELDS[view as ViewId]
  if (field === undefined) {
    if (params !== undefined && params !== null) {
      const record = asRecord(params)
      if (!record || Object.keys(record).length > 0)
        return { ok: false, message: '该视图不接受参数' }
    }
    return { ok: true, view: view as ViewId, params: undefined }
  }
  const record = asRecord(params)
  if (!record) return { ok: false, message: `视图 ${view} 需要参数 ${field}` }
  const error = requiredId(record[field], field)
  if (error) return { ok: false, message: error }
  return { ok: true, view: view as ViewId, params: { [field]: record[field] as string } }
}
