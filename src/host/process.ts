import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EnvPatch } from '../sdk/types'

/** 子进程的最小接口（可注入，便于单测不真的 spawn） */
export interface SpawnedProcess {
  pid: number | undefined
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  onError(cb: (error: Error) => void): void
  onClose(cb: (code: number | null, signal: string | null) => void): void
  kill(signal: NodeJS.Signals): void
}

export interface SpawnOptions {
  cwd?: string
  /** 省略 = 继承宿主进程环境；给值则整体替换（不合并） */
  env?: NodeJS.ProcessEnv
  /** 在 `env`（省略时是宿主环境）之上做增量增删（M45） */
  envPatch?: EnvPatch
  /** Windows 的 .cmd/.bat 需要经 shell 启动 */
  shell?: boolean
}

/**
 * 计算最终子进程环境（M45）：`base` → 删 `unset` → 覆盖 `set`。
 *
 * 抽成导出纯函数：通道侧只声明「要剔除谁的变量」，怎么合并由宿主一处决定，
 * 测试也能直接断言「删干净了、该留的还在」而不去 spawn 真进程。
 */
export function applyEnvPatch(base: NodeJS.ProcessEnv, patch: EnvPatch): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const key of patch.unset ?? []) delete merged[key]
  for (const [key, value] of Object.entries(patch.set ?? {})) merged[key] = value
  return merged
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess

/** npm 全局命令的 `.cmd` 垫片里，真正被执行的脚本（模板固定为 `"%_prog%" "%dp0%\…\x.js" %*`）。 */
const SHIM_SCRIPT_PATTERN = /"([^"\r\n]+\.(?:cjs|mjs|js))"/gu

/**
 * 把 Windows 的 npm 垫片（`.cmd` / `.bat`）折回它真正执行的入口。
 *
 * 为什么必须折：经 `cmd.exe` 传参时 cmd 会先吃掉参数里的双引号——`--content '{"text":"…"}'`
 * 到程序手里变成 `{text:…}`（`lark-cli` 直接报 `--content is not valid JSON`），正文里的
 * `&` / `%` 还会被当成命令分隔符与变量展开。飞书卡片的 JSON、带引号的人话正文全都过不去。
 * 折成「node + 脚本」直接跑以后，参数原样进 argv，不经 cmd 这一层。
 *
 * 只认模板里那个**绝对路径**的脚本（`%dp0%` 换成垫片所在目录）；解析不出就返回 null，
 * 调用方退回 `shell: true`，行为与改动前一致。
 */
export function resolveShimScript(shimPath: string): { command: string; args: string[] } | null {
  if (process.platform !== 'win32') return null
  if (!/\.(cmd|bat)$/iu.test(shimPath)) return null
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    // 不是文件 / 没有权限：交给 shell 去试
    return null
  }
  const found = [...text.matchAll(SHIM_SCRIPT_PATTERN)].at(-1)?.[1]
  if (found === undefined) return null
  // `%~dp0` 自带结尾反斜杠，`%dp0%` 不带：两者都归一成垫片所在目录
  const script = found
    .replace(/%~dp0/giu, `${dirname(shimPath)}\\`)
    .replace(/%dp0%/giu, dirname(shimPath))
  if (!/^[A-Za-z]:\\/u.test(script)) return null
  return { command: shimNode(dirname(shimPath)), args: [script] }
}

/**
 * 折出来的脚本用哪个解释器跑：垫片同目录的 `node.exe` 优先（nvm / 官方安装包把 node.exe
 * 与 npm 垫片放在一起，这里一定命中），否则交给 PATH 上的 `node`。
 *
 * **不用 `process.execPath`**：宿主跑在 Electron 里，它的 `execPath` 是 electron.exe，
 * 只能靠 `ELECTRON_RUN_AS_NODE=1` 当 Node 用。那条路会让子进程带上 Electron 的运行时
 * 指纹（Node 24 + V8 electron），而依赖原生模块的 CLI 会按指纹拒跑——dsh 的
 * `node-addon-require-builtin` 只认 Electron 43 / 44 / 44.7 / 45.0.0-alpha.6，
 * 在 45.1.0 上直接 `unsupported Electron runtime fingerprint` 崩在启动阶段
 * （2026-11-16 任务 40eb2134 三轮全废的根因）。
 */
function shimNode(dir: string): string {
  const local = join(dir, 'node.exe')
  return existsSync(local) ? local : 'node'
}

/** 真实 spawn：stdout/stderr/stdin 全部走管道，POSIX 下独立进程组便于整树终止 */
export const defaultSpawn: SpawnFn = (command, args, options) => {
  const base = options.env ?? process.env
  // 省略 env 时继承宿主环境：M42 的 IM 通道要跑自带登录态的 CLI（插件拿不到 process.env）；
  // M45 用 envPatch 剔除别的 agent 的身份变量，让同一个 CLI 落在本程序自己的工作区
  const env = options.envPatch === undefined ? base : applyEnvPatch(base, options.envPatch)
  // `shell: true` 只为跑 `.cmd` / `.bat`：能折回 node + 脚本就折（见 `resolveShimScript`），
  // 折不回来才真的经 cmd——那条路上的引号与元字符会坏。
  const shim = options.shell === true ? resolveShimScript(command) : null
  const child = spawn(shim?.command ?? command, shim === null ? args : [...shim.args, ...args], {
    cwd: options.cwd,
    env,
    shell: shim === null ? (options.shell ?? false) : false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onError: (cb) => {
      child.on('error', cb)
    },
    onClose: (cb) => {
      child.on('close', (code, signal) => cb(code, signal))
    },
    kill: (signal) => {
      child.kill(signal)
    },
  }
}

/**
 * 终止整个进程树：Windows 用 taskkill /T /F，POSIX 向进程组发信号。
 * 进程可能已经退出，这里返回是否发起了终止，不向外抛错。
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return true
    }
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      process.kill(pid, signal)
      return true
    }
  } catch {
    // 进程已消失：没有可终止的目标
    return false
  }
}

/**
 * 对账专用入口：按 pid 终止整棵进程树（固定 SIGKILL；Windows `taskkill /T /F`）。
 *
 * 与 `killProcessTree` 同一实现——区别只在语义：对账手里没有子进程句柄，只有
 * `process_registry` 里记下的 pid，所以要「不管当前状态、直接按 pid 清树」。
 */
export function killPidTree(pid: number): boolean {
  return killProcessTree(pid, 'SIGKILL')
}

/** 增量行读取器：把流式 chunk 切成行（跳过空行，容忍 \r\n） */
export function createLineReader(onLine: (line: string) => void): {
  push(chunk: string): void
  flush(): void
} {
  let buffer = ''
  const drain = (): void => {
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) onLine(line)
      index = buffer.indexOf('\n')
    }
  }
  return {
    push(chunk: string): void {
      buffer += chunk
      drain()
    },
    flush(): void {
      const rest = buffer.replace(/\r$/, '').trim()
      buffer = ''
      if (rest.length > 0) onLine(rest)
    },
  }
}

/** 取文本尾部；超限加省略号前缀（诊断输出用） */
export function tail(text: string, limit: number): string {
  return text.length > limit ? '…' + text.slice(-limit) : text
}
