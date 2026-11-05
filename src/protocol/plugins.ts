/**
 * 插件设置契约（M7）：插件启停、能力授权与 config 的整批快照形状。
 *
 * 真相源口径：**非密钥**设置（`enabled` / `granted` / `config`）走事实日志
 * （`plugins.replaced`，整批替换、版本 +1），由 `kernel/plugins` 校验、`kernel/project`
 * 落到第 14 张投影表 `plugin_settings`。secret 值不进事实、不进本文件的 `config`：
 * 它们由宿主写非投影表 `plugin_secrets`，读路径只回 `secretKeys`（键名，不含值）。
 *
 * 形状上限在这里定义一次：`protocol/validate` 校验不可信输入，`kernel/plugins`
 * 做决策前的前置校验（两端同一口径）。
 */
import type { Capability, ConfigField, PluginKind } from './manifest'

/** 插件设置字段上限（超限拒收，不截断）。 */
export const PLUGIN_SETTING_LIMITS = {
  /** 单次快照的插件条数（内置 + 用户目录的量级） */
  settings: 64,
  /** 插件 id 长度（kebab-case slug） */
  id: 64,
  /** config 键数量与键 / 值长度 */
  configEntries: 32,
  configKey: 64,
  configValue: 2_000,
} as const

/** 设置快照在投影里的固定主键（单行表）。 */
export const PLUGIN_SETTINGS_ID = 'current'

/**
 * 一条插件设置：
 * - `enabled`：用户是否启用（外部插件默认不启用；内置插件缺省视为启用）；
 * - `granted`：用户已授权的能力（必须 ⊆ manifest 声明的 capabilities）；
 * - `config`：manifest 声明的**非 secret** 字段值；secret 字段不进这里。
 */
export interface PluginSetting {
  /** kebab-case，全局唯一（与内置 / 用户目录里的 manifest.id 对应） */
  id: string
  kind: PluginKind
  enabled: boolean
  granted: Capability[]
  /** 只存标量（字符串 / 数字 / 布尔），结构由 manifest 的 ConfigField 描述 */
  config: Record<string, string | number | boolean>
}

/** 设置快照事实（`plugins.replaced`）携带的完整行；`project` 只做整行 upsert。 */
export interface PluginSettingsRow {
  id: typeof PLUGIN_SETTINGS_ID
  /** 随每次整批替换 +1（空快照也保留行，与 `rule_sets` 同口径） */
  version: number
  /** 该版本生效时刻（ISO） */
  replacedAt: string
  settings: PluginSetting[]
}

/** 读视图 `plugins.settings` 的形状（无设置快照时是版本 0 的空集）。 */
export interface PluginSettingsView {
  version: number
  replacedAt: string | null
  settings: PluginSetting[]
}

/**
 * 插件运行状态（宿主视图 `plugins.all` 现算，不落事实）：
 * - `ready`：已启用且已满足授权（内置插件恒可用）；
 * - `disabled`：用户关闭；
 * - `unauthorized`：外部插件缺少授权（或声明能力未全部授权），不会启动；
 * - `error`：启动/运行失败（子进程崩溃达到重启上限、端口占用等）；
 * - `manifest_error`：用户目录里的 manifest 不合法或 kind 不受支持。
 */
export const PLUGIN_STATUSES = [
  'ready',
  'disabled',
  'unauthorized',
  'error',
  'manifest_error',
] as const

export type PluginStatus = (typeof PLUGIN_STATUSES)[number]

/**
 * 宿主视图 `plugins.all` 的一行：磁盘上发现的插件 + 当前设置 + 运行状态。
 *
 * 有意不返回 secret 值：`config` 只含非 secret 字段，`secretKeys` 只回已写入的键名。
 */
export interface PluginView {
  id: string
  kind: PluginKind
  name: string
  version: string
  description: string
  /** 内置（静态注册表）为 true；用户目录装载为 false */
  builtin: boolean
  enabled: boolean
  /** manifest 声明的能力 */
  declared: Capability[]
  /** 已授权的能力（内置插件恒等于 declared） */
  granted: Capability[]
  /** manifest 声明的 config 字段（设置页据此渲染表单） */
  configFields: ConfigField[]
  /** 非 secret 字段的当前值 */
  config: Record<string, string | number | boolean>
  /** 已写入的 secret 字段名（不含值） */
  secretKeys: string[]
  status: PluginStatus
  /** 仅 `error` / `manifest_error` 有值 */
  error: string | null
}

/** 命令 `plugin.set` 的补丁形状（宿主命令路由读快照、合并、转 `plugins.replace`）。 */
export interface PluginSetCommandPayload {
  pluginId: string
  enabled?: boolean
  granted?: Capability[]
  config?: Record<string, string | number | boolean>
  /** secret 字段：`null` 表示删除该键；只写宿主 secret 表，不进事实 */
  secrets?: Record<string, string | null>
}
