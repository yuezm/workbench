/**
 * 外部插件子进程宿主（M7 D2）：`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑 `plugin.mjs`，
 * stdio 走 JSONL 帧（`protocol/plugin-host.ts` 编解码）。
 *
 * 职责边界：
 * - **只做进程与帧**：能力授权、config/secret 由调用方算好后经 `welcome` 帧下发（secret 只走
 *   管道，不进命令行、不进日志）；事件/卡片语义由上层 hub 处理（`onFrame` 回调）。
 * - **失败可恢复**：hello 超时（默认 5 s）或非正常退出按崩溃处理，最多重拉 3 次（间隔 1 s），
 *   超过上限 `status='error'`；`hello` 自报身份与 manifest 不一致是协议违规，直接终止不重拉。
 * - **单帧上限**：超长输出行在行缓冲层丢弃（不无限积累内存），非法帧只记一条告警。
 * - **停止先礼后兵**：`shutdown` 帧 → 宽限等待 → SIGTERM → 宽限 → `killTree`；
 *   `stop()` / `dispose()` 都幂等，停止后不再重拉。
 *
 * 测试注入假 `spawn`（假流 + 假进程），不真起进程；`killTree` 与各超时同样可注入。
 */
import type { Capability, PluginManifest } from '../../protocol/manifest'
import {
  EXTERNAL_PLUGIN_ENTRY,
  PLUGIN_HOST_LIMITS,
  PLUGIN_HOST_PROTOCOL_VERSION,
  encodePluginFrame,
  parsePluginFrame,
  type HostToPluginFrame,
  type PluginToHostFrame,
} from '../../protocol/plugin-host'
import type { Spawned, SpawnFn } from '../../sdk/types'
import { killProcessTree, tail } from '../process'
import { PLUGIN_RUN_AS_NODE, buildPluginEnv } from './env'

/** 外部插件子进程的生命周期状态（与 `PluginStatus` 的 `error` / `ready` 口径对齐）。 */
export const EXTERNAL_PLUGIN_PROCESS_STATUSES = [
  'idle',
  'starting',
  'ready',
  'error',
  'stopped',
] as const

export type ExternalPluginProcessStatus = (typeof EXTERNAL_PLUGIN_PROCESS_STATUSES)[number]

export interface ExternalPluginProcessOptions {
  /** 磁盘 manifest（hello 自报身份逐字段与它比对） */
  manifest: PluginManifest
  /** 插件目录（manifest.json / plugin.mjs 所在，子进程 cwd） */
  dir: string
  /** 启动命令；装配根传 `process.execPath`（测试注入假命令） */
  execPath: string
  /** 子进程启动函数（测试注入假 spawn） */
  spawn: SpawnFn
  /** 授权后的能力（缺省 = manifest.capabilities；`welcome` 帧下发） */
  granted?: readonly Capability[]
  /** `welcome` 下发的 config（非 secret + 已授权 secret；不落日志） */
  config?: Record<string, string | number | boolean>
  /** 子进程环境；缺省 `buildPluginEnv()`（白名单 + `ELECTRON_RUN_AS_NODE=1`） */
  env?: NodeJS.ProcessEnv
  /** 宿主日志通道（插件 log 帧与 stderr 都经这里；不含 secret） */
  log?: (line: string) => void
  /** hello 之后的非 log 帧（event / delivered / answer 由上层 hub 消费） */
  onFrame?: (frame: PluginToHostFrame) => void
  /** 状态变化（上层据此更新视图与补投） */
  onStatusChange?: (status: ExternalPluginProcessStatus, error: string | null) => void
  /** hello 超时（毫秒）；缺省 `PLUGIN_HOST_LIMITS.helloTimeoutMs` */
  helloTimeoutMs?: number
  /** 崩溃重拉间隔（毫秒）；缺省 `PLUGIN_HOST_LIMITS.restartDelayMs` */
  restartDelayMs?: number
  /** 崩溃重拉上限（次数）；缺省 `PLUGIN_HOST_LIMITS.restartMax` */
  restartMax?: number
  /** 停止时每级信号的宽限（毫秒）；缺省 500 */
  stopGraceMs?: number
  /** 进程树终止原件（测试注入 spy）；缺省 `host/process.ts` 的 `killProcessTree` */
  killTree?: (pid: number, signal?: NodeJS.Signals) => boolean
}

export interface ExternalPluginProcess {
  /** 启动并等到 hello；首次就绪前失败（含重拉耗尽）reject */
  start(): Promise<void>
  /** 优雅停止：shutdown → SIGTERM → killTree；幂等 */
  stop(): Promise<void>
  /** 停止并标记释放（之后 `start()` 直接 reject） */
  dispose(): Promise<void>
  /** 发送宿主 → 插件帧；未就绪返回 false（不抛） */
  send(frame: HostToPluginFrame): boolean
  status(): ExternalPluginProcessStatus
  /** 最近一次错误文案（不含 secret / 插件输出正文） */
  lastError(): string | null
}

/** 停止时每级信号的默认宽限（毫秒）。 */
const DEFAULT_STOP_GRACE_MS = 500

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const sameCapabilities = (left: readonly Capability[], right: readonly Capability[]): boolean =>
  left.length === right.length &&
  left.every((capability) => right.includes(capability)) &&
  right.every((capability) => left.includes(capability))

/**
 * 带上限的行读取器：单行超过 `maxBytes` 时丢弃整行并回调一次 `onOverflow`
 * （避免插件用无换行的巨量输出撑爆宿主内存）。
 */
function createCappedLineReader(
  onLine: (line: string) => void,
  maxBytes: number,
  onOverflow: () => void,
): { push(chunk: string): void; flush(): void } {
  let buffer = ''
  /** 当前行已超限：丢弃到下一个换行为止 */
  let skipping = false
  return {
    push(chunk: string): void {
      let remaining = chunk
      while (remaining.length > 0) {
        const newline = remaining.indexOf('\n')
        if (skipping) {
          if (newline < 0) return
          remaining = remaining.slice(newline + 1)
          skipping = false
          continue
        }
        if (newline < 0) {
          buffer += remaining
          if (buffer.length > maxBytes) {
            buffer = ''
            skipping = true
            onOverflow()
          }
          return
        }
        const segment = remaining.slice(0, newline)
        remaining = remaining.slice(newline + 1)
        if (buffer.length + segment.length > maxBytes) {
          buffer = ''
          onOverflow()
          continue
        }
        const line = (buffer + segment).replace(/\r$/, '')
        buffer = ''
        if (line.trim().length > 0) onLine(line)
      }
    },
    flush(): void {
      const rest = buffer.replace(/\r$/, '').trim()
      buffer = ''
      skipping = false
      if (rest.length > 0) onLine(rest)
    },
  }
}

export function createExternalPluginProcess(
  options: ExternalPluginProcessOptions,
): ExternalPluginProcess {
  const { manifest } = options
  const log = options.log ?? ((line: string): void => console.warn(line))
  const helloTimeoutMs = options.helloTimeoutMs ?? PLUGIN_HOST_LIMITS.helloTimeoutMs
  const restartDelayMs = options.restartDelayMs ?? PLUGIN_HOST_LIMITS.restartDelayMs
  const restartMax = options.restartMax ?? PLUGIN_HOST_LIMITS.restartMax
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const killTree = options.killTree ?? ((pid, signal) => killProcessTree(pid, signal))
  const granted = [...(options.granted ?? manifest.capabilities)]
  const config = options.config ?? {}
  // 环境白名单在创建时算一次：装配根传入自定义环境时也只补 ELECTRON_RUN_AS_NODE
  const env: NodeJS.ProcessEnv = { ...(options.env ?? buildPluginEnv()), [PLUGIN_RUN_AS_NODE]: '1' }

  let status: ExternalPluginProcessStatus = 'idle'
  let lastError: string | null = null
  let child: Spawned | null = null
  /** 每次 spawn 自增：迟到的流事件 / close 事件按代际丢弃 */
  let generation = 0
  let restarts = 0
  let stopping = false
  let disposed = false
  let startPromise: Promise<void> | null = null
  let resolveStart: (() => void) | null = null
  let rejectStart: ((error: Error) => void) | null = null
  let helloTimer: ReturnType<typeof setTimeout> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  const closeWaiters: Array<() => void> = []

  const setStatus = (next: ExternalPluginProcessStatus, error: string | null): void => {
    status = next
    lastError = error
    try {
      options.onStatusChange?.(next, error)
    } catch (callbackError) {
      // 上层回调异常不能打断进程状态机
      log(`[plugin:${manifest.id}] 状态回调失败：${errMsg(callbackError)}`)
    }
  }

  const settleStart = (error: Error | null): void => {
    const resolve = resolveStart
    const reject = rejectStart
    resolveStart = null
    rejectStart = null
    startPromise = null
    if (error === null) resolve?.()
    else reject?.(error)
  }

  const clearHelloTimer = (): void => {
    if (helloTimer === null) return
    clearTimeout(helloTimer)
    helloTimer = null
  }

  const resolveCloseWaiters = (): void => {
    const waiters = closeWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  /** 终止当前子进程（整树优先；没有 pid 时退回单进程 SIGKILL）。 */
  const killRunning = (running: Spawned): void => {
    const pid = running.pid
    try {
      if (pid !== undefined && killTree(pid, 'SIGKILL')) return
      running.kill('SIGKILL')
    } catch (error) {
      // 进程可能已消失：终止失败不是状态机错误
      log(`[plugin:${manifest.id}] 终止子进程失败（已忽略）：${errMsg(error)}`)
    }
  }

  const writeFrame = (frame: HostToPluginFrame): boolean => {
    const running = child
    if (running === null || running.stdin === null) return false
    try {
      running.stdin.write(encodePluginFrame(frame))
      return true
    } catch (error) {
      log(`[plugin:${manifest.id}] 帧写入失败：${errMsg(error)}`)
      return false
    }
  }

  /** 失败收尾：递增代际、清空 hello 定时器，再决定重拉还是进入 error。 */
  const afterFailure = (failedGeneration: number, reason: string): void => {
    if (failedGeneration !== generation) return
    generation += 1
    child = null
    clearHelloTimer()
    resolveCloseWaiters()
    // 停止流程里的退出不重拉；dispose 必然经过 stop，所以只看 stopping
    if (stopping) {
      setStatus('stopped', null)
      return
    }
    if (restarts < restartMax) {
      scheduleRestart(reason)
      return
    }
    const error = `插件连续失败 ${restartMax + 1} 次：${reason}`
    setStatus('error', error)
    settleStart(new Error(`plugin_start_failed: ${error}`))
  }

  /** 协议违规（hello 身份不一致）：终止且不重拉，避免在错误授权面上反复启动。 */
  const fatalFailure = (reason: string, running: Spawned): void => {
    generation += 1
    child = null
    clearHelloTimer()
    killRunning(running)
    resolveCloseWaiters()
    log(`[plugin:${manifest.id}] ${reason}，已终止且不重拉`)
    setStatus('error', reason)
    settleStart(new Error(`plugin_start_failed: ${reason}`))
  }

  const scheduleRestart = (reason: string): void => {
    restarts += 1
    setStatus('starting', reason)
    log(
      `[plugin:${manifest.id}] ${reason}，${restartDelayMs} ms 后第 ${restarts}/${restartMax} 次重拉`,
    )
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnAttempt()
    }, restartDelayMs)
  }

  /** 处理一行插件输出（hello 在本层消费，其余交回上层）。 */
  const handleLine = (lineGeneration: number, source: Spawned, line: string): void => {
    if (lineGeneration !== generation) return
    const frame = parsePluginFrame(line)
    if (frame === null) {
      // 帧内容可能含用户数据：只记长度，不落原文
      log(`[plugin:${manifest.id}] 丢弃非法帧（${line.length} 字节）`)
      return
    }
    if (frame.type === 'hello') {
      if (status === 'ready') {
        log(`[plugin:${manifest.id}] 忽略重复 hello`)
        return
      }
      const mismatch =
        frame.id !== manifest.id
          ? 'id'
          : frame.kind !== manifest.kind
            ? 'kind'
            : frame.version !== manifest.version
              ? 'version'
              : sameCapabilities(frame.capabilities, manifest.capabilities)
                ? null
                : 'capabilities'
      if (mismatch !== null) {
        fatalFailure(`hello 自报的 ${mismatch} 与 manifest 不一致`, source)
        return
      }
      clearHelloTimer()
      if (
        !writeFrame({
          v: PLUGIN_HOST_PROTOCOL_VERSION,
          type: 'welcome',
          pluginId: manifest.id,
          granted,
          config,
        })
      ) {
        fatalFailure('子进程 stdin 不可用，无法下发 welcome', source)
        return
      }
      setStatus('ready', null)
      settleStart(null)
      return
    }
    if (frame.type === 'log') {
      log(`[plugin:${manifest.id}] ${frame.line}`)
      return
    }
    try {
      options.onFrame?.(frame)
    } catch (error) {
      // 上层消费失败只记日志：不影响后续帧
      log(`[plugin:${manifest.id}] 帧处理失败（${frame.type}）：${errMsg(error)}`)
    }
  }

  const wire = (spawnGeneration: number, running: Spawned): void => {
    const stdout = running.stdout
    if (stdout !== null) {
      const reader = createCappedLineReader(
        (line) => handleLine(spawnGeneration, running, line),
        PLUGIN_HOST_LIMITS.frameBytes,
        () => log(`[plugin:${manifest.id}] 丢弃超过 ${PLUGIN_HOST_LIMITS.frameBytes} 字节的输出行`),
      )
      stdout.on('data', (chunk: Buffer | string) => reader.push(String(chunk)))
      stdout.on('end', () => reader.flush())
    }
    const stderr = running.stderr
    if (stderr !== null) {
      const reader = createCappedLineReader(
        (line) => log(`[plugin:${manifest.id}] stderr: ${tail(line, PLUGIN_HOST_LIMITS.logLine)}`),
        PLUGIN_HOST_LIMITS.logLine,
        () => log(`[plugin:${manifest.id}] 丢弃超长 stderr 行`),
      )
      stderr.on('data', (chunk: Buffer | string) => reader.push(String(chunk)))
      stderr.on('end', () => reader.flush())
    }
    running.onError((error) => {
      afterFailure(spawnGeneration, `子进程错误：${errMsg(error)}`)
    })
    running.onClose((code, signal) => {
      afterFailure(spawnGeneration, `子进程退出（code=${String(code)}，signal=${String(signal)}）`)
    })
  }

  const spawnAttempt = (): void => {
    const spawnGeneration = ++generation
    setStatus('starting', null)
    let running: Spawned
    try {
      running = options.spawn(options.execPath, [EXTERNAL_PLUGIN_ENTRY], {
        cwd: options.dir,
        env,
        shell: false,
      })
    } catch (error) {
      afterFailure(spawnGeneration, `启动失败：${errMsg(error)}`)
      return
    }
    child = running
    wire(spawnGeneration, running)
    helloTimer = setTimeout(() => {
      helloTimer = null
      // 定时器在失败/停止/成功路径都会被 clearHelloTimer 清掉；这里捕获本次 spawn 的句柄，
      // 即便代际已变也只终止自己，不误伤后续重拉的新子进程
      killRunning(running)
      afterFailure(spawnGeneration, `hello 超时（${helloTimeoutMs} ms）`)
    }, helloTimeoutMs)
  }

  const waitForClose = (graceMs: number): Promise<void> =>
    new Promise((resolve) => {
      if (child === null) {
        resolve()
        return
      }
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, graceMs)
      closeWaiters.push(finish)
    })

  const start = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('plugin_disposed: 外部插件已释放'))
    if (stopping) return Promise.reject(new Error('plugin_stopping: 外部插件正在停止'))
    if (status === 'ready') return Promise.resolve()
    if (startPromise !== null) return startPromise
    const promise = new Promise<void>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    startPromise = promise
    if (status !== 'starting') {
      restarts = 0
      spawnAttempt()
    }
    return promise
  }

  const stop = async (): Promise<void> => {
    if (stopping) return
    if (disposed && status === 'stopped') return
    stopping = true
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    clearHelloTimer()
    settleStart(new Error('plugin_stopped: 插件在启动完成前被停止'))
    const running = child
    if (running !== null) {
      // 1) 先礼：shutdown 帧
      try {
        running.stdin?.write(
          encodePluginFrame({ v: PLUGIN_HOST_PROTOCOL_VERSION, type: 'shutdown' }),
        )
      } catch (error) {
        log(`[plugin:${manifest.id}] shutdown 帧写入失败：${errMsg(error)}`)
      }
      await waitForClose(stopGraceMs)
      // 2) SIGTERM
      if (child !== null) {
        try {
          running.kill('SIGTERM')
        } catch (error) {
          log(`[plugin:${manifest.id}] SIGTERM 失败：${errMsg(error)}`)
        }
        await waitForClose(stopGraceMs)
      }
      // 3) 整树强杀（宽限内仍未退出）
      if (child !== null) {
        killRunning(running)
        child = null
        generation += 1
      }
    }
    stopping = false
    if (status !== 'stopped') setStatus('stopped', null)
  }

  return {
    start,
    stop,
    dispose: async () => {
      if (disposed) return
      await stop()
      disposed = true
    },
    send: (frame) => {
      if (status !== 'ready') return false
      return writeFrame(frame)
    },
    status: () => status,
    lastError: () => lastError,
  }
}
