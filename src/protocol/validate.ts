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
  ENTRY_MODES,
  PERMISSION_MODES,
  PROBE_STATES,
  PROTOCOL_FAMILIES,
  RUN_ERROR_CODES,
  RUN_TERMINAL_STATUSES,
} from './entities'
import { HOST_INPUT_NAMES, type HostInputName, type Input } from './inputs'

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
    optionalIntegerIn(stage.onRejectIndex, `${label}.onRejectIndex`, 0, COMMAND_LIMITS.stages - 1)
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
    optionalEnum(input.protocolFamily, 'input.protocolFamily', PROTOCOL_FAMILIES) ??
    optionalText(input.command, 'input.command', COMMAND_LIMITS.command) ??
    optionalText(input.profile, 'input.profile', COMMAND_LIMITS.profile) ??
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
    case 'runtime.probed':
      return requiredId(command.id, 'id') ?? checkProbe(command.probe)
    case 'task.create':
      return checkTaskInput(command.input)
    case 'task.move':
      return requiredId(command.id, 'id') ?? requiredId(command.stageId, 'stageId')
    case 'task.complete':
    case 'task.remove':
      return requiredId(command.id, 'id')
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
    case 'conversation.create':
      return (
        requiredId(input.agentId, 'agentId') ??
        optionalText(input.title, 'title', COMMAND_LIMITS.title)
      )
    case 'conversation.send':
      return (
        requiredId(input.conversationId, 'conversationId') ??
        required(input.content, 'content', COMMAND_LIMITS.content)
      )
    case 'conversation.rename':
      return (
        requiredId(input.conversationId, 'conversationId') ??
        required(input.title, 'title', COMMAND_LIMITS.title)
      )
    case 'conversation.remove':
      return requiredId(input.conversationId, 'conversationId')
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
