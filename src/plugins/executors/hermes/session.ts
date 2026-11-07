/**
 * ACP 会话建立与配置（hermes）：initialize → session/load | session/new → set_mode → set_model。
 *
 * 顺序是协议要求：`session/prompt` 只能在会话 id 与配置都就位后发。建立/配置阶段的
 * 失败由调用方归一成 `protocol_error`（initialize 等握手失败）或 `run_failed`。
 */
import type { PermissionMode } from '../../../protocol/entities'
import { isRecord, type AcpClient } from './acp'
import { ACP_PROTOCOL_VERSION } from './constants'

/**
 * 权限模式 → ACP session mode id（三个 id 来自 hermes `session/new` 的
 * `modes.availableModes`，实测存在）。服务端没声明对应 mode 时调用方跳过 set_mode。
 */
export const ACP_MODE_IDS: Record<PermissionMode, string> = {
  'read-only': 'default',
  'workspace-write': 'accept_edits',
  'danger-full-access': 'dont_ask',
}

/** initialize 的结论 */
export interface AcpAgentInfo {
  /** 服务端回报的协议版本；缺失为 null */
  protocolVersion: number | null
  /** `agentInfo.version`（CLI 版本兜底）；缺失为 null */
  agentVersion: string | null
}

/** `session/new` / `session/load` 的结论（两者同形） */
export interface AcpSessionState {
  sessionId: string | null
  /** 模型目录：`availableModels[{modelId,name}]` + `currentModelId` */
  models: { available: Array<{ modelId: string; name: string }>; current: string | null } | null
  /** 模式目录：`availableModes[{id}]` + `currentModeId` */
  modes: { available: string[]; current: string | null } | null
}

/** 非空字符串，否则 null */
const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * initialize 握手：协议版本必须逐字匹配 `ACP_PROTOCOL_VERSION`（调用方校验）。
 */
export async function initializeAcp(
  acp: AcpClient,
  clientVersion: string,
  timeoutMs: number,
): Promise<AcpAgentInfo> {
  const result = await acp.request(
    'initialize',
    {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'workbench', version: clientVersion },
    },
    timeoutMs,
  )
  const agentInfo = isRecord(result.agentInfo) ? result.agentInfo : null
  return {
    protocolVersion: typeof result.protocolVersion === 'number' ? result.protocolVersion : null,
    agentVersion: agentInfo === null ? null : textOrNull(agentInfo.version),
  }
}

/** 读 `session/new` / `session/load` 的结果（缺字段按 null/空数组归一，不猜） */
export function readSessionState(result: Record<string, unknown>): AcpSessionState {
  const sessionId = textOrNull(result.sessionId)

  let models: AcpSessionState['models'] = null
  if (isRecord(result.models)) {
    const available: Array<{ modelId: string; name: string }> = []
    if (Array.isArray(result.models.availableModels)) {
      for (const entry of result.models.availableModels) {
        if (!isRecord(entry)) continue
        const modelId = textOrNull(entry.modelId)
        if (modelId === null) continue
        available.push({ modelId, name: textOrNull(entry.name) ?? '' })
      }
    }
    models = { available, current: textOrNull(result.models.currentModelId) }
  }

  let modes: AcpSessionState['modes'] = null
  if (isRecord(result.modes)) {
    const available: string[] = []
    if (Array.isArray(result.modes.availableModes)) {
      for (const entry of result.modes.availableModes) {
        if (!isRecord(entry)) continue
        const id = textOrNull(entry.id)
        if (id !== null) available.push(id)
      }
    }
    modes = { available, current: textOrNull(result.modes.currentModeId) }
  }

  return { sessionId, models, modes }
}

/**
 * 建立会话：给了 `resumeSessionId` 走 `session/load`（续接），否则 `session/new`。
 * 失败直接抛出（调用方按阶段归一；续接被拒时还要标 `resumeRejected`）。
 */
export async function openSession(
  acp: AcpClient,
  request: { cwd: string | undefined; resumeSessionId: string | null },
  timeoutMs: number,
): Promise<AcpSessionState> {
  const params: Record<string, unknown> = { mcpServers: [] }
  if (request.cwd !== undefined) params.cwd = request.cwd
  if (request.resumeSessionId !== null) {
    params.sessionId = request.resumeSessionId
    return readSessionState(await acp.request('session/load', params, timeoutMs))
  }
  return readSessionState(await acp.request('session/new', params, timeoutMs))
}

/**
 * 应用运行时配置：会话 mode 与模型各最多一次往返。
 *
 * - 服务端没声明目标 mode（或根本没声明 modes）：跳过 set_mode，只记日志——这不是失败；
 * - 当前已是目标模式：跳过（省一次往返）；
 * - `model` 为 null：跳过，用 hermes 自己配置的默认模型；
 * - `reasoningEffort`：ACP 没有对应方法，`hermes acp` 也不接受 `--reasoning` 参数，
 *   因此完全跳过（见 `run.ts` 的同名说明）。
 */
export async function applySessionConfig(
  acp: AcpClient,
  state: AcpSessionState,
  options: {
    sessionId: string
    permissionMode: PermissionMode
    /** 已解析的模型选择；null = 用 hermes 默认模型 */
    model: { provider: string; id: string } | null
    log: (line: string) => void
    timeoutMs: number
  },
): Promise<void> {
  const { sessionId } = options
  const modeId = ACP_MODE_IDS[options.permissionMode]
  if (state.modes === null) {
    options.log(`session/new 未声明 modes，跳过 session/set_mode（沿用服务端默认模式）`)
  } else if (!state.modes.available.includes(modeId)) {
    options.log(
      `服务端未声明模式「${modeId}」，跳过 session/set_mode（当前模式 ${state.modes.current ?? '未知'}）`,
    )
  } else if (state.modes.current === modeId) {
    options.log(`当前模式已是「${modeId}」，跳过 session/set_mode`)
  } else {
    await acp.request('session/set_mode', { sessionId, modeId }, options.timeoutMs)
  }

  if (options.model === null) return
  // hermes 的模型 id 是 `provider:model` 形式（如 opencode-go:kimi-k3、
  // custom:magpie:minimax-code/...）；斜杠后面的部分原样保留
  const modelId = `${options.model.provider}:${options.model.id}`
  if (state.models !== null && state.models.current === modelId) return
  await acp.request('session/set_model', { sessionId, modelId }, options.timeoutMs)
}
