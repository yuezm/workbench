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
  ARGV_PLACEHOLDERS,
  CARD_ANSWER_VIA,
  ENTRY_MODES,
  EXECUTOR_KEY_PATTERN,
  PERMISSION_MODES,
  PROBE_STATES,
  RUN_ERROR_CODES,
  RUN_EVENT_TYPES,
  RUN_TERMINAL_STATUSES,
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

const checkStage = (value: unknown, label: string): Check => {
  const stage = asRecord(value)
  if (!stage) return `${label} 必须是对象`
  return (
    optionalText(stage.id, `${label}.id`, COMMAND_LIMITS.stageId) ??
    required(stage.name, `${label}.name`, COMMAND_LIMITS.name) ??
    requiredEnum(stage.entryMode, `${label}.entryMode`, ENTRY_MODES) ??
    optionalId(stage.agentId, `${label}.agentId`) ??
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
    // M7 交接：目标工作流 / 目标阶段存在性由内核按视图判（这里只校验 id 形状）
    optionalId(stage.handoffWorkflowId, `${label}.handoffWorkflowId`) ??
    optionalId(stage.handoffStageId, `${label}.handoffStageId`)
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
    optionalText(input.systemPrompt, 'input.systemPrompt', COMMAND_LIMITS.systemPrompt)
  )
}

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
    optionalEnum(input.permissionMode, 'input.permissionMode', PERMISSION_MODES) ??
    optionalText(input.model, 'input.model', COMMAND_LIMITS.model) ??
    optionalText(input.reasoningEffort, 'input.reasoningEffort', COMMAND_LIMITS.model) ??
    optionalText(input.workdir, 'input.workdir', COMMAND_LIMITS.workdir) ??
    optionalIntegerIn(
      input.maxConcurrent,
      'input.maxConcurrent',
      1,
      COMMAND_LIMITS.maxConcurrent,
    ) ??
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
    optionalId(input.stageId, 'input.stageId')
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
    case 'task.create':
      return checkTaskInput(command.input)
    case 'task.move':
      return requiredId(command.id, 'id') ?? requiredId(command.stageId, 'stageId')
    case 'task.complete':
    case 'task.remove':
      return requiredId(command.id, 'id')
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
        optionalEnum(command.via, 'via', CARD_ANSWER_VIA)
      )
    case 'card.resolve':
      return requiredId(command.cardId, 'cardId')
    case 'chat.create':
      return (
        requiredId(command.agentId, 'agentId') ??
        optionalText(command.title, 'title', COMMAND_LIMITS.title)
      )
    case 'chat.send':
      return requiredId(command.conversationId, 'conversationId') ?? chatContent(command.content)
    case 'chat.remove':
    case 'chat.cancel':
      return requiredId(command.conversationId, 'conversationId')
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
    checkList(receipt.notes, 'receipt.notes', THREAD_LIMITS.notesPerReceipt, (note, at) =>
      text(note, at, THREAD_LIMITS.noteText),
    ) ??
    optionalEnum(receipt.errorCode, 'receipt.errorCode', RUN_ERROR_CODES) ??
    optionalText(receipt.error, 'receipt.error', COMMAND_LIMITS.description) ??
    optionalIntegerIn(receipt.exitCode, 'receipt.exitCode', -1_000_000, 1_000_000) ??
    optionalIntegerIn(receipt.durationMs, 'receipt.durationMs', 0, COMMAND_LIMITS.elapsedMs) ??
    optionalBoolean(receipt.resumeRejected, 'receipt.resumeRejected')
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
