/**
 * 子进程 ↔ ACP 客户端接线（hermes）：stdout 逐行切帧、stderr 截尾、
 * 进程退出时拒绝等待中的请求（否则请求会挂到超时）。
 *
 * 只经 `ctx.sdk.process` 拿能力；不 import node 内置与 `host/**`。
 */
import type { Sdk, Spawned } from '../../../sdk/types'
import { createLineReader } from '../../shared/jsonl'
import { tail } from '../../shared/text'
import { OUTPUT_TAIL_LIMIT } from './constants'
import { createAcpClient, feedLine, type AcpClient } from './acp'
import { errMsg } from './process'

/** 接线后的句柄：ACP 客户端 + 进程状态 + 终止入口 */
export interface AcpLink {
  acp: AcpClient
  /** stderr 尾部（诊断用，已截尾） */
  stderr(): string
  /** 子进程是否已退出 */
  closed(): boolean
  /** 退出码（未退出或被信号结束为 null） */
  exitCode(): number | null
  /** spawn 级错误（onError）；没有为 null */
  error(): Error | null
  /** 进程退出或 spawn 出错时 resolve（不 reject） */
  readonly exited: Promise<void>
  /** 杀进程树（拿不到 pid 时退回 child.kill） */
  kill(signal: NodeJS.Signals): void
}

export interface AcpLinkHandlers {
  onRequest?: (method: string, params: Record<string, unknown>) => Record<string, unknown> | null
  onNotify?: (method: string, params: Record<string, unknown>) => void
}

/** 把已 spawn 的子进程接成 ACP 客户端 */
export function connect(sdk: Sdk, child: Spawned, handlers: AcpLinkHandlers = {}): AcpLink {
  let stderrText = ''
  let closed = false
  let code: number | null = null
  let spawnError: Error | null = null
  // 同步在下面的 Promise 执行器里赋值；`!` 只让 TS 认这次同步赋值，不引入运行时占位函数
  let finishExit!: () => void
  const exited = new Promise<void>((resolve) => {
    finishExit = resolve
  })

  const acp = createAcpClient({
    write: (frame) => {
      try {
        child.stdin?.write(JSON.stringify(frame) + '\n')
        return true
      } catch {
        // stdin 已关闭：写帧失败由调用点按失败收口
        return false
      }
    },
    onRequest: handlers.onRequest,
    onNotify: handlers.onNotify,
  })

  const lines = createLineReader((line) => {
    feedLine(acp, line)
  })

  child.stdout?.on('data', (chunk: Buffer | string) => {
    lines.push(chunk.toString())
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrText = tail(stderrText + chunk.toString(), OUTPUT_TAIL_LIMIT)
  })
  child.onError((error) => {
    spawnError = error
    acp.dispose(`子进程出错：${errMsg(error)}`)
    finishExit()
  })
  child.onClose((exitCode) => {
    closed = true
    code = exitCode
    lines.flush()
    acp.dispose('子进程已退出')
    finishExit()
  })

  return {
    acp,
    stderr: () => stderrText,
    closed: () => closed,
    exitCode: () => code,
    error: () => spawnError,
    exited,
    kill: (signal) => {
      if (child.pid !== undefined) sdk.process.killTree(child.pid, signal)
      else child.kill(signal)
    },
  }
}

/** 等 `task` 完成但最多等 `timeoutMs`；返回是否按时完成（提前完成时清掉定时器，不留悬挂） */
async function waitOrTimeout(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  // 句柄同步在下面的执行器里赋值；`!` 只让 TS 认这次同步赋值，`finally` 里无条件清
  let timer!: ReturnType<typeof setTimeout>
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([task.then(() => true), expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 结束一次性进程（probe / models 用完的 `hermes acp`）：
 * 先 SIGTERM，宽限内没退就 SIGKILL，然后返回（不等 close，也不留常驻进程）。
 */
export async function stopLink(link: AcpLink, graceKillMs: number): Promise<void> {
  if (link.closed()) return
  link.kill('SIGTERM')
  const exited = await waitOrTimeout(link.exited, graceKillMs)
  if (!exited) link.kill('SIGKILL')
}
