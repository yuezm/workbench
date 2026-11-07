/**
 * hermes 子进程启动与一次性命令收集（hermes 专属）。
 *
 * 只经 `ctx.sdk.process` 拿能力：可执行文件解析、spawn、杀进程树；不 import
 * node 内置与 `host/**`。子进程环境由宿主构造，插件不额外声明变量（ACP 不需要
 * 权限模式之类的环境变量：权限走 `session/set_mode`）。
 */
import type { Sdk, Spawned } from '../../../sdk/types'
import { extractSemver, tail } from '../../shared/text'
import { OUTPUT_TAIL_LIMIT, VERSION_TIMEOUT_MS } from './constants'

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

/**
 * 启动 hermes 子进程（`hermes acp`）；解析不到可执行文件或 spawn 抛错时返回 error。
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
 * 跑一个一次性命令并收集输出（`--version` 用）。
 * 不抛异常：超时、非零退出、启动失败都落进返回值。
 */
export async function collect(
  sdk: Sdk,
  command: string,
  args: string[],
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
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> {
  const collected = await collect(sdk, command, ['--version'], timeoutMs)
  if (collected.spawnError || collected.timedOut) return null
  // 输出形如 `Hermes Agent v0.22.5 (2026.9.24) · stable · ...`：第一段 semver 就是版本号，
  // 括号里的日期（2026.9.24）也满足 semver 形状，因此只取第一段
  return extractSemver(collected.stdout)
}
