/**
 * 测试夹具：按 `Sdk` 形状构造假能力面。
 *
 * 插件只经 `ctx.sdk` 拿能力，因此执行器/通道/来源测试不需要真进程/真文件系统/真通知/
 * 真网络：`process.spawn / resolve / killTree / scanDirs / findInDirs`、`net.fetch / listen /
 * verifyHmacSha256`、`now / paths.sessionRoot` 与 `notify` 都可注入，未注入的项给最小缺省
 * （resolve 认当前 node 可执行文件，其它命令按 PATH 找不到；net 三个方法都以
 * `capability_unavailable: net` 失败；notify 把调用记进 `notifyCalls`，供「文案只作参数」断言）。
 */
import type {
  NetCapability,
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
  /** 主进程当前目录（workdir 留空时的执行目录兜底）；未注入时用 `process.cwd()` */
  cwd?: string
  log?: (line: string) => void
  config?: <T = Record<string, unknown>>() => T
  /** 系统通知；未注入时记进返回值的 `notifyCalls`（title/body 原样保存） */
  notify?: NotifyFn
  /** 网络能力（M7）；未注入时 `fakeNet()`（三个方法都失败），webhook 测试可整体替换 */
  net?: NetCapability
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

/** 宿主没有网络原件时的错误（与 `sdk/index.ts` 的缺省兜底同一文案）。 */
const unavailableNet = (): never => {
  throw new Error('capability_unavailable: net')
}

/**
 * 构造假网络能力面：只覆盖用到的项，其余按「宿主没有 net 原件」失败。
 *
 * 来源/通道测试用它注入假 `listen` / `fetch`（不打真端口），例如：
 * `fakeSdk({ net: fakeNet({ listen: async () => ({ port: 47615, close: async () => undefined }) }) })`。
 */
export function fakeNet(overrides: Partial<NetCapability> = {}): NetCapability {
  return {
    fetch: overrides.fetch ?? (() => Promise.reject(new Error('capability_unavailable: net'))),
    listen: overrides.listen ?? (() => Promise.reject(new Error('capability_unavailable: net'))),
    verifyHmacSha256: overrides.verifyHmacSha256 ?? unavailableNet,
  }
}

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
  const paths: SdkPaths = {
    sessionRoot: overrides.sessionRoot ?? null,
    cwd: overrides.cwd ?? process.cwd(),
  }
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
    net: overrides.net ?? fakeNet(),
    process: processCapability,
  }
}
