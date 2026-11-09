/**
 * 内置插件注册表（M3/M4）：唯一的静态导入点，按固定顺序列出内置执行器与通道。
 *
 * 依赖方向：`registry → 具体插件 + sdk/protocol 类型`；宿主只经本文件取插件，
 * 不直接 import `executors/**` / `channels/**`（ESLint 强制）。新增执行器协议 =
 * 新增 `src/plugins/executors/<id>/` + 本文件 `executors` 一行；新增通道 =
 * 新增 `src/plugins/channels/<id>/` + 本文件 `channels` 一行。
 *
 * `executors` 的数组顺序即 UI 下拉与 `detect()` 的输出顺序；
 * `channels` 的数组顺序即卡片投递顺序（in-app 在前、desktop 在后）。
 */
import type { PluginManifest } from '../protocol/manifest'
import type { ChannelPlugin } from '../protocol/channels'
import type { DetectedRuntime } from '../protocol/entities'
import type { ExecutorPlugin, SdkHost, SourcePlugin } from '../sdk/types'
import { createSdk } from '../sdk'
import { desktopChannel, desktopManifest } from './channels/desktop'
import { inAppChannel, inAppManifest } from './channels/in-app'
import { webhookChannel, webhookChannelManifest } from './channels/webhook-channel'
import { claudePlugin } from './executors/claude'
import { claudeManifest } from './executors/claude/manifest'
import { commandPlugin } from './executors/command'
import { commandManifest } from './executors/command/manifest'
import { dshPlugin } from './executors/dsh'
import { dshManifest } from './executors/dsh/manifest'
import { hermesPlugin } from './executors/hermes'
import { hermesManifest } from './executors/hermes/manifest'
import { createRemoteExecutor } from './executors/remote'
import { remoteManifest } from './executors/remote/manifest'
import { webhookManifest, webhookSource } from './sources/webhook'
import { CLI_CANDIDATES } from './shared/cli-catalog'

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
  {
    // Claude Code：`--print --output-format stream-json` 逐行 JSON；提示词走 stdin
    key: claudeManifest.id,
    label: claudeManifest.name,
    manifest: claudeManifest,
    plugin: claudePlugin,
  },
  {
    // Hermes Agent：`hermes acp`（ACP / JSON-RPC 2.0 over stdio），有审批往返
    key: hermesManifest.id,
    label: hermesManifest.name,
    manifest: hermesManifest,
    plugin: hermesPlugin,
  },
  {
    key: commandManifest.id,
    label: commandManifest.name,
    manifest: commandManifest,
    plugin: commandPlugin,
  },
  {
    // M7 架构位：无传输时回执 runtime_missing（不 spawn、不连网）
    key: remoteManifest.id,
    label: remoteManifest.name,
    manifest: remoteManifest,
    plugin: createRemoteExecutor(null),
  },
]

/** 按 key 取执行器注册项；未知 key 抛可读错误（调用方决定兜底终态） */
export function executorById(key: string): ExecutorRegistryEntry {
  const found = executors.find((entry) => entry.key === key)
  if (found === undefined) throw new Error(`执行器插件未注册: ${key}`)
  return found
}

/** 一条通道注册项（SPEC-plugins「channel」）：key = manifest.id，写进 `card.delivered.ref`。 */
export interface ChannelRegistryEntry {
  key: string
  label: string
  manifest: PluginManifest
  plugin: ChannelPlugin
}

/**
 * 内置通道清单（M4）：数组顺序即投递顺序（in-app 在前、desktop 在后）。
 * 宿主只经本清单启停，不直接 import 具体通道插件。
 */
export const channels: ReadonlyArray<ChannelRegistryEntry> = [
  {
    key: inAppManifest.id,
    label: inAppManifest.name,
    manifest: inAppManifest,
    plugin: inAppChannel,
  },
  {
    key: desktopManifest.id,
    label: desktopManifest.name,
    manifest: desktopManifest,
    plugin: desktopChannel,
  },
  {
    // M7：出站 webhook（未配置 url 时插件自己 no-op，不投递）
    key: webhookChannelManifest.id,
    label: webhookChannelManifest.name,
    manifest: webhookChannelManifest,
    plugin: webhookChannel,
  },
]

/** 按 key 取通道注册项；未知 key 抛可读错误（装配根据此不启动未知通道）。 */
export function channelById(key: string): ChannelRegistryEntry {
  const found = channels.find((entry) => entry.key === key)
  if (found === undefined) throw new Error(`通道插件未注册: ${key}`)
  return found
}

/** 一条来源注册项（SPEC-plugins「source」）：key = manifest.id。 */
export interface SourceRegistryEntry {
  key: string
  label: string
  manifest: PluginManifest
  plugin: SourcePlugin
}

/**
 * 内置来源清单（M7）：数组顺序即启动顺序。宿主只经本清单启停，
 * 不直接 import 具体来源插件。
 */
export const sources: ReadonlyArray<SourceRegistryEntry> = [
  {
    key: webhookManifest.id,
    label: webhookManifest.name,
    manifest: webhookManifest,
    plugin: webhookSource,
  },
]

/** 按 key 取来源注册项；未知 key 抛可读错误。 */
export function sourceById(key: string): SourceRegistryEntry {
  const found = sources.find((entry) => entry.key === key)
  if (found === undefined) throw new Error(`来源插件未注册: ${key}`)
  return found
}

/** 单插件 detect 的超时（D8：单个插件失败/卡住不拖垮整体） */
const DETECT_TIMEOUT_MS = 2_000

export interface DetectOptions {
  /** 单插件超时；测试注入更短的值，生产取 2 s */
  timeoutMs?: number
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 给一个 promise 加超时；`task` 未被选中时其后续拒绝由 race 内部处理器消化。
 *
 * 导出到模块级：定时器句柄缺失（`setTimeout` 未返回句柄）这条防御分支在正常运行时
 * 不可达，导出后由单测直接构造输入覆盖（逻辑与调用点均不变）。
 */
export function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expires = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`检测超时（>${timeoutMs}ms）`)), timeoutMs)
  })
  return Promise.race([task, expires]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * 汇总本机可接入的运行时（D8）：
 *
 * 1. 按 registry 顺序**串行**调用各插件 `detect()`；单插件 2 s 超时、抛错只跳过该插件
 *    （记日志、整体不抛）；同一 `command` 被多个插件声明时按顺序先到先得并 warn。
 * 2. 未注册插件的 CLI（`cli-catalog` 里装了但没插件认领）仍以 `supported:false` 出现，
 *    保持 UI 三态（已添加 / 已接入 / 未注册）行为不变。
 * 3. 输出按候选清单顺序稳定排列；不读业务数据、不写库、不发 changed。
 */
export async function detectAll(
  sdkHost: SdkHost,
  options: DetectOptions = {},
): Promise<DetectedRuntime[]> {
  return await detectAllWith(executors, sdkHost, options)
}

/**
 * 同一汇总逻辑的可注入版本：装配根用内置 `executors`，测试用它验证空注册表 /
 * 顺序 / 去重 / 失败隔离（不把测试夹具塞进内置清单）。
 */
export async function detectAllWith(
  entries: readonly ExecutorRegistryEntry[],
  sdkHost: SdkHost,
  options: DetectOptions = {},
): Promise<DetectedRuntime[]> {
  // 没有执行器插件时没有「可接入」语义：直接返回空数组（caller 的 UI 走空态）。
  if (entries.length === 0) return []

  const timeoutMs = options.timeoutMs ?? DETECT_TIMEOUT_MS
  const claimed = new Set<string>()
  const collected: DetectedRuntime[] = []

  for (const entry of entries) {
    const detect = entry.plugin.detect
    if (detect === undefined) continue
    try {
      const sdk = createSdk(sdkHost, entry.manifest)
      const hits = await withTimeout(Promise.resolve(detect({ sdk })), timeoutMs)
      for (const hit of hits) {
        const command = hit.command.trim()
        if (command.length === 0) continue
        if (claimed.has(command)) {
          sdkHost.log(
            `[detect] 执行器 ${entry.key} 重复声明命令「${command}」，按注册表顺序先到先得，已跳过`,
          )
          continue
        }
        claimed.add(command)
        collected.push({ ...hit, command, executorKey: entry.key, supported: true })
      }
    } catch (error) {
      sdkHost.log(`[detect] 执行器插件 ${entry.key} 检测失败，已跳过：${errMsg(error)}`)
    }
  }

  // 未注册插件的 CLI：仍扫描候选清单，让用户知道本机装了什么（不可接入 → supported:false）
  const dirs = sdkHost.process.scanDirs()
  for (const candidate of CLI_CANDIDATES) {
    if (claimed.has(candidate.command)) continue
    const path = sdkHost.process.findInDirs(candidate.command, dirs)
    if (path === null) continue
    collected.push({
      command: candidate.command,
      label: candidate.label,
      path,
      executorKey: '',
      supported: false,
    })
  }

  // 稳定顺序：候选清单顺序（未在清单里的插件命中排最后，保持相对顺序）
  const order = new Map(CLI_CANDIDATES.map((candidate, index) => [candidate.command, index]))
  const tail = CLI_CANDIDATES.length
  return collected.sort(
    (left, right) => (order.get(left.command) ?? tail) - (order.get(right.command) ?? tail),
  )
}
