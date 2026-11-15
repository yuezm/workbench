/**
 * 插件 manifest 契约（M3）：纯类型 + 枚举常量，不做 IO、不 import 任何实现。
 *
 * SPEC-plugins 的路径是 `src/plugins/manifest.ts`；实现放那里、**定义**放契约层，
 * 因为 `src/sdk`（插件能力面）需要引用 manifest 的类型，而依赖方向只允许
 * `sdk → protocol`。`src/plugins/manifest.ts` 只是再导出。
 */

/** 四类插件（交付流水线不是第五类，是「规则 + 智能体 + 项目配置」的组合） */
export const PLUGIN_KINDS = ['source', 'executor', 'channel', 'app'] as const

export type PluginKind = (typeof PLUGIN_KINDS)[number]

/**
 * 能力声明：内置插件按声明做静态检查（ESLint + 源码扫描 + `createSdk` 运行期门控）；
 * 外部插件在 M7 按声明逐次授权。
 */
export const CAPABILITIES = ['net', 'fs.read', 'fs.write', 'spawn', 'notify'] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * 下拉候选的**动态来源**：清单只说「去哪取」，清单本身不带业务数据
 * （智能体清单会变，写死在 manifest 里第二天就过期了）。
 *
 * - `agents`：设置页订阅内核视图 `agents.all`，显示名称、存 id（改名不影响绑定）；
 *   存进去的值由消费方按 id 或名称匹配（如飞书通道的 `agent`）。
 */
export const CONFIG_OPTION_SOURCES = ['agents'] as const

export type ConfigOptionSource = (typeof CONFIG_OPTION_SOURCES)[number]

/**
 * 设置页据此渲染表单并校验（M3 只用于执行器的运行时配置默认值）。
 *
 * `advanced` 只影响设置页的**摆放**，不影响内核与插件读取：标了它的字段默认收进
 * 「高级」里，展开才渲染——第一次就能用的东西不该和「改坏了才需要」的东西平铺在一起。
 *
 * `select` 的候选二选一：静态 `options`，或动态 `optionsFrom`（两者都给判非法）。
 */
export type ConfigField =
  | {
      key: string
      label: string
      type: 'text' | 'secret' | 'select'
      required?: boolean
      advanced?: boolean
      options?: readonly string[]
      optionsFrom?: ConfigOptionSource
      default?: string
      help?: string
    }
  | {
      key: string
      label: string
      type: 'number' | 'boolean'
      required?: boolean
      advanced?: boolean
      default?: number | boolean
      help?: string
    }

export interface PluginManifest {
  /** kebab-case，全局唯一；执行器插件的 id 即运行时配置的 `executorKey` */
  id: string
  kind: PluginKind
  name: string
  version: string
  description?: string
  capabilities: readonly Capability[]
  config?: readonly ConfigField[]
}
