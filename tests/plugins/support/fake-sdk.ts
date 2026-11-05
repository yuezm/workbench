/**
 * 测试夹具：按 `Sdk` 形状构造假能力面。
 *
 * 插件只经 `ctx.sdk` 拿能力，因此执行器测试不需要真进程/真文件系统：
 * `process.spawn / resolve / killTree / scanDirs / findInDirs` 与 `now / paths.sessionRoot`
 * 都可注入，未注入的项给最小缺省（resolve 认当前 node 可执行文件，其它命令按 PATH 找不到）。
 */
import type {
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
}

/** 缺省解析：只认当前 node 可执行文件；其它命令模拟「PATH 里找不到」 */
const defaultResolve = (command: string): ResolvedExecutable =>
  command === process.execPath
    ? { path: command, error: null }
    : { path: null, error: `在 PATH 中找不到命令：${command}` }

export function fakeSdk(overrides: FakeSdkOverrides = {}): Sdk {
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
  return {
    log: overrides.log ?? (() => undefined),
    now: overrides.now ?? (() => Date.now()),
    paths,
    config: overrides.config ?? (<T = Record<string, unknown>>() => ({}) as T),
    process: processCapability,
  }
}
