/**
 * 宿主能力原件（M3）：`SdkHost` 的唯一实现，把 `host/process.ts` 与
 * `host/executable.ts` 的现成能力组装成插件能力面 `Sdk` 的原料。
 *
 * 为什么单独一层：`host/process.ts`、`host/executable.ts` 是宿主能力本体（有副作用），
 * 插件不能直接 import；`src/sdk/index.ts` 只负责「按 manifest 门控后转发」。这一层负责
 * 「原件取自哪、缺省值是什么」，装配根（`src/main`）只注入可变项：日志通道、时钟、
 * 会话根、配置、系统通知。这样 `host/process.ts` 与 `host/executable.ts` 一行不用改。
 *
 * 边界：本文件不读业务数据、不写库、不主动 spawn 任何进程（`spawn` 只是把函数交给插件）。
 * 缺省值：`spawn = defaultSpawn`、`now = Date.now`（毫秒）、`log = console.warn`
 * （M3 没有日志面板，先落主进程终端，ESLint 只允许 warn/error）、`config` 返回空对象、
 * `sessionRoot` 未配置为 null（执行器据此跳过跨轮续接）、`notify` 静默丢弃（M4：装配根
 * 注入 `src/main/notify.ts` 的 Electron 实现；host 自身不 import electron）、`net` 缺省
 * 不注入（M7：装配根注入 `host/net.ts` 的原件；没有原件时声明了 `net` 的插件调用即
 * `capability_unavailable`，不影响其它能力）。
 */
import type {
  NetCapability,
  NotifyFn,
  SdkHost,
  SdkPaths,
  SdkReceiptTool,
  SpawnFn,
} from '../sdk/types'
import { defaultScanDirs, findInDirs, resolveExecutable } from './executable'
import { defaultSpawn, killProcessTree } from './process'

/** `createSdkHost` 的可注入项：全部有缺省值，装配根只传需要的。 */
export interface SdkHostOptions {
  /** 协议会话持久化目录（执行器跨轮续接用）；装配根按 userData 注入，缺省 null */
  sessionRoot?: string | null
  /** 主进程当前目录（绝对路径）；运行时 workdir 留空时执行器用它，缺省 `process.cwd()` */
  cwd?: string
  /** 当前时刻（毫秒）；测试注入假时钟 */
  now?: () => number
  /** 日志落点（装配根可换成自己的通道）；缺省 `console.warn` */
  log?: (line: string) => void
  /** 子进程启动函数；测试注入假 spawn，缺省 `host/process.ts` 的 `defaultSpawn` */
  spawn?: SpawnFn
  /** 插件自有配置；M3 无消费者，缺省空对象 */
  config?: <T = Record<string, unknown>>() => T
  /** 系统通知（M4）：装配根注入 `src/main/notify.ts`；缺省静默丢弃，测试注入假实现 */
  notify?: NotifyFn
  /** 网络原件（M7）：装配根注入 `host/net.ts` 的 `createNetCapability()`；缺省不注入 */
  net?: NetCapability
  /** 回执工具 server（M24）：装配根注入 `host/receipt-tool` 的解析结果；缺省 null（不注入） */
  receiptTool?: SdkReceiptTool | null
}

/** 缺省日志：M3 没有日志面板，插件日志先落主进程终端。 */
const defaultLog = (line: string): void => {
  console.warn(line)
}

/** 缺省配置：没有配置消费者时返回空对象（插件拿不到宿主配置，只能用 manifest 默认值）。 */
const defaultConfig = <T = Record<string, unknown>>(): T => ({}) as T

/** 缺省通知：无桌面环境/测试宿主没有原件，静默丢弃（文案与落点都不落日志、不入库）。 */
const defaultNotify: NotifyFn = (): void => undefined

/** 组装宿主原件：所有缺省值集中在这里，插件侧不感知来源。 */
export function createSdkHost(options: SdkHostOptions = {}): SdkHost {
  const spawn: SpawnFn = options.spawn ?? defaultSpawn
  const paths: SdkPaths = {
    sessionRoot: options.sessionRoot ?? null,
    cwd: options.cwd ?? process.cwd(),
    receiptTool: options.receiptTool ?? null,
  }

  return {
    log: options.log ?? defaultLog,
    now: options.now ?? Date.now,
    paths,
    config: options.config ?? defaultConfig,
    notify: options.notify ?? defaultNotify,
    // 网络原件按需注入：没有注入时 `SdkHost.net` 为 undefined，`createSdk` 退化为
    // `capability_unavailable`（声明了 net 但宿主没有实现，调用才失败）
    ...(options.net === undefined ? {} : { net: options.net }),
    process: {
      spawn,
      // 命令解析 / 目录扫描 / 进程树终止都直接用宿主现成实现，不在 sdk 层复刻平台分支
      resolve: (command) => resolveExecutable(command),
      killTree: (pid, signal) => killProcessTree(pid, signal),
      scanDirs: () => defaultScanDirs(),
      findInDirs: (command, dirs) => findInDirs(command, dirs),
    },
  }
}
