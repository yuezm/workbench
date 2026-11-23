/**
 * 服务生命周期：装配 → 监听 → 退出，全部可注入。
 *
 * 入口（`index.ts`）只负责调用这里；装配顺序、日志文案、信号处理与退出顺序都放在这里，
 * 单测可以用假装配验证「监听地址从哪来、退出顺序对不对、重复信号会不会把库关两遍」，
 * 不必真跑内核、也不必真发信号。
 */
import type { ServerConfig } from './config'
import { ConfigError, loadServerConfig, SERVER_ENV } from './config'
import {
  resolveWebUi,
  uiStartupSuffix,
  type WebUiMode,
  type WebUiResolution,
} from '@workbench/bundle-web'
import { createAuthenticator } from '@workbench/api-http/auth'
import { createWorkbench, type Workbench, type WorkbenchOptions } from '@workbench/bundle-base'
import { createEventStream } from '@workbench/api-http/event-stream'
import { listDirectories } from '@workbench/api-http/fs-browse'
import { startWebServer } from '@workbench/api-http/http'
import { createNotifier } from '@workbench/api-http/notify'

/** 关服务的收尾宽限与退出总时限：都只为「一定退」服务 */
export const STOP_DEADLINE_MS = 10_000

/**
 * 在时限内跑完清理：`false` 表示超时。
 *
 * 超时之后并不去中止清理（里面是杀进程、关连接、关库，硬中断只会留半截状态）；
 * 入口拿到 `false` 只记一条日志，随后 `process.exit(0)` 把残留一起带走。
 */
async function withinDeadline(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null
  try {
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
      timer.unref()
    })
    return await Promise.race([work.then(() => true), deadline])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export interface StartedServer {
  port: number
  /** 实际监听地址（`port=0` 时是系统分配的那个端口） */
  url: string
  /** 优雅退出：HTTP → 事件流 → 装配层 */
  stop(): Promise<void>
}

export interface StartServerOptions {
  config: ServerConfig
  /** 本次启动是否托管界面（`null` = 纯 API）；缺省用 config.webDir */
  webDir?: string | null
  log?: (line: string) => void
  /** 装配注入（测试用假装配；生产用 `createWorkbench`） */
  assemble?: (options: WorkbenchOptions) => Promise<Workbench>
}

/** 监听地址在 URL 里的写法：IPv6 要加方括号 */
export function displayHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export async function startWorkbenchServer(options: StartServerOptions): Promise<StartedServer> {
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`)
    })
  const { config } = options
  const assemble = options.assemble ?? createWorkbench

  const events = createEventStream()
  const workbench = await assemble({
    dataDir: config.dataDir,
    log,
    publish: (event) => events.publish(event),
    clients: () => events.size,
  })
  const notifier = createNotifier({ publish: (event) => events.publish(event), log })
  const web = await startWebServer(
    {
      auth: createAuthenticator(config.token),
      router: workbench.router,
      lark: workbench.lark,
      notify: (payload) => notifier(payload.title, payload.body ?? ''),
      events,
      listDirs: (target) => listDirectories(target),
      info: () => workbench.info(),
      webDir: options.webDir === undefined ? config.webDir : options.webDir,
      log,
    },
    { host: config.host, port: config.port },
  )

  let stopped = false
  return {
    port: web.port,
    url: `http://${displayHost(config.host)}:${web.port}`,
    stop: async () => {
      if (stopped) return
      stopped = true
      // 顺序有讲究：`web.close()` 先停收新连接，但它要等既有连接结束才 resolve；
      // SSE 是永不自己结束的响应，所以紧接着合上事件流，连接才会收尾。
      const httpClosed = web.close()
      events.close()
      await httpClosed
      await workbench.shutdown()
    },
  }
}

/** token 来源的中文说法（不打印口令本身） */
function tokenSourceLabel(config: ServerConfig): string {
  if (config.token === null) return '未启用鉴权（仅回环监听）'
  const source: Record<'env' | 'file', string> = {
    env: SERVER_ENV.token,
    file: '数据目录里的口令文件',
  }
  return `已启用鉴权（口令来源：${config.tokenSource === 'env' ? source.env : source.file}）`
}

export interface RunEntryOptions {
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /** 配置读取（测试注入） */
  loadConfig?: typeof loadServerConfig
  /** 服务启动（测试注入） */
  start?: typeof startWorkbenchServer
  /** 注册信号（测试注入；生产用 `process.on`） */
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void
  /** 退出（测试注入；生产用 `process.exit`） */
  exit?: (code: number) => void
  /** 界面托管决策（测试注入；生产用 `resolveWebUi`） */
  resolveUi?: (options: { webDir: string; ui: WebUiMode }) => WebUiResolution
  /** 退出总时限（测试注入；生产用 `STOP_DEADLINE_MS`） */
  stopDeadlineMs?: number
}

export interface RunningEntry {
  /** 收到信号后的退出流程；重复调用只跑一次 */
  stop(signal: string): Promise<void>
}

/**
 * 进程入口的全部行为：读配置 → 启动 → 打印地址 → 挂信号。
 *
 * 启动日志里那一行 `workbench listening on <url>` 是给 e2e 与运维脚本解析的固定格式，
 * 改动前先看 `tests/e2e/helpers/launch.ts` 与 README。
 */
export async function runServerEntry(options: RunEntryOptions = {}): Promise<RunningEntry> {
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`)
    })
  const loadConfig = options.loadConfig ?? loadServerConfig
  const start = options.start ?? startWorkbenchServer
  const onSignal =
    options.onSignal ??
    ((signal, handler): void => {
      process.on(signal, handler)
    })
  const exit =
    options.exit ??
    ((code: number): void => {
      process.exit(code)
    })
  const resolveUi = options.resolveUi ?? resolveWebUi
  const stopDeadlineMs = options.stopDeadlineMs ?? STOP_DEADLINE_MS

  const config = loadConfig(options.env === undefined ? undefined : { env: options.env })
  const ui = resolveUi({ webDir: config.webDir, ui: config.ui })

  const server = await start({ config, log, webDir: ui.dir })
  log(`[workbench] 数据目录：${config.dataDir}`)
  log(`[workbench] 界面：${ui.dir === null ? `纯 API 模式（${ui.reason}）` : ui.dir}`)
  log(`[workbench] ${tokenSourceLabel(config)}`)
  log(`workbench listening on ${server.url}${uiStartupSuffix(ui)}`)

  let stopping = false
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    log(`[workbench] 收到 ${signal}，开始退出`)
    const finished = await withinDeadline(server.stop(), stopDeadlineMs).catch((error: unknown) => {
      log(`[workbench] 退出清理失败：${error instanceof Error ? error.message : String(error)}`)
      return true
    })
    if (!finished) log(`[workbench] 清理超过 ${stopDeadlineMs}ms，放弃剩余动作直接退出`)
    log('[workbench] 已退出')
    // 所有句柄都已显式关闭；插件子进程理论上可能留下无法取消的句柄（例如挂住的原生库），
    // 显式退出保证「收到 SIGTERM 就一定退」，进程管理器不会等超时再 SIGKILL。
    exit(0)
  }

  onSignal('SIGINT', () => {
    void stop('SIGINT')
  })
  onSignal('SIGTERM', () => {
    void stop('SIGTERM')
  })

  return { stop }
}

/** 启动失败的报告方式：配置错误只说文案，其余带栈（入口的 catch 直接传这个函数） */
export function reportStartupError(
  error: unknown,
  log: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`)
  },
): void {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ConfigError) {
    log(`[workbench] 配置错误：${message}`)
  } else {
    log(`[workbench] 启动失败：${message}`)
    if (error instanceof Error && error.stack !== undefined) log(error.stack)
  }
  process.exitCode = 1
}
