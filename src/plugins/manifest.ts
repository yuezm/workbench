/**
 * 插件 manifest（`src/plugins/manifest.ts`，SPEC-plugins 的约定路径）。
 *
 * 类型定义在 `src/protocol/manifest.ts`（契约层）：`src/sdk` 需要引用它，
 * 而依赖方向只允许 `sdk → protocol`。本文件只做再导出，保持「插件目录内固定文件名」。
 */
export type { Capability, ConfigField, PluginKind, PluginManifest } from '../protocol/manifest'
export { CAPABILITIES, PLUGIN_KINDS } from '../protocol/manifest'
