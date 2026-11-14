/**
 * 插件设置（M7，纯函数）：整批校验与单条 patch 合并。
 *
 * 口径：
 * - 设置快照整批替换（`plugins.replace`，版本 +1），任一条非法整批拒绝、旧版继续生效；
 * - `plugin.set` 是宿主命令路由的编排入口：宿主按「磁盘 manifest 的缺省值 + 当前快照」
 *   算出 seed，再用 `mergePluginSetting` 合并 patch，最后走整批替换；
 * - 内核不认识插件目录：这里只校验形状与「授权 ⊆ 能力全集」，不判断插件是否存在。
 */
import type { Capability } from '../../protocol/manifest'
import { CAPABILITIES } from '../../protocol/manifest'
import { PLUGIN_ID_PATTERN } from '../../protocol/plugin-host'
import {
  PLUGIN_SETTING_LIMITS,
  PLUGIN_SETTINGS_ID,
  type PluginSetting,
  type PluginSetCommandPayload,
  type PluginSettingsRow,
} from '../../protocol/plugins'
import type { Iso } from '../core/types'

/** 单条设置的缺省值来源（宿主按 manifest 与内置/用户目录算出）。 */
export interface PluginSettingSeed {
  id: string
  kind: PluginSetting['kind']
  enabled: boolean
  granted: Capability[]
  config: Record<string, string | number | boolean>
}

const isCapability = (value: unknown): value is Capability =>
  typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)

/**
 * 整批校验：任一条非法返回首条错误文案（调用方整批 reject）。
 * 形状上限由 `protocol/validate` 先挡一层；这里补「语义」：id 唯一、能力可识别、config 值合法。
 */
export function validatePluginSettings(
  settings: readonly PluginSetting[],
): { settings: PluginSetting[] } | { error: string } {
  if (settings.length > PLUGIN_SETTING_LIMITS.settings) {
    return { error: `插件设置最多 ${PLUGIN_SETTING_LIMITS.settings} 条` }
  }
  const ids = new Set<string>()
  const normalized: PluginSetting[] = []
  for (let index = 0; index < settings.length; index += 1) {
    const setting = settings[index]
    if (setting === undefined) return { error: `插件设置 ${index + 1}: 缺失` }
    const id = setting.id.trim()
    if (id === '' || !PLUGIN_ID_PATTERN.test(id)) {
      return { error: `插件设置 ${index + 1}: id 必须是小写 slug` }
    }
    if (ids.has(id)) return { error: `插件 id 重复: ${id}` }
    ids.add(id)
    if (typeof setting.enabled !== 'boolean') {
      return { error: `插件「${id}」: enabled 必须是布尔值` }
    }
    const granted: Capability[] = []
    for (const capability of setting.granted) {
      if (!isCapability(capability)) {
        return { error: `插件「${id}」: 未知能力 ${String(capability)}` }
      }
      if (granted.includes(capability)) {
        return { error: `插件「${id}」: 能力重复 ${capability}` }
      }
      granted.push(capability)
    }
    const configError = validateConfig(id, setting.config)
    if (configError !== null) return { error: configError }
    normalized.push({
      id,
      kind: setting.kind,
      enabled: setting.enabled,
      granted,
      config: { ...setting.config },
    })
  }
  return { settings: normalized }
}

function validateConfig(
  id: string,
  config: Record<string, string | number | boolean>,
): string | null {
  const entries = Object.entries(config)
  if (entries.length > PLUGIN_SETTING_LIMITS.configEntries) {
    return `插件「${id}」: config 最多 ${PLUGIN_SETTING_LIMITS.configEntries} 项`
  }
  for (const [key, value] of entries) {
    if (key.trim() === '' || key.length > PLUGIN_SETTING_LIMITS.configKey) {
      return `插件「${id}」: config 键非法 ${key}`
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return `插件「${id}」: config.${key} 必须是有限数字`
    }
    if (typeof value === 'string' && value.length > PLUGIN_SETTING_LIMITS.configValue) {
      return `插件「${id}」: config.${key} 最长 ${PLUGIN_SETTING_LIMITS.configValue} 个字符`
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return `插件「${id}」: config.${key} 必须是标量`
    }
  }
  return null
}

/** 设置快照行（`plugins.replaced` 的 payload）；版本由当前快照 +1。 */
export function replacedPluginSettings(
  settings: readonly PluginSetting[],
  version: number,
  now: Iso,
): PluginSettingsRow {
  return { id: PLUGIN_SETTINGS_ID, version, replacedAt: now, settings: [...settings] }
}

/** 按 seed 合并一条 patch：未提供的字段保持 seed 值；`granted`/`config` 是整体替换。 */
export function mergePluginSetting(
  seed: PluginSettingSeed,
  patch: PluginSetCommandPayload,
): PluginSetting {
  const enabled = patch.enabled === undefined ? seed.enabled : patch.enabled
  const granted = patch.granted === undefined ? [...seed.granted] : [...patch.granted]
  const config =
    patch.config === undefined ? { ...seed.config } : { ...seed.config, ...patch.config }
  return { id: seed.id, kind: seed.kind, enabled, granted, config }
}
