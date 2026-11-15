/**
 * 执行器骨架：把「跑一个一次性命令 / 起一个长驻子进程」的共用部分收成一份。
 *
 * 为什么放在 `shared`：四个执行器（`dsh` / `claude` / `hermes` / `command`）都要经
 * `sdk.process` 解析可执行文件、spawn、按超时杀进程树、收 stdout/stderr，这些逻辑
 * 与协议无关；插件之间禁止互相 import，于是它只能住在这里。
 *
 * 与 `shared/` 其它文件的差别：本文件有副作用，但副作用**只经 `sdk` 能力面**
 * （`resolve` / `spawn` / `killTree`），不 import node 内置与 `host/**`——边界与
 * 纯函数文件同一条，能力门控仍由 `createSdk` 按 manifest 做。
 *
 * 不抛异常：解析不到可执行文件、spawn 抛错、超时、非零退出都归一进返回值。
 */
import type { Sdk, Spawned } from '../../sdk/types'
import { extractSemver, tail } from './text'

/** `collect` / `readCliVersion` 的调用参数 */
export interface CollectOptions {
  /** 超时：到点杀进程树，按 `timedOut` 返回（不 reject） */
  timeoutMs: number
  /** stderr 尾部保留字符数（各插件用 `OUTPUT_TAIL_LIMIT`） */
  tailLimit: number
}

/** 一次性命令的收集结果（非零退出也算「拿到结果」） */
export interface Collected {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  spawnError: Error | null
}

/** 启动结果：拿到子进程与拿到可读错误互斥，调用方只需判一次 */
export type Started = { process: Spawned } | { error: string }

/** 错误归一成可读文本（插件内通用，不依赖 node util） */
export const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Windows 下 `.cmd/.bat` 需要经 shell 启动。
 *
 * 纯扩展名判断，与宿主 `needsShell` 同判据：插件拿不到 `process.platform`，
 * 只按 resolve 返回的路径形态判。
 */
export const needsShell = (file: string): boolean => /\.(cmd|bat)$/i.test(file)

/**
 * 启动子进程；解析不到可执行文件或 spawn 抛错时返回 error。
 *
 * `cwd` 为 undefined 时交给宿主/进程默认目录（不传空串，避免 ENOENT）。
 */
export function startProcess(
  sdk: Sdk,
  command: string,
  args: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): Started {
  const resolved = sdk.process.resolve(command)
  if (!resolved.path) return { error: resolved.error ?? `找不到可执行文件：${command}` }

  try {
    // 宿主原件的签名保证返回句柄；这里仍判一次空值：spawn 的实现者换成别的宿主时，
    // 拿到空句柄的调用方会在下一行解引用崩掉，兜成可读错误比崩便宜
    const process_ = sdk.process.spawn(resolved.path, args, {
      cwd,
      env,
      shell: needsShell(resolved.path),
    }) as Spawned | undefined
    if (process_ === undefined) return { error: '启动失败' }
    return { process: process_ }
  } catch (e) {
    return { error: errMsg(e) }
  }
}

/**
 * 跑一个一次性命令并收集输出（`--version` / `--probe` / `--list-models` 共用）。
 *
 * 环境传 `{}` 而不是省略：这些命令不需要智能体配置的变量，宿主基线由 `sdk` 合并。
 */
export async function collect(
  sdk: Sdk,
  command: string,
  args: string[],
  options: CollectOptions,
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
    }, options.timeoutMs)
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: tail(stderrChunks.join(''), options.tailLimit),
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
  args: string[],
  options: CollectOptions,
): Promise<string | null> {
  const collected = await collect(sdk, command, args, options)
  if (collected.spawnError || collected.timedOut) return null
  // 版本串里可能还有括号日期（`v0.22.5 (2026.9.24)` 也满足 semver 形状），只取第一段
  return extractSemver(collected.stdout)
}
