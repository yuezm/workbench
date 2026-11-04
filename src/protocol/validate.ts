/**
 * 命令形状校验：宿主入口在派发前调用，renderer 传入的数据按不可信处理。
 *
 * 纯函数、不抛异常：非法输入返回 `{ ok: false, message }`，由宿主转成 IPC 错误码。
 * 只校验形状（必填 / 类型 / 长度上限 / 数组上限 / 枚举 / 数值范围）；
 * 引用是否存在、名称是否唯一、阶段流转是否合法由 `decide` 判断。
 */
import { COMMAND_NAMES, type Command, type CommandName } from './commands'
import { ENTRY_MODES, PERMISSION_MODES, PROBE_STATES, PROTOCOL_FAMILIES } from './entities'

/** 校验通过返回收窄后的命令；失败返回首条错误文案。 */
export type ValidateResult = { ok: true; command: Command } | { ok: false; message: string }

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
