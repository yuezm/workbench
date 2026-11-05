/**
 * dsh 子进程启动与一次性命令收集（dsh 专属）。
 *
 * 只经 `ctx.sdk.process` 拿能力：可执行文件解析、spawn、杀进程树；不 import
 * node 内置与 `host/**`。子进程环境由宿主构造，插件只额外声明 dsh 需要的两个变量。
 */
import type { Sdk, Spawned } from '../../../sdk/types'
import { extractSemver, tail } from '../../shared/text'
import { OUTPUT_TAIL_LIMIT, VERSION_TIMEOUT_MS } from './constants'

/** 插件内可覆盖的超时/宽限（仅测试用；生产取 `constants.ts` 的缺省） */
export interface DshOptions {
  timeouts?: { probe?: number; version?: number; models?: number; run?: number }
  grace?: { cancel?: number; kill?: number }
}

export interface Collected {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  spawnError: Error | null
}

/** 错误归一成可读文本（插件内通用，不依赖 node util） */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Windows 下 .cmd/.bat 需要经 shell 启动；纯扩展名判断，与宿主 needsShell 同判据 */
const needsShell = (file: string): boolean => /\.(cmd|bat)$/i.test(file)

/** dsh 需要的额外环境：权限模式 + 会话持久化根（宿主基线由 sdk 合并） */
export function dshEnv(permissionMode: string, sessionRoot: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DSH_PERMISSION_MODE: permissionMode }
  if (sessionRoot) env.MULTICA_DSH_SESSION_ROOT = sessionRoot
  return env
}

/**
 * 启动 dsh 子进程；解析不到可执行文件或 spawn 抛错时返回 error。
 * `cwd` 为 undefined 时交给宿主/进程默认目录（不传空串，避免 ENOENT）。
 */
export function startProcess(
  sdk: Sdk,
  command: string,
  args: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): { process?: Spawned; error?: string } {
  const resolved = sdk.process.resolve(command)
  if (!resolved.path) return { error: resolved.error ?? `找不到可执行文件：${command}` }

  try {
    const process_ = sdk.process.spawn(resolved.path, args, {
      cwd,
      env,
      shell: needsShell(resolved.path),
    })
    return { process: process_ }
  } catch (e) {
    return { error: errMsg(e) }
  }
}

/**
 * 跑一个一次性命令并收集输出（--version / --probe / --list-models 共用）。
 * 不抛异常：超时、非零退出、启动失败都落进返回值。
 */
export async function collect(
  sdk: Sdk,
  command: string,
  profile: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<Collected> {
  const resolved = sdk.process.resolve(command)
  if (!resolved.path) {
    return {
      stdout: '',
      stderr: '',
      code: null,
      timedOut: false,
      spawnError: new Error(resolved.error ?? `找不到可执行文件：${command}`),
    }
  }

  const args = ['--profile', profile, ...extraArgs]
  let child: Spawned
  try {
    child = sdk.process.spawn(resolved.path, args, {
      env: {},
      shell: needsShell(resolved.path),
    })
  } catch (e) {
    return { stdout: '', stderr: '', code: null, timedOut: false, spawnError: new Error(errMsg(e)) }
  }

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let code: number | null = null
  let timedOut = false
  let spawnError: Error | null = null

  return await new Promise<Collected>((resolve) => {
    let settled = false
    // 先声明定时器再声明 finish：两者互相引用，靠闭包在调用时才解析
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) sdk.process.killTree(child.pid)
      else child.kill('SIGKILL')
      finish()
    }, timeoutMs)
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: tail(stderrChunks.join(''), OUTPUT_TAIL_LIMIT),
        code,
        timedOut,
        spawnError,
      })
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(chunk.toString())
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString())
    })
    child.onClose((closeCode) => {
      code = closeCode
      finish()
    })
    child.onError((error) => {
      spawnError = error
      finish()
    })
  })
}

/** 读 CLI 版本号（取输出中第一段 semver）；失败返回 null */
export async function readCliVersion(
  sdk: Sdk,
  command: string,
  profile: string,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> {
  const collected = await collect(sdk, command, profile, ['--version'], timeoutMs)
  if (collected.spawnError || collected.timedOut) return null
  return extractSemver(collected.stdout)
}
