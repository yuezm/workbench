/**
 * source 宿主 hub（M7 D8）：启停来源插件，把外部事件送进唯一事件入口。
 *
 * 职责边界：
 * - **只启动/停止、只转发事件**：来源插件只决定「事情是什么」，派活、建任务仍由内核按
 *   规则与阶段决定；hub 不读业务数据、不写投影；
 * - **唯一事件入口不变**：`context.emit(event)` → `effects.dispatch({type:'event.received',
 *   event, hops:1, originRunId:null})`；同步转发，异常自捕获，绝不影响插件回调；
 * - **失败隔离**：单条来源 `start` 失败只隔离该来源（状态记 `error`、日志带原因），
 *   其余来源照常启动；未启用的来源跳过并记状态 `disabled`；
 * - **启停**：`startAll` 建 AbortController 并逐条 `start`；`stopAll` 先 abort 再
 *   best-effort dispose，可重复调用；退出流程先停 sources 再停 channels（SPEC-host）；
 * - 来源配置经 `configOf(entry)` 注入每条来源的 `sdk.config()`（插件拿不到别人的配置）。
 */
import type { RawEvent } from '../protocol/inputs'
import type { PluginManifest } from '../protocol/manifest'
import type { SdkHost, SourceContext, SourcePlugin } from '../sdk/types'
import type { DispatchResult } from './store/index'
import { createSdk } from '../sdk'

/**
 * 一条来源注册项（与 `plugins/registry` 的 `SourceRegistryEntry` 结构兼容）：
 * host 不 import 具体插件，装配根从注册表注入。
 */
export interface SourceRegistryEntry {
  /** 来源键，等于 `manifest.id` */
  key: string
  /** 展示名（设置页/日志用） */
  label: string
  manifest: PluginManifest
  plugin: SourcePlugin
}

/** hub 只需要的写入口（装配根注入 `effects.dispatch`，事实仍由内核决定）。 */
export interface SourcesEffects {
  dispatch(input: unknown): DispatchResult
}

/** 单条来源的启停状态（`plugins.all` / 设置页可读；`error` 带失败原因）。 */
export const SOURCE_STATES = ['idle', 'running', 'disabled', 'error'] as const

export type SourceState = (typeof SOURCE_STATES)[number]

export interface SourceStatus {
  key: string
  state: SourceState
  /** 启动失败原因；正常为 null */
  error: string | null
}

export interface SourcesOptions {
  /** 来源清单（内置 + 外部；顺序即启动顺序，装配根从注册表注入） */
  entries: readonly SourceRegistryEntry[]
  /** 来源 sdk 的宿主原件；能力门控（net 等）由 `createSdk` 按 manifest 做 */
  sdkHost: SdkHost
  /** 事件入口：装配根注入 `effects.dispatch`（→ decide → 事实） */
  effects: SourcesEffects
  /** 单条来源的配置（按插件设置合并后的非 secret 配置；secret 由宿主按授权注入） */
  configOf(entry: SourceRegistryEntry): Record<string, unknown>
  /** 是否启用：未启用不启动（状态记 `disabled`），配置与授权由装配根决定 */
  isEnabled(entry: SourceRegistryEntry): boolean
  /** 日志落点；缺省用 `sdkHost.log` */
  log?(line: string): void
}

export interface Sources {
  startAll(): Promise<void>
  stopAll(): Promise<void>
  /** 按注册表顺序返回各来源状态（启动前为 `idle`） */
  statuses(): readonly SourceStatus[]
}

interface SourceRuntime {
  entry: SourceRegistryEntry
  abort: AbortController
  dispose: (() => void) | null
  state: SourceState
  error: string | null
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createSources(options: SourcesOptions): Sources {
  const { entries, sdkHost, effects, configOf, isEnabled } = options

  const runtimes = new Map<string, SourceRuntime>()
  const statusMap = new Map<string, SourceStatus>()
  let started = false
  let stopping = false

  const log = (line: string): void => {
    const write = options.log ?? sdkHost.log
    try {
      write(`[sources] ${line}`)
    } catch {
      // 日志失败不影响来源启停与事件转发
    }
  }

  const setStatus = (key: string, state: SourceState, error: string | null): void => {
    statusMap.set(key, { key, state, error })
  }

  /**
   * 事件入口：同步转成 `event.received` 输入；来源停止后到达的事件丢弃并记日志，
   * `effects.dispatch` 抛错只记日志（外部事件不能反向打断插件）。
   */
  const emitEvent = (runtime: SourceRuntime, event: RawEvent): void => {
    if (runtime.state !== 'running') {
      log(`来源 ${runtime.entry.key} 已停止，丢弃事件（source=${event.source}）`)
      return
    }
    try {
      effects.dispatch({ type: 'event.received', event, hops: 1, originRunId: null })
    } catch (error) {
      log(`来源 ${runtime.entry.key} 事件入账失败（已忽略）：${errMsg(error)}`)
    }
  }

  const startOne = async (entry: SourceRegistryEntry): Promise<void> => {
    const runtime: SourceRuntime = {
      entry,
      abort: new AbortController(),
      dispose: null,
      state: 'running',
      error: null,
    }
    runtimes.set(entry.key, runtime)
    // 每条来源只拿到自己的配置：能力面门控仍由 createSdk 按 manifest 做
    const entrySdkHost: SdkHost = {
      ...sdkHost,
      config: <T = Record<string, unknown>>() => configOf(entry) as T,
    }
    const context: SourceContext = {
      sdk: createSdk(entrySdkHost, entry.manifest),
      emit: (event) => emitEvent(runtime, event),
      signal: runtime.abort.signal,
    }
    try {
      const dispose = await entry.plugin.start(context)
      if (typeof dispose !== 'function') {
        throw new Error('start 未返回 dispose 函数')
      }
      runtime.dispose = dispose
      setStatus(entry.key, 'running', null)
    } catch (error) {
      // 单个来源启动失败只隔离它：abort 掉它自己的信号，其余来源照常启动
      runtime.state = 'error'
      runtime.error = errMsg(error)
      runtime.abort.abort()
      runtimes.delete(entry.key)
      setStatus(entry.key, 'error', errMsg(error))
      log(`来源 ${entry.key} 启动失败，已隔离：${errMsg(error)}`)
    }
  }

  const startAll = async (): Promise<void> => {
    if (started || stopping) return
    started = true
    for (const entry of entries) {
      if (!isEnabled(entry)) {
        setStatus(entry.key, 'disabled', null)
        log(`来源 ${entry.key} 未启用，已跳过`)
        continue
      }
      await startOne(entry)
    }
  }

  const stopAll = async (): Promise<void> => {
    if (!started && runtimes.size === 0) return
    stopping = true
    started = false
    const toStop = [...runtimes.values()]
    runtimes.clear()
    // 先 abort 全部来源（插件据此停掉自己的回调），再逐个 dispose（best-effort）
    for (const runtime of toStop) {
      runtime.state = 'idle'
      runtime.abort.abort()
    }
    for (const runtime of toStop) {
      try {
        await runtime.dispose?.()
      } catch (error) {
        log(`来源 ${runtime.entry.key} dispose 失败（已忽略）：${errMsg(error)}`)
      }
      setStatus(runtime.entry.key, 'idle', null)
    }
    stopping = false
  }

  return {
    startAll,
    stopAll,
    statuses: () =>
      entries.map(
        (entry) => statusMap.get(entry.key) ?? { key: entry.key, state: 'idle', error: null },
      ),
  }
}
