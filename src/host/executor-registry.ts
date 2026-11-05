/**
 * 执行器注册表装配（M3）：把插件清单 + 宿主能力面接成调度器要的 `SchedulerExecutors`。
 *
 * 依赖方向：`host → sdk + protocol + plugins/registry`（见 ARCHITECTURE）。
 * 本文件不 import 任何具体插件：装配根（`src/main`）把 `src/plugins/registry.ts` 的
 * `executors` 清单传进来，测试可传假插件——「新增协议只写插件 + registry 一行」的
 * 验收（`tests/plugins/acceptance.test.ts`）就走这条路径。
 */
import { createSdk } from '../sdk'
import type { ExecutorPlugin, Sdk, SdkHost } from '../sdk/types'
import type { PluginManifest } from '../protocol/manifest'
import type { ExecutorPort } from '../protocol/executor'
import type { Runtime } from '../protocol/entities'
import { createExecutorPort, type ExecutorPortOptions } from './executor'
import type { SchedulerExecutors } from './scheduler'

/** 内置执行器插件的一条注册项（`src/plugins/registry.ts` 的导出形状）。 */
export interface ExecutorPluginEntry {
  /** 执行器键，等于 manifest.id 与运行时配置的 `executorKey` */
  key: string
  /** 展示名（运行时表单/角标用） */
  label: string
  manifest: PluginManifest
  plugin: ExecutorPlugin
}

/**
 * 按 `runtime.executorKey` 取执行器端口的工厂。
 *
 * - 未知 key 返回 `null`：调度器据此落 `runtime_missing` 兜底终态（M3 D7），
 *   不去猜、也不把配置错误变成进程启动失败。
 * - 每个插件的 sdk 按 manifest 构造一次并缓存（能力门控结果稳定，构造无副作用）。
 */
export function createExecutorRegistry(
  entries: readonly ExecutorPluginEntry[],
  sdkHost: SdkHost,
  options: ExecutorPortOptions = {},
): SchedulerExecutors {
  const byKey = new Map<string, ExecutorPluginEntry>()
  for (const entry of entries) byKey.set(entry.key, entry)
  const sdks = new Map<string, Sdk>()
  const sdkFor = (entry: ExecutorPluginEntry): Sdk => {
    const cached = sdks.get(entry.key)
    if (cached !== undefined) return cached
    const sdk = createSdk(sdkHost, entry.manifest)
    sdks.set(entry.key, sdk)
    return sdk
  }

  return {
    forRuntime(runtime: Runtime): ExecutorPort | null {
      const entry = byKey.get(runtime.executorKey)
      if (entry === undefined) return null
      return createExecutorPort(entry.plugin, { runtime, sdk: sdkFor(entry) }, options)
    },
  }
}
