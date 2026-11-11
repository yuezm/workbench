/**
 * dsh 一轮执行（dsh 专属）：启动 `dsh --profile <p> --stdio`，写 execute 帧，读事件帧。
 *
 * - 超时/取消都走同一套 cancel 协议：cancel 帧 → 宽限 → SIGTERM → SIGKILL。
 * - 不抛异常：spawn 失败、协议错误、超时都归一成回执。
 * - `result=timeout` 在插件内折成 `Receipt{status:'failed', errorCode:'timeout'}`
 *   （回执状态只有三种终态，timeout 靠 errorCode 区分）。
 * - 续接被拒的重试不在插件里：插件只上报 `resumeRejected` 标志，宿主包装层负责
 *   换新会话 + 完整历史重试一次（D6）。
 */
import type { RunErrorCode, RunEvent, RunUsage } from '../../../protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../protocol/executor'
import type { ExecutorContext } from '../../../sdk/types'
import { createLineReader, parseFrame } from '../../shared/jsonl'
import { parseModelId } from '../../shared/model-id'
import { applyReceiptBlock } from '../../shared/receipt-block'
import type { ReceiptBlock } from '../../shared/receipt-fields'
import { applyReceiptFields } from '../../shared/receipt-fields'
import { dshReceiptMcpServers } from '../../shared/receipt-mcp-config'
import { mapResultStatus, type NormalizedRunStatus } from '../../shared/status'
import { tail, withStderr } from '../../shared/text'
import {
  CANCEL_GRACE_MS,
  DSH_PROTOCOL_VERSION,
  KILL_GRACE_MS,
  OUTPUT_TAIL_LIMIT,
  RUN_TIMEOUT_MS,
} from './constants'
import { handleFrame, type DshFrame, type DshRunState } from './frames'
import { dshEnv, errMsg, startProcess, type DshOptions } from './process'

export type { DshOptions } from './process'

/** 一个 run 归一后的终态（插件内部；timeout 尚未折成回执状态） */
interface DshRunOutcome {
  status: NormalizedRunStatus
  /** 最终文本：result 帧 output 优先，否则为 text 帧累计 */
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  exitCode: number | null
  sessionId: string | null
  /** 续接的会话已失效（宿主据此换新会话重试一次） */
  resumeRejected: boolean
  usage: RunUsage
  durationMs: number
  /** 工具通道拿到的回执（M24）；null = 模型没调回执工具，交给文本通道 */
  toolReceipt: ReceiptBlock | null
}

const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** 一个 run 的定时器容器：超时 / 取消宽限 / 强杀（缺省表示未设置） */
export interface ExecutorTimers {
  timeout?: ReturnType<typeof setTimeout>
  cancelGrace?: ReturnType<typeof setTimeout>
  kill?: ReturnType<typeof setTimeout>
}

/**
 * 清理 run 的全部定时器（未设置的定时器跳过）。
 *
 * 导出到模块级：「定时器没设置」这条防御分支在正常运行时不可达（`finish()` 的触发点
 * 都在 `timers.timeout = setTimeout(...)` 之后），导出后由单测直接构造输入覆盖
 * （逻辑与调用点均不变）。
 */
export function clearExecutorTimers(timers: ExecutorTimers): void {
  if (timers.timeout !== undefined) clearTimeout(timers.timeout)
  if (timers.cancelGrace !== undefined) clearTimeout(timers.cancelGrace)
  if (timers.kill !== undefined) clearTimeout(timers.kill)
}

/** 插件终态 → 回执（timeout 折成 failed + errorCode='timeout'） */
function toReceipt(turn: Turn, outcome: DshRunOutcome): Receipt {
  const receipt: Receipt = {
    status: outcome.status === 'timeout' ? 'failed' : outcome.status,
    leaseId: turn.leaseId,
    turn: turn.turn,
    output: outcome.output,
    usage: outcome.usage,
    durationMs: outcome.durationMs,
  }
  if (outcome.sessionId !== null) receipt.sessionId = outcome.sessionId
  if (outcome.error !== null) receipt.error = outcome.error
  if (outcome.errorCode !== null) receipt.errorCode = outcome.errorCode
  if (outcome.exitCode !== null) receipt.exitCode = outcome.exitCode
  if (outcome.resumeRejected) receipt.resumeRejected = true
  // 回执块：先按文本通道（result 帧的最终 output）解析，再用工具通道覆盖——
  // 结构化参数优先，模型没调工具时行为与 M4 完全一致。两条通道都不改终态与 output。
  applyReceiptBlock(receipt, outcome.output)
  if (outcome.toolReceipt !== null) applyReceiptFields(receipt, outcome.toolReceipt)
  return receipt
}

/** 失败终态（无 result 帧时的归一分支） */
function failureOutcome(
  base: Omit<DshRunOutcome, 'status' | 'errorCode' | 'error'>,
  errorCode: RunErrorCode,
  message: string,
): DshRunOutcome {
  return {
    ...base,
    status:
      errorCode === 'timeout' ? 'timeout' : errorCode === 'cancelled' ? 'cancelled' : 'failed',
    errorCode,
    error: message,
  }
}

/**
 * 执行一次任务：返回回执（不抛异常）。
 *
 * `options` 只用于测试覆盖超时/宽限；生产取 `constants.ts` 的缺省。
 */
export async function executeDshRun(
  ctx: ExecutorContext,
  turn: Turn,
  io: ExecutorIO,
  options: DshOptions = {},
): Promise<Receipt> {
  const { sdk, runtime } = ctx
  const started = sdk.now()
  const usage = emptyUsage()
  const timeoutMs = turn.timeoutMs > 0 ? turn.timeoutMs : (options.timeouts?.run ?? RUN_TIMEOUT_MS)

  if (turn.signal.aborted) {
    return toReceipt(turn, {
      status: 'cancelled',
      output: '',
      error: '已取消',
      errorCode: 'cancelled',
      exitCode: null,
      sessionId: null,
      resumeRejected: false,
      usage,
      durationMs: 0,
      toolReceipt: null,
    })
  }

  const model = runtime.model
  const modelSelection = model ? parseModelId(model) : null
  if (model && !modelSelection) {
    return toReceipt(turn, {
      status: 'failed',
      output: '',
      error: `模型 id 格式不对（应为 provider/model）：${model}`,
      errorCode: 'run_failed',
      exitCode: null,
      sessionId: null,
      resumeRejected: false,
      usage,
      durationMs: 0,
      toolReceipt: null,
    })
  }

  // D10：运行时 workdir 优先；turn.cwd 可能为空串（workdir 为 null 时内核记 ''）。
  // dsh 协议要求 execute.cwd 必须是非空绝对路径，不能省略，所以最后回落到宿主默认目录
  // （main 启动时解析 `WORKBENCH_WORKDIR` / `~/.workbench` 并注入 `sdk.paths.cwd`）。
  const cwd = runtime.workdir ?? (turn.cwd || sdk.paths.cwd)
  const launched = startProcess(
    sdk,
    runtime.command,
    ['--profile', runtime.profile, '--stdio'],
    cwd,
    dshEnv(runtime.permissionMode, sdk.paths.sessionRoot),
  )
  if (!launched.process) {
    return toReceipt(turn, {
      status: 'failed',
      output: '',
      error: launched.error ?? '启动失败',
      errorCode: 'spawn_failed',
      exitCode: null,
      sessionId: null,
      resumeRejected: false,
      usage,
      durationMs: 0,
      toolReceipt: null,
    })
  }
  const child = launched.process
  // pid 是崩溃对账的唯一线索：spawn 成功就立刻上报（拿不到 pid 的平台放弃登记）
  if (child.pid !== undefined) io.process?.(child.pid)
  const state: DshRunState = {
    ready: false,
    sessionId: null,
    protocolError: '',
    text: '',
    usage,
    receipt: null,
    result: null,
  }

  let seq = 0
  const emit = (event: Omit<RunEvent, 'seq'>): void => {
    seq += 1
    try {
      io.emit({ ...event, seq })
    } catch {
      // 订阅方异常不能打断协议读取
    }
  }

  const writeFrame = (frame: Record<string, unknown>): boolean => {
    try {
      child.stdin?.write(JSON.stringify(frame) + '\n')
      return true
    } catch {
      // stdin 已关闭：写帧失败由调用点按启动失败收口
      return false
    }
  }

  const requestId = turn.leaseId

  return await new Promise<Receipt>((resolve) => {
    let settled = false
    let closed = false
    let exitCode: number | null = null
    let stderrText = ''
    let timedOut = false
    let cancelRequested = false
    let spawnError: Error | null = null
    // 定时器集中放在可写容器里：finish/terminate 互相引用，便于统一清理
    const timers: ExecutorTimers = {}

    const lines = createLineReader((line) => {
      const frame = parseFrame<DshFrame>(line)
      if (!frame) return
      handleFrame(frame, requestId, state, emit)
    })

    const terminate = (): void => {
      if (closed) return
      cancelRequested = true
      writeFrame({ v: DSH_PROTOCOL_VERSION, type: 'cancel', request_id: requestId })
      timers.cancelGrace = setTimeout(() => {
        if (closed) return
        if (child.pid !== undefined) sdk.process.killTree(child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
        timers.kill = setTimeout(() => {
          if (closed) return
          if (child.pid !== undefined) sdk.process.killTree(child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        }, options.grace?.kill ?? KILL_GRACE_MS)
      }, options.grace?.cancel ?? CANCEL_GRACE_MS)
    }

    const onAbort = (): void => terminate()

    /** 归一终态：result 帧优先，其次按取消/超时/协议错误/退出码判定 */
    const buildOutcome = (): DshRunOutcome => {
      const output = state.result?.output ? state.result.output : state.text
      const sessionId = state.result?.sessionId ?? state.sessionId
      const base = {
        output,
        exitCode,
        sessionId,
        resumeRejected: state.result?.resumeRejected ?? false,
        usage,
        durationMs: sdk.now() - started,
        toolReceipt: state.receipt,
      }
      if (state.result) {
        const status = mapResultStatus(state.result.status)
        const errorCode: RunErrorCode | null =
          status === 'succeeded'
            ? null
            : status === 'cancelled'
              ? 'cancelled'
              : status === 'timeout'
                ? 'timeout'
                : 'run_failed'
        const message =
          status === 'succeeded'
            ? null
            : state.result.error ||
              state.protocolError ||
              (status === 'cancelled'
                ? '已取消'
                : `执行未成功（status=${state.result.status ?? '空'}）`)
        return {
          ...base,
          status,
          errorCode,
          error: message,
        }
      }

      if (timedOut) return failureOutcome(base, 'timeout', `运行超时（${timeoutMs}ms）`)
      if (cancelRequested) return failureOutcome(base, 'cancelled', '已取消')
      if (spawnError) {
        return failureOutcome(base, 'spawn_failed', withStderr(errMsg(spawnError), stderrText))
      }
      if (state.protocolError) {
        return failureOutcome(base, 'protocol_error', withStderr(state.protocolError, stderrText))
      }
      if (!state.ready) {
        return failureOutcome(
          base,
          'protocol_error',
          withStderr('运行时协议未就绪进程就退出了（profile 是否支持 --stdio？）', stderrText),
        )
      }
      if (exitCode !== null && exitCode !== 0) {
        return failureOutcome(base, 'exit_nonzero', withStderr(`退出码 ${exitCode}`, stderrText))
      }
      return failureOutcome(base, 'no_result', withStderr('进程结束但没有返回终态结果', stderrText))
    }

    const finish = (): void => {
      if (settled) return
      settled = true
      clearExecutorTimers(timers)
      turn.signal.removeEventListener('abort', onAbort)
      try {
        child.stdin?.end()
      } catch {
        // 管道已关闭：无需收尾
      }
      const outcome = buildOutcome()
      if (outcome.sessionId !== null) io.session?.(outcome.sessionId)
      resolve(toReceipt(turn, outcome))
    }

    timers.timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      lines.push(chunk.toString())
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrText = tail(stderrText + chunk.toString(), OUTPUT_TAIL_LIMIT)
    })
    child.onError((error) => {
      spawnError = error
      finish()
    })
    child.onClose((code) => {
      closed = true
      exitCode = code
      lines.flush()
      finish()
    })
    turn.signal.addEventListener('abort', onAbort, { once: true })

    const executeFrame: Record<string, unknown> = {
      v: DSH_PROTOCOL_VERSION,
      type: 'execute',
      request_id: requestId,
      prompt: turn.prompt,
      // M24：拿得到回执工具 server 才注入（默认关，见 receipt-mcp-config）；
      // 注入不成功时退回 []，纯文本通道照常工作
      mcp_servers: dshReceiptMcpServers(sdk.paths.receiptTool),
    }
    if (cwd !== undefined) executeFrame.cwd = cwd
    if (modelSelection) executeFrame.model = modelSelection
    if (runtime.reasoningEffort) executeFrame.reasoning_effort = runtime.reasoningEffort
    if (turn.resumeSessionId) executeFrame.resume_session_id = turn.resumeSessionId
    if (!writeFrame(executeFrame)) {
      // 写不进去（子进程已退）：按启动失败收口，避免悬挂
      spawnError = new Error('无法写入 execute 帧（子进程已退出）')
      if (child.pid !== undefined) sdk.process.killTree(child.pid)
      else child.kill('SIGKILL')
      finish()
    }
  })
}
