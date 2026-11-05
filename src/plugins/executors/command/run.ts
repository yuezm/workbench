/**
 * `command` 执行器一轮执行（D12）：解析参数模板 → 展开 → resolve → spawn。
 *
 * 安全约定：
 * - 提示词只能作为**独立 argv 元素**（模板含 `{prompt}` 时）或走 stdin；
 *   绝不拼进任何命令字符串，也不经过 shell。
 * - Windows 的 `.cmd/.bat` 固定包装成 `cmd.exe /c <脚本> <参数...>`，`shell:false`，
 *   参数不会被 shell 二次解释。
 * - 不抛异常：模板非法、解析不到可执行文件、spawn 抛错、非零退出、超时、取消
 *   都归一成回执。
 */
import type { RunErrorCode, RunEvent, RunUsage } from '../../../protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../protocol/executor'
import type { ExecutorContext, Spawned } from '../../../sdk/types'
import { expandArgs, parseArgsTemplate, type ArgvVars } from '../../shared/argv'
import { tail, withStderr } from '../../shared/text'

/** 运行默认超时（`turn.timeoutMs <= 0` 时兜底，与 dsh 执行器同口径） */
const DEFAULT_TIMEOUT_MS = 30 * 60_000
/** stderr 诊断保留的尾部字符数 */
const STDERR_TAIL_LIMIT = 4_000
/** Windows 命令脚本后缀：需要固定包装（大小写不敏感） */
const CMD_SCRIPT_RE = /\.(cmd|bat)$/i
/**
 * Windows 路径判据：盘符路径或 UNC。
 * 插件拿不到 `process.platform`，只用 resolve 返回的绝对路径判断平台形态即可。
 */
const WINDOWS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/
/** stderr 拼接时的诊断标签 */
const STDERR_TAG = 'command stderr'

/** 插件内可覆盖的缺省（仅测试用；生产取常量缺省） */
export interface CommandOptions {
  /** `turn.timeoutMs <= 0` 时的兜底超时 */
  defaultTimeoutMs?: number
}

/** 一轮执行的归一终态（回执字段在 `toReceipt` 里补齐） */
interface CommandOutcome {
  status: 'succeeded' | 'failed' | 'cancelled'
  output: string
  error?: string
  errorCode?: RunErrorCode
  /** 未拿到退出码（超时强杀 / 信号终止）时省略 */
  exitCode?: number | null
}

/** 错误归一成可读文本（插件内通用，不依赖 node util） */
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** 归一终态 → 回执：leaseId / turn 原样带回，usage 全 0，不抛异常 */
function toReceipt(turn: Turn, outcome: CommandOutcome, durationMs: number): Receipt {
  const receipt: Receipt = {
    status: outcome.status,
    leaseId: turn.leaseId,
    turn: turn.turn,
    output: outcome.output,
    usage: emptyUsage(),
    durationMs,
  }
  if (outcome.error !== undefined) receipt.error = outcome.error
  if (outcome.errorCode !== undefined) receipt.errorCode = outcome.errorCode
  if (typeof outcome.exitCode === 'number') receipt.exitCode = outcome.exitCode
  return receipt
}

/** Windows 命令脚本（`.cmd/.bat`）需要 `cmd.exe /c` 固定包装 */
const isWindowsCommandScript = (file: string): boolean =>
  WINDOWS_PATH_RE.test(file) && CMD_SCRIPT_RE.test(file)

/**
 * 执行一次任务：返回回执（不抛异常）。
 *
 * `options` 只用于测试覆盖默认超时；生产取 `DEFAULT_TIMEOUT_MS`。
 */
export async function executeCommandRun(
  ctx: ExecutorContext,
  turn: Turn,
  io: ExecutorIO,
  options: CommandOptions = {},
): Promise<Receipt> {
  const { sdk, runtime } = ctx
  const started = sdk.now()
  const report = (outcome: CommandOutcome): Receipt => toReceipt(turn, outcome, sdk.now() - started)

  if (turn.signal.aborted) {
    return report({ status: 'cancelled', output: '', error: '已取消', errorCode: 'cancelled' })
  }

  // 插件只防御非法 JSON：项数/长度/占位符白名单由协议层与 IPC 拒绝
  let template: string[]
  try {
    template = parseArgsTemplate(runtime.argsTemplate)
  } catch (error) {
    return report({ status: 'failed', output: '', error: errMsg(error), errorCode: 'run_failed' })
  }

  const resolved = sdk.process.resolve(runtime.command)
  if (!resolved.path) {
    return report({
      status: 'failed',
      output: '',
      error: resolved.error ?? `找不到可执行文件：${runtime.command}`,
      errorCode: 'spawn_failed',
    })
  }

  // D10：运行时 workdir 优先；turn.cwd 为空串时不传给 spawn（否则 ENOENT）
  const cwd = runtime.workdir ?? (turn.cwd || undefined)
  const vars: ArgvVars = {
    model: runtime.model ?? '',
    effort: runtime.reasoningEffort ?? '',
    cwd: cwd ?? '',
    context: turn.contextFile ?? '',
    prompt: turn.prompt,
  }
  const { args, promptInArgs } = expandArgs(template, vars)
  const command = resolved.path

  let child: Spawned
  try {
    child = isWindowsCommandScript(command)
      ? // 固定包装：脚本路径与参数都作为 cmd.exe 的独立参数，不让 shell 重新解释
        sdk.process.spawn('cmd.exe', ['/c', command, ...args], { cwd, env: {}, shell: false })
      : sdk.process.spawn(command, args, { cwd, env: {}, shell: false })
  } catch (error) {
    return report({
      status: 'failed',
      output: '',
      error: `启动失败：${errMsg(error)}`,
      errorCode: 'spawn_failed',
    })
  }
  // pid 是崩溃对账的唯一线索：spawn 成功就立刻上报（拿不到 pid 的平台放弃登记）
  if (child.pid !== undefined) {
    try {
      io.process?.(child.pid)
    } catch {
      // 旁路通道异常不影响执行
    }
  }

  const timeoutMs =
    turn.timeoutMs > 0 ? turn.timeoutMs : (options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)

  return await new Promise<Receipt>((resolve) => {
    let settled = false
    let exitCode: number | null = null
    let signalName: string | null = null
    let stdoutText = ''
    let stderrText = ''
    let timedOut = false
    let cancelRequested = false
    let spawnError: Error | null = null
    let seq = 0

    const emit = (event: Omit<RunEvent, 'seq'>): void => {
      seq += 1
      try {
        io.emit({ ...event, seq })
      } catch {
        // 订阅方异常不能打断执行
      }
    }

    const terminate = (): void => {
      if (child.pid !== undefined) sdk.process.killTree(child.pid)
      else child.kill('SIGKILL')
    }

    const onAbort = (): void => {
      cancelRequested = true
      terminate()
    }

    const withErr = (message: string): string => withStderr(message, stderrText, STDERR_TAG)

    const outcomeOf = (): CommandOutcome => {
      if (timedOut) {
        return {
          status: 'failed',
          output: stdoutText,
          error: withErr(`运行超时（${timeoutMs}ms）`),
          errorCode: 'timeout',
          exitCode,
        }
      }
      if (cancelRequested) {
        return {
          status: 'cancelled',
          output: stdoutText,
          error: '已取消',
          errorCode: 'cancelled',
          exitCode,
        }
      }
      if (spawnError) {
        return {
          status: 'failed',
          output: stdoutText,
          error: withErr(errMsg(spawnError)),
          errorCode: 'spawn_failed',
          exitCode,
        }
      }
      if (exitCode === 0) {
        return { status: 'succeeded', output: stdoutText, exitCode }
      }
      if (exitCode === null) {
        return {
          status: 'failed',
          output: stdoutText,
          error: withErr(`进程异常结束${signalName === null ? '' : `（signal=${signalName}）`}`),
          errorCode: 'run_failed',
          exitCode,
        }
      }
      return {
        status: 'failed',
        output: stdoutText,
        error: withErr(`退出码 ${exitCode}`),
        errorCode: 'exit_nonzero',
        exitCode,
      }
    }

    // 超时定时器先于监听建立；回调只标记超时并终止，归一在 finish 里统一做
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      turn.signal.removeEventListener('abort', onAbort)
      try {
        child.stdin?.end()
      } catch {
        // 管道已关闭：无需收尾
      }
      resolve(toReceipt(turn, outcomeOf(), sdk.now() - started))
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdoutText += text
      emit({ type: 'text', text })
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrText = tail(stderrText + chunk.toString(), STDERR_TAIL_LIMIT)
    })
    child.onError((error) => {
      spawnError = error
      finish()
    })
    child.onClose((code, signal) => {
      exitCode = code
      signalName = signal
      finish()
    })
    turn.signal.addEventListener('abort', onAbort, { once: true })

    if (!promptInArgs) {
      // 模板没有 {prompt}：提示词只经 stdin 传给子进程，不进 argv
      try {
        child.stdin?.write(turn.prompt)
        child.stdin?.end()
      } catch (error) {
        spawnError = new Error(`写入 stdin 失败：${errMsg(error)}`)
        terminate()
        finish()
      }
    }
  })
}
