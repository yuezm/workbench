/**
 * claude 的进程绑定：子进程骨架在 `shared/executor-kit`，这里只做参数绑定。
 *
 * claude 与别的 CLI 的差异全在 argv（权限模式、模型、续接），因此不需要额外的环境变量：
 * 宿主基线由 `sdk` 合并，插件拿不到 `process.env`。
 */
import type { Sdk } from '../../../sdk/types'
import {
  collect as collectOnce,
  readCliVersion as readVersionOnce,
  type Collected,
} from '../../shared/executor-kit'
import { OUTPUT_TAIL_LIMIT, VERSION_TIMEOUT_MS } from './constants'

export { errMsg, startProcess } from '../../shared/executor-kit'
export type { Collected, Started } from '../../shared/executor-kit'

/** 插件内可覆盖的超时/宽限（仅测试用；生产取 `constants.ts` 的缺省） */
export interface ClaudeOptions {
  timeouts?: { version?: number; help?: number; run?: number }
  grace?: { kill?: number }
}

/** 一次性命令（`--version` / `--help`） */
export const collect = (
  sdk: Sdk,
  command: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<Collected> =>
  collectOnce(sdk, command, extraArgs, { timeoutMs, tailLimit: OUTPUT_TAIL_LIMIT })

/** 读 CLI 版本号（取输出中第一段 semver）；失败返回 null */
export const readCliVersion = (
  sdk: Sdk,
  command: string,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> =>
  readVersionOnce(sdk, command, ['--version'], { timeoutMs, tailLimit: OUTPUT_TAIL_LIMIT })
