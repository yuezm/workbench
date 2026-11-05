/**
 * 外部插件适配层（M7）：把「子进程 + JSONL 帧」翻译成宿主认识的插件接口。
 *
 * 分工：
 * - `host/plugins/process.ts` 只管进程与帧（hello 握手、welcome 下发、崩溃重拉、停止）；
 * - 本文件把帧接到 `SourcePlugin` / `ChannelPlugin` 的上下文回调上：
 *   source 的 `event` → `ctx.emit`；channel 的 `delivered` / `answer` → 宿主回调，
 *   宿主卡片 → `card` 帧；
 * - **不做业务判断**：事件交给谁、卡片投不投、答案是否接受都由内核与 hub 决定；
 *   适配器只转发并隔离单帧失败（记日志，不让一帧异常打断进程）。
 *
 * 约束：外部插件进程只由适配器持有（一个插件一个实例）；不监听端口；config/secret 只经
 * `welcome` 帧下发（`process` 在 hello 通过后自动发，适配器不重复发）；崩溃/重启状态经
 * `onStatus` 上报，装配根据此计算 `plugins.all` 的 `status='error'`。
 */
import type { Capability } from '../../protocol/manifest'
import type { ChannelContext, ChannelPlugin } from '../../protocol/channels'
import { PLUGIN_HOST_PROTOCOL_VERSION } from '../../protocol/plugin-host'
import type { SourceContext, SourcePlugin, SpawnFn } from '../../sdk/types'
import type { ExternalPluginEntry } from './discover'
import { createExternalPluginProcess, type ExternalPluginProcessStatus } from './process'

/** 两个适配器共用的可注入项（装配根 / 测试按需覆盖）。 */
export interface ExternalAdapterOptions {
  /** 启动命令（装配根传 `process.execPath`） */
  execPath: string
  /** 子进程启动函数（测试注入假 spawn） */
  spawn: SpawnFn
  /** 用户授权后的能力（⊆ manifest.capabilities；经 welcome 下发） */
  granted: readonly Capability[]
  /** 非 secret 配置 + 已授权 secret（经 welcome 下发，不落日志） */
  config: Record<string, string | number | boolean>
  /** 宿主日志通道（process 的 log 帧已带 `[plugin:<id>]` 前缀） */
  log?: (line: string) => void
  /** 进程树终止原件（测试注入 spy） */
  killTree?: (pid: number, signal?: NodeJS.Signals) => boolean
  /** hello 超时（毫秒；缺省取 `PLUGIN_HOST_LIMITS`） */
  helloTimeoutMs?: number
  /** 崩溃重拉间隔（毫秒；缺省取 `PLUGIN_HOST_LIMITS`） */
  restartDelayMs?: number
  /** 崩溃重拉上限（次数；缺省取 `PLUGIN_HOST_LIMITS`） */
  restartMax?: number
  /** 停止时每级信号宽限（毫秒；缺省 500） */
  stopGraceMs?: number
  /** 进程状态变化（装配根用它算 plugins.all 的 error / 重启次数） */
  onStatus?: (status: ExternalPluginProcessStatus, error: string | null) => void
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const assertKind = (entry: ExternalPluginEntry, expected: ExternalPluginEntry['kind']): void => {
  if (entry.kind !== expected) {
    throw new Error(`adapter_kind_mismatch: ${entry.id} 是 ${entry.kind}，不能按 ${expected} 装载`)
  }
}

/**
 * 外部 source 插件：`event` 帧 → `ctx.emit`；其余帧（channel 专用）只记日志丢弃。
 *
 * `start` 失败时返回空 dispose（宿主按「该来源启动失败只隔离它」处理）；进程状态
 * （含 error）由 `process` 经 `onStatus` 上报，适配器不重复上报。
 */
export function createExternalSourcePlugin(
  entry: ExternalPluginEntry,
  options: ExternalAdapterOptions,
): SourcePlugin {
  assertKind(entry, 'source')
  const log = options.log ?? ((line: string): void => console.warn(line))

  return {
    async start(ctx: SourceContext): Promise<() => void> {
      if (ctx.signal.aborted) return () => undefined
      const process = createExternalPluginProcess({
        manifest: entry.manifest,
        dir: entry.dir,
        execPath: options.execPath,
        spawn: options.spawn,
        granted: options.granted,
        config: options.config,
        log: options.log,
        killTree: options.killTree,
        helloTimeoutMs: options.helloTimeoutMs,
        restartDelayMs: options.restartDelayMs,
        restartMax: options.restartMax,
        stopGraceMs: options.stopGraceMs,
        onStatusChange: options.onStatus,
        onFrame: (frame) => {
          if (frame.type !== 'event') {
            // source 不该产生 delivered/answer：不猜测语义，只记一条告警
            log(`[plugin:${entry.id}] 忽略 source 不支持的帧：${frame.type}`)
            return
          }
          try {
            ctx.emit(frame.event)
          } catch (error) {
            // 单条事件投递失败不能打断子进程：交给上层日志与下一次帧
            log(`[plugin:${entry.id}] 事件投递失败：${errMsg(error)}`)
          }
        },
      })
      const onAbort = (): void => {
        void process.stop()
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await process.start()
      } catch (error) {
        ctx.signal.removeEventListener('abort', onAbort)
        log(`[plugin:${entry.id}] 启动失败：${errMsg(error)}`)
        return () => undefined
      }
      let disposed = false
      return async () => {
        if (disposed) return
        disposed = true
        ctx.signal.removeEventListener('abort', onAbort)
        await process.stop()
      }
    },
  }
}

/**
 * 外部 channel 插件：`delivered` / `answer` 帧 → 宿主回调；宿主卡片 → `card` 帧。
 *
 * 通道只单向/双向转发，不回收答案以外的业务语义；`delivered` / `answer` 失败只记日志
 * （内核拒绝、hub 停止都不影响子进程继续收下一张卡）。
 */
export function createExternalChannelPlugin(
  entry: ExternalPluginEntry,
  options: ExternalAdapterOptions,
): ChannelPlugin {
  assertKind(entry, 'channel')
  const log = options.log ?? ((line: string): void => console.warn(line))

  return {
    async start(ctx: ChannelContext): Promise<() => void> {
      if (ctx.signal.aborted) return () => undefined
      const process = createExternalPluginProcess({
        manifest: entry.manifest,
        dir: entry.dir,
        execPath: options.execPath,
        spawn: options.spawn,
        granted: options.granted,
        config: options.config,
        log: options.log,
        killTree: options.killTree,
        helloTimeoutMs: options.helloTimeoutMs,
        restartDelayMs: options.restartDelayMs,
        restartMax: options.restartMax,
        stopGraceMs: options.stopGraceMs,
        onStatusChange: options.onStatus,
        onFrame: (frame) => {
          if (frame.type === 'delivered') {
            void ctx.delivered(frame.cardId, frame.version, frame.ref).catch((error: unknown) => {
              log(`[plugin:${entry.id}] 投递回执失败：${errMsg(error)}`)
            })
            return
          }
          if (frame.type === 'answer') {
            void ctx.answer(frame.cardId, frame.optionIndex).catch((error: unknown) => {
              log(`[plugin:${entry.id}] 答案回传失败：${errMsg(error)}`)
            })
            return
          }
          // channel 不该产生 event：只记一条告警（事件入口唯一，不能从这里绕进去）
          log(`[plugin:${entry.id}] 忽略 channel 不支持的帧：${frame.type}`)
        },
      })
      const onAbort = (): void => {
        void process.stop()
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await process.start()
      } catch (error) {
        ctx.signal.removeEventListener('abort', onAbort)
        log(`[plugin:${entry.id}] 启动失败：${errMsg(error)}`)
        return () => undefined
      }
      const unsubscribe = ctx.onCard((card) => {
        if (!process.send({ v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'card', card })) {
          log(`[plugin:${entry.id}] 卡片帧未送达（子进程未就绪）`)
        }
      })
      let disposed = false
      return async () => {
        if (disposed) return
        disposed = true
        unsubscribe()
        ctx.signal.removeEventListener('abort', onAbort)
        await process.stop()
      }
    },
  }
}
