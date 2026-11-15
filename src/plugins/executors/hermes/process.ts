/**
 * hermes 的进程绑定：子进程骨架在 `shared/executor-kit`，这里只做参数绑定。
 *
 * ACP 不需要额外环境变量（权限走 `session/set_mode`），与 claude 的差别只在 argv。
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
export interface HermesOptions {
  timeouts?: {
    probe?: number
    version?: number
    models?: number
    run?: number
    /** 普通 JSON-RPC 请求（set_mode / set_model）等待回帧的上限 */
    request?: number
  }
  grace?: { cancel?: number; kill?: number }
}

/** 一次性命令（`--version`） */
export const collect = (
  sdk: Sdk,
  command: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<Collected> =>
  collectOnce(sdk, command, extraArgs, { timeoutMs, tailLimit: OUTPUT_TAIL_LIMIT })

/**
 * 读 CLI 版本号（取输出中第一段 semver）；失败返回 null。
 *
 * 输出形如 `Hermes Agent v0.22.5 (2026.9.24) · stable · …`：括号里的日期也满足
 * semver 形状，因此只取第一段。
 */
export const readCliVersion = (
  sdk: Sdk,
  command: string,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> =>
  readVersionOnce(sdk, command, ['--version'], { timeoutMs, tailLimit: OUTPUT_TAIL_LIMIT })
