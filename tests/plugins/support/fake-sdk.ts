/**
 * 测试夹具：按 `Sdk` 形状构造假能力面。
 *
 * 插件只经 `ctx.sdk` 拿能力，因此执行器/通道测试不需要真进程/真文件系统/真通知：
 * `process.spawn / resolve / killTree / scanDirs / findInDirs`、`now / paths.sessionRoot`
 * 与 `notify` 都可注入，未注入的项给最小缺省（resolve 认当前 node 可执行文件，其它命令按
 * PATH 找不到；notify 把调用记进 `notifyCalls`，供「文案只作参数」断言）。
 */
import type {
  NotifyFn,
  ProcessCapability,
  ResolvedExecutable,
  Sdk,
  SpawnFn,
  SdkPaths,
} from '../../../src/sdk/types'

export interface FakeSdkOverrides {
  spawn?: SpawnFn
  resolve?: (command: string) => ResolvedExecutable
  killTree?: (pid: number, signal?: NodeJS.Signals) => boolean
  scanDirs?: () => string[]
  findInDirs?: (command: string, dirs: string[]) => string | null
  now?: () => number
  sessionRoot?: string | null
  log?: (line: string) => void
  config?: <T = Record<string, unknown>>() => T
  /** 系统通知；未注入时记进返回值的 `notifyCalls`（title/body 原样保存） */
  notify?: NotifyFn
}

/** 假能力面：比 `Sdk` 多一份缺省 notify 的调用记录。 */
export interface FakeSdk extends Sdk {
  /** 缺省 notify 收到的调用（顺序即调用顺序；文案只作参数） */
  notifyCalls: Array<{ title: string; body: string }>
}

/** 缺省解析：只认当前 node 可执行文件；其它命令模拟「PATH 里找不到」 */
const defaultResolve = (command: string): ResolvedExecutable =>
  command === process.execPath
    ? { path: command, error: null }
    : { path: null, error: `在 PATH 中找不到命令：${command}` }

export function fakeSdk(overrides: FakeSdkOverrides = {}): FakeSdk {
  const processCapability: ProcessCapability = {
    spawn:
      overrides.spawn ??
      (() => {
        throw new Error('fakeSdk：未注入 spawn')
      }),
    resolve: overrides.resolve ?? defaultResolve,
    killTree: overrides.killTree ?? (() => false),
    scanDirs: overrides.scanDirs ?? (() => []),
    findInDirs: overrides.findInDirs ?? (() => null),
  }
  const paths: SdkPaths = { sessionRoot: overrides.sessionRoot ?? null }
  const notifyCalls: FakeSdk['notifyCalls'] = []
  return {
    log: overrides.log ?? (() => undefined),
    now: overrides.now ?? (() => Date.now()),
    paths,
    config: overrides.config ?? (<T = Record<string, unknown>>() => ({}) as T),
    notify:
      overrides.notify ??
      ((title, body) => {
        notifyCalls.push({ title, body })
      }),
    notifyCalls,
    process: processCapability,
  }
}
