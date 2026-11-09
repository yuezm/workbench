/**
 * dsh 模型目录（dsh 专属）：解析 `--list-models` 输出的 `models` 帧。
 *
 * 帧里的 thinking 兼容 `{value,label}` 与裸字符串两种形态；provider 缺失时从
 * 模型 id 前缀兜底。失败抛错，由 IPC 入口转成可读错误。
 */
import type { RuntimeModelOption } from '../../../protocol/entities'
import type { ExecutorContext } from '../../../sdk/types'
import { parseFrame } from '../../shared/jsonl'
import { withStderr } from '../../shared/text'
import { MODELS_TIMEOUT_MS } from './constants'
import type { DshFrame, DshModelFrame } from './frames'
import { collect, errMsg, type DshOptions } from './process'

/**
 * provider 展示名缺失时从模型 id 前缀兜底。
 *
 * 导出到模块级：id 不是字符串这条兜底分支在正常运行时不可达（调用点先过滤），
 * 导出后由单测直接构造输入覆盖（逻辑与调用点均不变）。
 */
export function providerOf(model: DshModelFrame): string {
  if (typeof model.provider === 'string' && model.provider.trim()) return model.provider.trim()
  const id = typeof model.id === 'string' ? model.id : ''
  const index = id.indexOf('/')
  return index > 0 ? id.slice(0, index) : ''
}

/** thinking 帧兼容 {value,label} 与裸字符串两种形态 */
function thinkingLevels(model: DshModelFrame): string[] {
  const raw = model.thinking?.supported_levels
  if (!Array.isArray(raw)) return []
  const levels: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      levels.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const value = (item as DshThinkingLevelLike).value
      if (typeof value === 'string' && value.trim()) levels.push(value.trim())
    }
  }
  return levels
}

interface DshThinkingLevelLike {
  value?: unknown
}

/** 读取模型目录（--list-models）；失败抛错，由 IPC 转成可读错误 */
export async function listDshModels(
  ctx: ExecutorContext,
  options: DshOptions = {},
): Promise<RuntimeModelOption[]> {
  const { sdk, runtime } = ctx
  const modelsTimeout = options.timeouts?.models ?? MODELS_TIMEOUT_MS
  const collected = await collect(
    sdk,
    runtime.command,
    runtime.profile,
    ['--list-models'],
    modelsTimeout,
  )
  if (collected.spawnError)
    throw new Error(withStderr(`启动失败：${errMsg(collected.spawnError)}`, collected.stderr))
  if (collected.timedOut) throw new Error(`读取模型目录超时（${modelsTimeout}ms）`)

  const models: RuntimeModelOption[] = []
  for (const line of collected.stdout.split('\n')) {
    const frame = parseFrame<DshFrame>(line)
    if (!frame || frame.type !== 'models' || !Array.isArray(frame.models)) continue
    for (const item of frame.models) {
      if (typeof item.id !== 'string' || !item.id.trim()) continue
      const id = item.id.trim()
      models.push({
        id,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id,
        provider: providerOf(item),
        default: item.default === true,
        thinkingLevels: thinkingLevels(item),
        defaultThinkingLevel:
          typeof item.thinking?.default_level === 'string' && item.thinking.default_level.trim()
            ? item.thinking.default_level.trim()
            : null,
      })
    }
  }

  if (models.length === 0) {
    const reason =
      collected.code !== 0
        ? `读取模型目录退出码 ${collected.code ?? 'null'}`
        : '模型目录为空（profile 未提供 --list-models？）'
    throw new Error(withStderr(reason, collected.stderr))
  }
  return models
}
