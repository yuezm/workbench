/**
 * 执行器表单的默认值（D11）：运行时表单里那些「留空就用清单默认」的字段。
 *
 * 默认值来自执行器插件 manifest，内核与宿主都不写产品名。拆成纯函数的好处是
 * 「未指定 key / 未知 key / 字段没有默认值 / 默认值不是字符串」这些组合可以直接测，
 * 不必起整套装配。
 */
import type { ExecutorRegistryEntry } from '@workbench/plugins-registry'
import type { RuntimeExecutorChoice, RuntimeInput } from '@workbench/protocol/entities'

/** 取 manifest 里某字段的字符串默认值；没有该字段或默认值不是字符串时回空串。 */
export function manifestDefaultOf(entry: ExecutorRegistryEntry, fieldKey: string): string {
  const field = (entry.manifest.config ?? []).find((candidate) => candidate.key === fieldKey)
  if (field === undefined) return ''
  const value = 'default' in field ? field.default : undefined
  return typeof value === 'string' ? value : ''
}

/**
 * 按 key 取执行器注册项；未指定 key 时取注册表首项，未知 key 抛可读错误
 * （路由层原样展示，由调用方决定兜底终态）。
 */
export function executorEntryOf(
  executors: readonly ExecutorRegistryEntry[],
  key: string | undefined,
): ExecutorRegistryEntry {
  const entry =
    key === undefined ? executors[0] : executors.find((candidate) => candidate.key === key)
  if (entry === undefined) throw new Error('执行器插件未注册: ' + String(key))
  return entry
}

/** 运行时表单的默认值三件套（执行器键 + 命令 + profile） */
export function executorDefaultsOf(
  executors: readonly ExecutorRegistryEntry[],
  key: string | undefined,
): Required<Pick<RuntimeInput, 'executorKey' | 'command' | 'profile'>> {
  const entry = executorEntryOf(executors, key)
  return {
    executorKey: entry.key,
    command: manifestDefaultOf(entry, 'command'),
    profile: manifestDefaultOf(entry, 'profile'),
  }
}

/** 运行时表单下拉（D11）：只读，顺序即注册表顺序 */
export function executorChoicesOf(
  executors: readonly ExecutorRegistryEntry[],
): RuntimeExecutorChoice[] {
  return executors.map((entry) => ({
    key: entry.key,
    label: entry.label,
    command: manifestDefaultOf(entry, 'command'),
    profile: manifestDefaultOf(entry, 'profile'),
  }))
}
