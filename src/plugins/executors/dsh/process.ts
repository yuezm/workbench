/**
 * dsh 的进程绑定：dsh 专属的环境变量与 `--profile` 前缀。
 *
 * 子进程骨架（解析、spawn、超时杀树、收输出）在 `shared/executor-kit`；这里只保留
 * 「dsh 与别的 CLI 不一样的地方」，避免四个执行器各抄一份骨架。
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
export interface DshOptions {
  timeouts?: { probe?: number; version?: number; models?: number; run?: number }
  grace?: { cancel?: number; kill?: number }
}

/**
 * dsh 需要的额外环境：权限模式 + 会话持久化根 + **智能体配置的环境变量**。
 *
 * 顺序：智能体变量先铺开，权限模式与会话根随后覆盖——权限是宿主的判定，不允许被
 * 智能体配置悄悄改成更宽的模式。宿主基线（PATH 等）由 sdk 合并，插件拿不到 process.env。
 */
export function dshEnv(
  permissionMode: string,
  sessionRoot: string | null,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra, DSH_PERMISSION_MODE: permissionMode }
  // 会话根是宿主判定的路径：有值就覆盖，没配置就把智能体写的同名键删掉
  if (sessionRoot) env.MULTICA_DSH_SESSION_ROOT = sessionRoot
  else delete env.MULTICA_DSH_SESSION_ROOT
  return env
}

/** dsh 的每条一次性命令都要带 `--profile <profile>`；其余参数原样追加 */
export const collect = (
  sdk: Sdk,
  command: string,
  profile: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<Collected> =>
  collectOnce(sdk, command, ['--profile', profile, ...extraArgs], {
    timeoutMs,
    tailLimit: OUTPUT_TAIL_LIMIT,
  })

/** 读 CLI 版本号（取输出中第一段 semver）；失败返回 null */
export const readCliVersion = (
  sdk: Sdk,
  command: string,
  profile: string,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> =>
  readVersionOnce(sdk, command, ['--profile', profile, '--version'], {
    timeoutMs,
    tailLimit: OUTPUT_TAIL_LIMIT,
  })
