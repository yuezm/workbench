import { spawn } from 'node:child_process'

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
  env: NodeJS.ProcessEnv
  /** Windows 的 .cmd/.bat 需要经 shell 启动 */
  shell?: boolean
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess

/** 真实 spawn：stdout/stderr/stdin 全部走管道，POSIX 下独立进程组便于整树终止 */
export const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
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
