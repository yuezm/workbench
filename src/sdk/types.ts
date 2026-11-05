/**
 * 插件能力面（M3）：**只定义类型**，实现由宿主注入（`src/host/sdk-host.ts` 提供原件、
 * `src/sdk/index.ts` 的 `createSdk` 按 manifest 做能力门控）。
 *
 * 依赖方向：`sdk → protocol`。插件只 import 本文件与 `protocol/**`，拿不到
 * `host/**`、node 内置与 electron；副作用一律经 `Sdk` 暴露的能力。
 *
 * M3 最小面：执行器只需要「跑一轮」所需的 log/now/paths/config/process，
 * 因此不提供 `fs.read/write`、`net`、`emit`（执行器只能经 `ExecutorIO` 回报）。
 * M4 增 `notify`（桌面通道用）：要求 manifest 声明 `capabilities: ['notify']`；
 * fs/net 等仍随 M6/M7 的 source 插件另立任务。
 */
import type {
  DetectedRuntime,
  Runtime,
  RuntimeModelOption,
  RuntimeProbe,
} from '../protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../protocol/executor'

/** 子进程句柄（与 `host/process.ts` 的 `SpawnedProcess` 结构兼容） */
export interface Spawned {
  pid: number | undefined
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  onError(cb: (error: Error) => void): void
  onClose(cb: (code: number | null, signal: string | null) => void): void
  kill(signal: NodeJS.Signals): void
}

export interface SpawnOptions {
  cwd?: string
  /** 宿主构造的子进程环境（插件拿不到 `process.env` 本身） */
  env: NodeJS.ProcessEnv
  /** Windows 的 .cmd/.bat 需要经 shell 启动 */
  shell?: boolean
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Spawned

export interface ResolvedExecutable {
  /** 绝对路径；找不到为 null */
  path: string | null
  /** 解析失败原因；成功为 null */
  error: string | null
}

/** 进程能力（需要 manifest 声明 `spawn`） */
export interface ProcessCapability {
  /** 启动子进程（命令名由插件决定，宿主只负责执行；不做 shell 字符串拼接） */
  spawn(command: string, args: string[], options: SpawnOptions): Spawned
  /** 把命令解析成本机可执行文件（扫 PATH + 常见全局目录，`.cmd/.bat` 需要 shell） */
  resolve(command: string): ResolvedExecutable
  /** 终止整棵进程树（Windows `taskkill /T /F`，POSIX 进程组） */
  killTree(pid: number, signal?: NodeJS.Signals): boolean
  /** 默认扫描目录（PATH 分段 + 常见全局目录） */
  scanDirs(): string[]
  /** 在给定目录里找命令；Windows 试 `.exe/.cmd/.bat/.ps1`，POSIX 要求可执行位 */
  findInDirs(command: string, dirs: string[]): string | null
}

/** 宿主注入的路径（执行器用于跨轮续接的会话根等） */
export interface SdkPaths {
  /** 协议会话持久化目录；宿主未配置时为 null */
  sessionRoot: string | null
}

/** 插件能力面（宿主按 manifest 的 capabilities 门控后注入） */
export interface Sdk {
  /** 结构化日志（宿主加插件 id 前缀；不记 prompt 全文） */
  log(line: string): void
  /** 当前时刻（毫秒；ISO 由回执/事实载体决定） */
  now(): number
  paths: SdkPaths
  /** 插件自有配置（M3 无消费者，返回 manifest 默认值或空对象） */
  config<T = Record<string, unknown>>(): T
  /** 进程能力：未声明 `spawn` 时访问即抛 `capability_not_declared` */
  process: ProcessCapability
  /**
   * 系统通知：未声明 `notify` 时访问即抛 `capability_not_declared`。
   * title/body 只作通知 API 参数（不拼命令行/HTML/脚本），也不落日志；
   * 不可用或构造失败时静默丢弃，不影响调用方继续投递/回答。
   */
  notify(title: string, body: string): void
}

/** 系统通知原件：装配根注入 Electron 实现，测试注入假实现。 */
export type NotifyFn = (title: string, body: string) => void

/**
 * `createSdk` 的宿主原件（`host/sdk-host.ts` 的唯一实现；测试注入假实现）。
 *
 * `notify` 可选：没有桌面通知的宿主（测试/无头）可以不提供，`createSdk` 对声明了
 * `notify` 的插件退化为静默丢弃——通知失败不是投递失败，更不影响内核。
 */
export interface SdkHost {
  log(line: string): void
  now(): number
  paths: SdkPaths
  config<T = Record<string, unknown>>(): T
  process: ProcessCapability
  notify?: NotifyFn
}

/** 执行一轮时的上下文：运行时配置 + 能力面 */
export interface ExecutorContext {
  runtime: Runtime
  sdk: Sdk
}

/** `detect()` 的上下文：只需要能力面（不绑运行时） */
export interface DetectContext {
  sdk: Sdk
}

/**
 * 执行器插件（SPEC-plugins「接口/executor」）。
 *
 * - `run` 必选：宿主领取后调用一轮，返回回执；插件不领活、不写库、不决定派给谁。
 * - `probe` / `models`：运行时配置与表单用，不参与调度。
 * - `detect`：只读扫描本机候选，**零副作用**；`executorKey` 由注册表填，插件不自报。
 */
export interface ExecutorPlugin {
  probe?(ctx: ExecutorContext): Promise<RuntimeProbe>
  models?(ctx: ExecutorContext): Promise<RuntimeModelOption[]>
  detect?(ctx: DetectContext): DetectedRuntime[] | Promise<DetectedRuntime[]>
  run(ctx: ExecutorContext, turn: Turn, io: ExecutorIO): Promise<Receipt>
}
