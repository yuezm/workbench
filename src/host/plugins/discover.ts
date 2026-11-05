/**
 * 外部插件发现（M7 D1）：扫描 `<pluginsRoot>/<kind>/<id>/` 下的 `manifest.json` + `plugin.mjs`。
 *
 * 只做**纯数据**产出（entries / rejections / missingRoot），不 spawn、不写库、不合并运行状态：
 * - manifest 形状与 kind 是否在 M7 开放范围内由 `protocol/plugin-host.ts` 的
 *   `parseExternalManifest` 判定（同一口径不在这里复刻）；
 * - 本文件补目录层面的判定：入口文件是否存在、目录名与 `manifest.id` 是否一致、
 *   id 是否与内置或另一个用户插件冲突；
 * - 同 `kind+id` 与内置重复时**用户目录优先**（`overridesBuiltin=true`），不静默丢弃：
 *   是否覆盖由清单合并方（`host/plugins/catalog`）决定；
 * - 非法 manifest **不静默降级**：不装载、给出 `reason` 与 `detail`，供视图 `plugins.all`
 *   展示（`status='manifest_error'`）。
 *
 * 目录不存在是正常状态（用户从没装过外部插件）：`missingRoot=true`，不抛错。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PluginKind, PluginManifest } from '../../protocol/manifest'
import {
  EXTERNAL_PLUGIN_ENTRY,
  EXTERNAL_PLUGIN_KINDS,
  EXTERNAL_PLUGIN_MANIFEST,
  parseExternalManifest,
  type ExternalPluginKind,
  type ManifestRejectReason,
} from '../../protocol/plugin-host'

/** 内置插件引用（只用于判重：用户目录同 kind+id 覆盖内置）。 */
export interface BuiltinPluginRef {
  kind: PluginKind
  id: string
}

export interface DiscoverExternalPluginsOptions {
  /** 用户插件根目录（装配根传 `app.getPath('userData')/plugins`） */
  pluginsRoot: string
  /** 内置插件清单；缺省视为空（测试/首次启动） */
  builtins?: readonly BuiltinPluginRef[]
}

/** 一个可装载的外部插件（manifest 合法且入口存在）。 */
export interface ExternalPluginEntry {
  kind: ExternalPluginKind
  id: string
  manifest: PluginManifest
  /** 插件目录绝对路径（子进程 cwd） */
  dir: string
  /** 入口文件绝对路径 */
  entry: string
  /** true = 与内置同 kind+id（用户目录优先，由清单合并方决定是否替换内置行） */
  overridesBuiltin: boolean
}

/** 一个被拒绝的目录：`detail` 直接展示给用户（不含插件输出内容）。 */
export interface ExternalPluginRejection {
  /** 相对 pluginsRoot 的 posix 路径，例如 `source/webhook` */
  path: string
  /** 目录名推断的类别；未知目录为 null */
  kind: string | null
  /** 目录名推断的 id；未知为 null */
  id: string | null
  reason: ManifestRejectReason
  detail: string
}

export interface DiscoverExternalPluginsResult {
  entries: ExternalPluginEntry[]
  rejections: ExternalPluginRejection[]
  /** 用户插件根目录不存在（首次启动 / 用户从没装过） */
  missingRoot: boolean
}

const isExternalKind = (value: string): value is ExternalPluginKind =>
  (EXTERNAL_PLUGIN_KINDS as readonly string[]).includes(value)

const byName = (a: string, b: string): number => a.localeCompare(b)

/** 读取一个目录项集合（不存在/不可读返回 null，由调用方决定降级口径）。 */
async function readDirs(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byName)
  } catch {
    // 目录不存在或不可读：按「没有可装载项」降级（根目录的可读性由调用方判定）
    return null
  }
}

/** 入口文件必须存在且是普通文件。 */
async function entryExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    // 文件不存在 / 不可访问：按入口缺失处理
    return false
  }
}

/** 读取并解析 manifest.json；失败返回带原因的拒绝项。 */
async function readManifest(
  manifestPath: string,
  dirName: string,
  kindDir: string,
): Promise<
  | { ok: true; manifest: PluginManifest }
  | { ok: false; rejection: Omit<ExternalPluginRejection, 'path'> }
> {
  let text: string
  try {
    text = await readFile(manifestPath, 'utf8')
  } catch {
    return {
      ok: false,
      rejection: {
        kind: kindDir,
        id: dirName,
        reason: 'manifest_invalid',
        detail: `缺少 ${EXTERNAL_PLUGIN_MANIFEST}`,
      },
    }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      rejection: {
        kind: kindDir,
        id: dirName,
        reason: 'manifest_invalid',
        detail: `${EXTERNAL_PLUGIN_MANIFEST} 不是合法 JSON：${String(error)}`,
      },
    }
  }
  const parsed = parseExternalManifest(value)
  if (!parsed.ok) {
    return {
      ok: false,
      rejection: { kind: kindDir, id: dirName, reason: parsed.reason, detail: parsed.detail },
    }
  }
  if (parsed.manifest.id !== dirName) {
    return {
      ok: false,
      rejection: {
        kind: kindDir,
        id: dirName,
        reason: 'manifest_invalid',
        detail: `目录名与 manifest.id 不一致（目录 ${dirName}，manifest ${parsed.manifest.id}）`,
      },
    }
  }
  if (parsed.manifest.kind !== kindDir) {
    return {
      ok: false,
      rejection: {
        kind: kindDir,
        id: dirName,
        reason: 'manifest_invalid',
        detail: `目录类别与 manifest.kind 不一致（目录 ${kindDir}，manifest ${parsed.manifest.kind}）`,
      },
    }
  }
  return { ok: true, manifest: parsed.manifest }
}

/**
 * 扫描用户插件目录。
 *
 * 返回顺序稳定（kind 目录、插件目录均按名字排序），便于视图与测试逐行比对。
 */
export async function discoverExternalPlugins(
  options: DiscoverExternalPluginsOptions,
): Promise<DiscoverExternalPluginsResult> {
  const { pluginsRoot } = options
  const builtins = options.builtins ?? []

  // 根目录不存在：首次启动的正常状态；存在但不是目录也按缺失处理
  const rootStat = await stat(pluginsRoot).catch(() => null)
  if (rootStat === null || !rootStat.isDirectory()) {
    return { entries: [], rejections: [], missingRoot: true }
  }

  let kindDirs: string[]
  try {
    const entries = await readdir(pluginsRoot, { withFileTypes: true })
    kindDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byName)
  } catch (error) {
    // 根目录存在但不可读：不静默当成「没装插件」，给出可展示的拒绝原因
    return {
      entries: [],
      rejections: [
        {
          path: '',
          kind: null,
          id: null,
          reason: 'manifest_invalid',
          detail: `插件目录不可读：${String(error)}`,
        },
      ],
      missingRoot: false,
    }
  }

  const entries: ExternalPluginEntry[] = []
  const rejections: ExternalPluginRejection[] = []
  /** 已接受的 id → kind（插件 id 全局唯一，跨 kind 同 id 视为冲突） */
  const acceptedIds = new Map<string, ExternalPluginKind>()
  const builtinKindById = new Map<string, PluginKind>()
  for (const builtin of builtins) builtinKindById.set(builtin.id, builtin.kind)
  const builtinKeys = new Set(builtins.map((builtin) => `${builtin.kind}:${builtin.id}`))

  for (const kindDir of kindDirs) {
    const kindPath = path.join(pluginsRoot, kindDir)
    const pluginDirs = await readDirs(kindPath)
    if (pluginDirs === null) {
      rejections.push({
        path: kindDir,
        kind: isExternalKind(kindDir) ? kindDir : null,
        id: null,
        reason: 'manifest_invalid',
        detail: `插件类别目录不可读：${kindDir}`,
      })
      continue
    }
    for (const dirName of pluginDirs) {
      const relativePath = `${kindDir}/${dirName}`
      const dir = path.join(kindPath, dirName)

      // 非 M7 开放的类别：不读 manifest，直接给出不支持原因（避免执行未知形状的文件）
      if (!isExternalKind(kindDir)) {
        rejections.push({
          path: relativePath,
          kind: kindDir,
          id: dirName,
          reason: 'kind_unsupported',
          detail: `M7 不开放外部 ${kindDir} 插件`,
        })
        continue
      }

      const manifestPath = path.join(dir, EXTERNAL_PLUGIN_MANIFEST)
      const parsed = await readManifest(manifestPath, dirName, kindDir)
      if (!parsed.ok) {
        rejections.push({ path: relativePath, ...parsed.rejection })
        continue
      }
      const { manifest } = parsed
      const entryPath = path.join(dir, EXTERNAL_PLUGIN_ENTRY)
      if (!(await entryExists(entryPath))) {
        rejections.push({
          path: relativePath,
          kind: kindDir,
          id: manifest.id,
          reason: 'entry_missing',
          detail: `缺少入口文件 ${EXTERNAL_PLUGIN_ENTRY}`,
        })
        continue
      }

      // 插件 id 全局唯一：跨 kind 与内置或其他用户插件同 id 一律拒绝（避免视图/命令二义）
      const acceptedKind = acceptedIds.get(manifest.id)
      if (acceptedKind !== undefined) {
        rejections.push({
          path: relativePath,
          kind: kindDir,
          id: manifest.id,
          reason: 'duplicate_id',
          detail: `插件 id 与已装载的 ${acceptedKind} 插件重复：${manifest.id}`,
        })
        continue
      }
      const builtinKind = builtinKindById.get(manifest.id)
      if (builtinKind !== undefined && builtinKind !== manifest.kind) {
        rejections.push({
          path: relativePath,
          kind: kindDir,
          id: manifest.id,
          reason: 'duplicate_id',
          detail: `插件 id 与内置 ${builtinKind} 插件重复：${manifest.id}`,
        })
        continue
      }

      acceptedIds.set(manifest.id, manifest.kind as ExternalPluginKind)
      entries.push({
        kind: manifest.kind as ExternalPluginKind,
        id: manifest.id,
        manifest,
        dir,
        entry: entryPath,
        // 同 kind+id 与内置重复：用户目录优先（覆盖内置行），不是错误
        overridesBuiltin: builtinKeys.has(`${manifest.kind}:${manifest.id}`),
      })
    }
  }

  return { entries, rejections, missingRoot: false }
}
