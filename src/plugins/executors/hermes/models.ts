/**
 * hermes 模型目录（hermes 专属）：initialize + 一次性 `session/new`，读
 * `result.models.availableModels`。
 *
 * ACP 的模型 id 是 `provider:model` 形式（如 `opencode-go:kimi-k3`、
 * `custom:magpie:minimax-code/...`），而运行时字段与界面统一用 `provider/model`：
 * 这里把**第一个**冒号换回斜杠，其余原样保留。读不到目录就抛可读错误，由 IPC 转成提示。
 */
import type { RuntimeModelOption } from '../../../protocol/entities'
import type { ExecutorContext } from '../../../sdk/types'
import { withStderr } from '../../shared/text'
import { ACP_PROTOCOL_VERSION, KILL_GRACE_MS, MODELS_TIMEOUT_MS } from './constants'
import { hermesManifest } from './manifest'
import { errMsg, startProcess, type HermesOptions } from './process'
import { initializeAcp, openSession } from './session'
import { connect, stopLink } from './wire'

/** `provider:model` → 运行时用的 `provider/model`（只换第一个冒号） */
export function toRuntimeModelId(modelId: string): string {
  const index = modelId.indexOf(':')
  if (index <= 0 || index === modelId.length - 1) return modelId
  return `${modelId.slice(0, index)}/${modelId.slice(index + 1)}`
}

/**
 * provider 展示名：ACP 的 `ModelInfo` 只有 `modelId` / `name` / `description`，
 * 没有 provider 字段，因此取 id 里第一个冒号之前那段；没有前缀就空串。
 */
export function providerOfModel(modelId: string): string {
  const index = modelId.indexOf(':')
  return index > 0 ? modelId.slice(0, index).trim() : ''
}

/**
 * 读模型目录：起一个临时会话只为拿 `models`，读完立刻杀进程。
 * 失败抛错（由 IPC 转成可读错误）；ACP 没有 thinking level，故两项为空。
 */
export async function listHermesModels(
  ctx: ExecutorContext,
  options: HermesOptions = {},
): Promise<RuntimeModelOption[]> {
  const { sdk, runtime } = ctx
  const modelsTimeout = options.timeouts?.models ?? MODELS_TIMEOUT_MS
  const graceKill = options.grace?.kill ?? KILL_GRACE_MS
  const cwd = runtime.workdir ?? sdk.paths.cwd

  const launched = startProcess(sdk, runtime.command, ['acp'], undefined, {})
  if (!launched.process) {
    throw new Error(launched.error ?? `找不到可执行文件：${runtime.command}`)
  }

  const link = connect(sdk, launched.process)
  try {
    const info = await initializeAcp(link.acp, hermesManifest.version, modelsTimeout)
    if (info.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `不兼容的协议版本：${info.protocolVersion === null ? '缺失' : String(info.protocolVersion)}（需要 ${ACP_PROTOCOL_VERSION}）`,
      )
    }
    const opened = await openSession(link.acp, { cwd, resumeSessionId: null }, modelsTimeout)
    const available = opened.models?.available ?? []
    if (available.length === 0) {
      throw new Error('模型目录为空（session/new 没有返回 models.availableModels）')
    }
    const current = opened.models?.current ?? null
    return available.map((entry) => ({
      id: toRuntimeModelId(entry.modelId),
      label: entry.name || entry.modelId,
      provider: providerOfModel(entry.modelId),
      default: current === entry.modelId,
      // ACP 没有 thinking level 概念（也没有 set_thinking 方法）
      thinkingLevels: [],
      defaultThinkingLevel: null,
    }))
  } catch (error) {
    // 保留原始错误（cause）：上层文案给用户看，原始错误留给日志
    throw new Error(withStderr(errMsg(error), link.stderr(), 'hermes stderr'), { cause: error })
  } finally {
    await stopLink(link, graceKill)
  }
}
