/**
 * 内置插件注册表（M3）：唯一的静态导入点，按固定顺序列出内置执行器。
 *
 * 依赖方向：`registry → 具体插件 + sdk/protocol 类型`；宿主只经本文件取插件，
 * 不直接 import `executors/**`（ESLint 强制）。新增执行器协议 =
 * 新增 `src/plugins/executors/<id>/` + 本文件 `executors` 一行。
 *
 * `executors` 的数组顺序即 UI 下拉与 `detect()` 的输出顺序。
 */
import type { PluginManifest } from '../protocol/manifest'
import type { ExecutorPlugin } from '../sdk/types'
import { dshPlugin } from './executors/dsh'
import { dshManifest } from './executors/dsh/manifest'

/** 一条执行器注册项（`host/executor-registry.ts` 的 `ExecutorPluginEntry` 结构兼容） */
export interface ExecutorRegistryEntry {
  /** 执行器键，等于 `manifest.id` 与运行时配置的 `executorKey` */
  key: string
  /** 展示名（运行时表单/角标用） */
  label: string
  manifest: PluginManifest
  plugin: ExecutorPlugin
}

/** 内置执行器清单：顺序即 UI 与 detect 顺序 */
export const executors: ReadonlyArray<ExecutorRegistryEntry> = [
  { key: dshManifest.id, label: dshManifest.name, manifest: dshManifest, plugin: dshPlugin },
]

/** 按 key 取执行器注册项；未知 key 抛可读错误（调用方决定兜底终态） */
export function executorById(key: string): ExecutorRegistryEntry {
  const found = executors.find((entry) => entry.key === key)
  if (found === undefined) throw new Error(`执行器插件未注册: ${key}`)
  return found
}
