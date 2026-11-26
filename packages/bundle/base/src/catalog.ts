/**
 * 插件目录（内置注册表 + 用户目录）的合并与派生视图（M7）。
 *
 * 从装配根拆出来：这些判断只依赖「清单 + 设置行 + 密钥 + 来源运行状态」，与进程装配无关。
 * 拆开后装配根只做接线，判断本身可以逐分支单测（含重复 id、未授权、运行期报错这些
 * 靠真进程很难稳定构造的组合）。
 *
 * 口径（与 `docs/specs/SPEC-plugins.md` 一致）：
 * - 插件 id 全局唯一：内置与用户插件同 `kind+id` 时**用户目录覆盖内置**（不是错误）；
 *   与其它 kind 已占用的 id 冲突则拒绝并给出 `duplicate_id`；
 * - 外部插件默认不启用：`enabled && 声明能力全部授权` 才算可用，否则视图给
 *   `disabled` / `unauthorized`；
 * - 内置插件恒可信（授权面由本仓库自己定）。
 */
import type { ExternalAdapterOptions } from '@workbench/host/plugins/adapters'
import {
  createExternalChannelPlugin,
  createExternalSourcePlugin,
} from '@workbench/host/plugins/adapters'
import type { ExternalPluginEntry, ExternalPluginRejection } from '@workbench/host/plugins/discover'
import { resolvePluginConfig } from '@workbench/host/plugins/settings'
import type { SourceStatus } from '@workbench/host/sources'
import type {
  ChannelRegistryEntry,
  SourceRegistryEntry as BuiltinSourceEntry,
} from '@workbench/plugins-registry'
import { channelById, sourceById } from '@workbench/plugins-registry'
import type { Capability, PluginKind, PluginManifest } from '@workbench/protocol/manifest'
import { PLUGIN_KINDS } from '@workbench/protocol/manifest'
import type { PluginSetting, PluginStatus, PluginView } from '@workbench/protocol/plugins'
import type { PluginCommandDeps } from '@workbench/host/commands'

/** 磁盘插件目录（内置 + 用户目录）合并后的一条 */
export interface CatalogEntry {
  id: string
  kind: PluginKind
  builtin: boolean
  manifest: PluginManifest
  /** 用户目录插件（内置为 null） */
  external: ExternalPluginEntry | null
}

/** 内置注册表的一条（只需要 key 与 manifest 参与合并） */
export interface BuiltinCatalogEntry {
  key: string
  manifest: PluginManifest
}

/** 合并结果：可装载的目录行 + 需要展示给用户的拒绝项 */
export interface CatalogMerge {
  catalog: CatalogEntry[]
  rejections: ExternalPluginRejection[]
}

/**
 * 合并内置注册表与用户目录插件。
 *
 * 顺序：先内置（注册表顺序），再用户目录（发现顺序）；同 `kind+id` 命中内置行时**原地替换**
 * 该行（位置不变，视图顺序稳定），其余 id 冲突一律拒绝。
 */
export function mergeCatalog(
  builtins: readonly BuiltinCatalogEntry[],
  discovered: {
    entries: readonly ExternalPluginEntry[]
    rejections: readonly ExternalPluginRejection[]
  },
): CatalogMerge {
  const rejections: ExternalPluginRejection[] = [...discovered.rejections]
  const catalog: CatalogEntry[] = []
  for (const builtin of builtins) {
    catalog.push({
      id: builtin.key,
      kind: builtin.manifest.kind,
      builtin: true,
      manifest: builtin.manifest,
      external: null,
    })
  }
  for (const external of discovered.entries) {
    const sameKind = catalog.findIndex(
      (candidate) => candidate.id === external.id && candidate.kind === external.kind,
    )
    const next: CatalogEntry = {
      id: external.id,
      kind: external.kind,
      builtin: false,
      manifest: external.manifest,
      external,
    }
    if (sameKind >= 0 && catalog[sameKind]?.builtin === true) {
      catalog[sameKind] = next
      continue
    }
    // 插件 id 全局唯一：与其它 kind 的内置/外部插件撞 id 时拒绝（不静默并存）
    if (catalog.some((candidate) => candidate.id === external.id)) {
      rejections.push({
        path: `${external.kind}/${external.id}`,
        kind: external.kind,
        id: external.id,
        reason: 'duplicate_id',
        detail: `插件 id 已被占用: ${external.id}`,
      })
      continue
    }
    catalog.push(next)
  }
  return { catalog, rejections }
}

/** 插件运行期依赖：设置行、解密后的 secret、secret 键名（都由宿主注入） */
export interface PluginRuntimeState {
  settingOf: (id: string) => PluginSetting | null
  /** 解密后的 secret（只给 `welcome` 组装用，不回显） */
  secretsOf: (id: string) => Record<string, string>
  /** secret 键名（视图只回键名） */
  secretKeysOf: (id: string) => string[]
}

/** 外部插件适配器需要的原件（装配根注入 node 路径、spawn、日志） */
export interface AdapterDeps {
  execPath: string
  spawn: ExternalAdapterOptions['spawn']
  log: (line: string) => void
}

/** manifest 声明的能力（顺序即清单顺序） */
export function declaredOf(entry: CatalogEntry): Capability[] {
  return [...entry.manifest.capabilities]
}

/** 已授权的能力：内置恒等于声明；外部只认设置行里的 `granted` */
export function grantedOf(entry: CatalogEntry, runtime: PluginRuntimeState): Capability[] {
  return entry.builtin ? declaredOf(entry) : (runtime.settingOf(entry.id)?.granted ?? [])
}

/** 声明能力是否全部授权 */
export function authorizedOf(entry: CatalogEntry, runtime: PluginRuntimeState): boolean {
  return declaredOf(entry).every((capability) => grantedOf(entry, runtime).includes(capability))
}

/** 是否启用：内置只受 `enabled=false` 影响；外部必须显式启用且已授权 */
export function enabledOf(entry: CatalogEntry, runtime: PluginRuntimeState): boolean {
  const setting = runtime.settingOf(entry.id)
  if (entry.builtin) return setting?.enabled !== false
  return setting?.enabled === true && authorizedOf(entry, runtime)
}

/** 合并后的运行配置（manifest 默认值 + 设置值 + 授权后的 secret） */
export function configOf(
  entry: CatalogEntry,
  runtime: PluginRuntimeState,
): Record<string, string | number | boolean> {
  return resolvePluginConfig(
    entry.manifest,
    runtime.settingOf(entry.id),
    runtime.secretsOf(entry.id),
    entry.builtin,
  )
}

/** 外部插件的适配器选项；内置返回 null（走注册表的原生实现） */ export function adapterOptionsOf(
  entry: CatalogEntry,
  runtime: PluginRuntimeState,
  deps: AdapterDeps,
): ExternalAdapterOptions | null {
  if (entry.external === null) return null
  return {
    // 服务端进程就是 node：子进程用同一个可执行文件跑 `plugin.mjs`
    execPath: deps.execPath,
    spawn: deps.spawn,
    granted: grantedOf(entry, runtime),
    config: configOf(entry, runtime),
    log: (line) => deps.log(line),
  }
}

/** 通道注册项：外部插件包成适配器，内置取注册表原生实现 */
export function channelEntriesOf(
  catalog: readonly CatalogEntry[],
  runtime: PluginRuntimeState,
  deps: AdapterDeps,
): ChannelRegistryEntry[] {
  return catalog
    .filter((entry) => entry.kind === 'channel')
    .map((entry) => {
      const adapter = adapterOptionsOf(entry, runtime, deps)
      const external = entry.external
      if (external !== null && adapter !== null) {
        return {
          key: entry.id,
          label: entry.manifest.name,
          manifest: entry.manifest,
          plugin: createExternalChannelPlugin(external, adapter),
        }
      }
      return channelById(entry.id)
    })
}

/** 来源注册项：外部插件包成适配器，内置取注册表原生实现 */
export function sourceEntriesOf(
  catalog: readonly CatalogEntry[],
  runtime: PluginRuntimeState,
  deps: AdapterDeps,
): BuiltinSourceEntry[] {
  return catalog
    .filter((entry) => entry.kind === 'source')
    .map((entry) => {
      const adapter = adapterOptionsOf(entry, runtime, deps)
      const external = entry.external
      if (external !== null && adapter !== null) {
        return {
          key: entry.id,
          label: entry.manifest.name,
          manifest: entry.manifest,
          plugin: createExternalSourcePlugin(external, adapter),
        }
      }
      return sourceById(entry.id) as BuiltinSourceEntry
    })
}

/**
 * 通道 / 来源 hub 的配置取值：按 `kind + key` 找目录行，行不在时给空对象
 * （未安装的插件不拿配置）。
 */
export function hubConfigOf(
  catalog: readonly CatalogEntry[],
  runtime: PluginRuntimeState,
  kind: PluginKind,
): (entry: { key: string }) => Record<string, string | number | boolean> {
  return (entry) => {
    const found = catalog.find((item) => item.kind === kind && item.id === entry.key)
    return found === undefined ? {} : configOf(found, runtime)
  }
}

/**
 * 通道 / 来源 hub 的启用判断：按 `kind + key` 找目录行，行不在时视为启用
 * （内置注册表的默认值；外部插件行不在说明没装，hub 也不会启它）。
 */
export function hubEnabledOf(
  catalog: readonly CatalogEntry[],
  runtime: PluginRuntimeState,
  kind: PluginKind,
): (entry: { key: string }) => boolean {
  return (entry) => {
    const found = catalog.find((item) => item.kind === kind && item.id === entry.key)
    return found === undefined ? true : enabledOf(found, runtime)
  }
}

export interface PluginViewsOptions {
  catalog: readonly CatalogEntry[]
  rejections: readonly ExternalPluginRejection[]
  runtime: PluginRuntimeState
  /** 来源 hub 的运行状态（只看 `state==='error'`） */
  sourceStatuses: readonly SourceStatus[]
}

/**
 * 宿主视图 `plugins.all`：磁盘发现的插件目录 + 当前设置 + 运行状态。
 * secret 只回键名；`manifest_error` 行来自用户目录扫描与被合并阶段拒绝的项。
 */
export function pluginViewsOf(options: PluginViewsOptions): PluginView[] {
  const { catalog, rejections, runtime, sourceStatuses } = options
  const views: PluginView[] = catalog.map((entry) => {
    const setting = runtime.settingOf(entry.id)
    const declared = declaredOf(entry)
    const granted = grantedOf(entry, runtime)
    const enabled = enabledOf(entry, runtime)
    let status: PluginStatus = 'disabled'
    let error: string | null = null
    if (enabled) status = 'ready'
    else if (!entry.builtin && !authorizedOf(entry, runtime)) status = 'unauthorized'
    if (entry.kind === 'source' && enabled) {
      const runtimeStatus = sourceStatuses.find((item) => item.key === entry.id)
      if (runtimeStatus?.state === 'error') {
        status = 'error'
        error = runtimeStatus.error
      }
    }
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.manifest.name,
      version: entry.manifest.version,
      description: entry.manifest.description ?? '',
      builtin: entry.builtin,
      enabled,
      declared,
      granted,
      configFields: [...(entry.manifest.config ?? [])],
      config: setting?.config ?? {},
      secretKeys: runtime.secretKeysOf(entry.id),
      status,
      error,
    }
  })
  for (const rejection of rejections) {
    views.push({
      id: rejection.id ?? rejection.path,
      kind: (PLUGIN_KINDS as readonly string[]).includes(rejection.kind ?? '')
        ? (rejection.kind as PluginKind)
        : 'source',
      name: rejection.path || '插件目录',
      version: '',
      description: '',
      builtin: false,
      enabled: false,
      declared: [],
      granted: [],
      configFields: [],
      config: {},
      secretKeys: [],
      status: 'manifest_error',
      error: rejection.detail,
    })
  }
  return views
}

/**
 * 命令路由的插件编排依赖（M7）：磁盘条目 / 视图行 / secret 写入。
 *
 * `views` 是工厂（每次命令重取，避免视图与设置行不同步）；`writeSecrets` 由装配根
 * 注入（真正落库的入口在那里）。
 */
export function pluginCommandDepsOf(options: {
  catalog: readonly CatalogEntry[]
  views: () => PluginView[]
  writeSecrets: (id: string, patch: Record<string, string | null>) => void
}): PluginCommandDeps {
  const { catalog, views } = options
  return {
    entry: (id) => {
      const found = catalog.find((item) => item.id === id)
      return found === undefined ? null : { manifest: found.manifest, builtin: found.builtin }
    },
    view: (id) => views().find((item) => item.id === id) ?? null,
    writeSecrets: options.writeSecrets,
  }
}

/** secret 存储的最小接口（`createPluginSecrets` 的实现，测试可注入假实现） */
export interface SecretStore {
  setSecret(pluginId: string, key: string, plain: string): void
  removeSecret(pluginId: string, key: string): void
}

/**
 * secret 写入（`plugin.set` 的落库入口）：`null` 表示删除，其余覆盖写。
 *
 * 失败一律转成可读错误——**错误文案只留原因前缀**，不把密文或明文带出来
 * （宿主加密不可用时应当是「拒绝写入」，而不是「明文落库」）。
 */
export function secretWriterOf(
  store: SecretStore,
): (pluginId: string, patch: Record<string, string | null>) => void {
  return (pluginId, patch) => {
    try {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) store.removeSecret(pluginId, key)
        else store.setSecret(pluginId, key, value)
      }
    } catch (error) {
      // 不把密文/明文写进错误文案；宿主加密不可用时拒绝而不是明文落库
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`无法保存插件 secret：${message.split(':')[0]}`, { cause: error })
    }
  }
}
