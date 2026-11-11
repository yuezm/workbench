/**
 * hermes 一轮执行（hermes 专属）：`hermes acp` + ACP over stdio。
 *
 * 时序：spawn → initialize（校验 protocolVersion）→ session/load（续接）或 session/new
 * → session/set_mode + session/set_model → session/prompt → 归一终态。
 *
 * - 不抛异常：spawn 失败、协议错误、RPC 错误、超时、取消都归一成回执。
 * - 取消/超时走 ACP 语义：先发 `session/cancel` 通知，等 `CANCEL_GRACE_MS` 仍未退出就
 *   SIGTERM，再等 `KILL_GRACE_MS` 就 SIGKILL；`turn.signal` abort 走同一条链。
 * - `timeout` 在插件内折成 `Receipt{status:'failed', errorCode:'timeout'}`
 *   （回执状态只有三种终态，timeout 靠 errorCode 区分）。
 * - 续接被拒的重试不在插件里：插件只上报 `resumeRejected` 标志，宿主包装层负责
 *   换新会话 + 完整历史重试一次。
 */
import type { RunErrorCode, RunEvent, RunUsage } from '../../../protocol/entities'
import { permissionModeOfAccess } from '../../../protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../protocol/executor'
import type { ExecutorContext } from '../../../sdk/types'
import { applyReceiptBlock } from '../../shared/receipt-block'
import type { ReceiptBlock } from '../../shared/receipt-fields'
import { applyReceiptFields } from '../../shared/receipt-fields'
import type { NormalizedRunStatus } from '../../shared/status'
import { withStderr } from '../../shared/text'
import {
  ACP_PROTOCOL_VERSION,
  CANCEL_GRACE_MS,
  KILL_GRACE_MS,
  PROBE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
} from './constants'
import {
  applyPromptUsage,
  handleSessionUpdate,
  mapStopReason,
  decidePermission,
  STOP_REASON_NOTES,
  type HermesRunState,
} from './frames'
import { hermesManifest } from './manifest'
import { errMsg, startProcess, type HermesOptions } from './process'
import { applySessionConfig, initializeAcp, openSession, type AcpSessionState } from './session'
import { connect } from './wire'

export type { HermesOptions } from './process'

/** 一个 run 归一后的终态（插件内部；timeout 尚未折成回执状态） */
interface HermesRunOutcome {
  status: NormalizedRunStatus
  /** 最终文本：agent_message_chunk 累计 */
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

/** 明确的失败（阶段内归一，不再依赖退出码） */
interface RunFailure {
  code: RunErrorCode
  message: string
}

const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** 插件终态 → 回执（timeout 折成 failed + errorCode='timeout'） */
function toReceipt(turn: Turn, outcome: HermesRunOutcome): Receipt {
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
  // 回执块：先按文本通道（最终 output）解析，再用工具通道覆盖——结构化参数优先。
  // 两条通道都不改终态与 output。
  applyReceiptBlock(receipt, outcome.output)
  if (outcome.toolReceipt !== null) applyReceiptFields(receipt, outcome.toolReceipt)
  return receipt
}

/** 失败终态（没有 stopReason 时的归一分支） */
function failureOutcome(
  base: Omit<HermesRunOutcome, 'status' | 'errorCode' | 'error'>,
  errorCode: RunErrorCode,
  message: string,
): HermesRunOutcome {
  return {
    ...base,
    status:
      errorCode === 'timeout' ? 'timeout' : errorCode === 'cancelled' ? 'cancelled' : 'failed',
    errorCode,
    error: message,
  }
}

/** 协议版本不匹配的文案（带实际收到的版本，便于排查） */
const protocolVersionMessage = (actual: number | null): string =>
  `不兼容的协议版本：${actual === null ? '缺失' : String(actual)}（需要 ${ACP_PROTOCOL_VERSION}）`

/**
 * 执行一次任务：返回回执（不抛异常）。
 *
 * `options` 只用于测试覆盖超时/宽限；生产取 `constants.ts` 的缺省。
 */
export async function executeHermesRun(
  ctx: ExecutorContext,
  turn: Turn,
  io: ExecutorIO,
  options: HermesOptions = {},
): Promise<Receipt> {
  const { sdk, runtime } = ctx
  const started = sdk.now()
  const usage = emptyUsage()
  const handshakeTimeout = options.timeouts?.probe ?? PROBE_TIMEOUT_MS
  const requestTimeout = options.timeouts?.request ?? REQUEST_TIMEOUT_MS
  const graceCancel = options.grace?.cancel ?? CANCEL_GRACE_MS
  const graceKill = options.grace?.kill ?? KILL_GRACE_MS
  const timeoutMs = turn.timeoutMs > 0 ? turn.timeoutMs : (options.timeouts?.run ?? RUN_TIMEOUT_MS)
  const resumeSessionId = turn.resumeSessionId ?? null

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

  // 执行配置来自智能体（宿主已折算进 Turn）；cwd 空串回落到宿主默认目录
  const modelSelection = turn.model ?? null
  const cwd = turn.cwd || sdk.paths.cwd
  const launched = startProcess(sdk, runtime.command, ['acp'], cwd, turn.env ?? {})
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

  const state: HermesRunState = {
    sessionId: null,
    text: '',
    usage,
    toolResults: new Set<string>(),
    receipt: null,
    result: null,
    resumeRejected: false,
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

  const link = connect(sdk, child, {
    onNotify: (method, params) => {
      if (method !== 'session/update') return
      handleSessionUpdate(params, state, emit)
    },
    onRequest: (method, params) => {
      if (method !== 'session/request_permission') return null
      // 审批往返：这台机器上是常态 —— 必须回帧，否则对端会一直等
      const decision = decidePermission(params, permissionModeOfAccess(turn.access))
      sdk.log(
        `ACP 审批请求（${decision.tool || '未命名工具'}）：${
          decision.allowed ? '允许' : '拒绝'
        }；选项 ${decision.options.join(' / ') || '无'}`,
      )
      emit({
        type: 'tool_call',
        tool: decision.tool,
        callId: decision.callId,
        input: JSON.stringify({ options: decision.options }),
      })
      return decision.result
    },
  })

  // 取消/收尾的宽限定时器（超时定时器单独拿：它在首个 await 之前装好，收尾时无条件清）
  const timers: {
    cancelGrace?: ReturnType<typeof setTimeout>
    kill?: ReturnType<typeof setTimeout>
  } = {}
  let terminating = false
  let timedOut = false
  let cancelled = false
  // 同步在下面的执行器里赋值；`!` 只让 TS 认这次同步赋值，不引入运行时占位函数
  let signalStop!: () => void
  const stopSignal = new Promise<void>((resolve) => {
    signalStop = resolve
  })

  // 超时定时器在首个 await 之前装好（回调里用到下面才声明的 terminate，闭包内引用合法）：
  // 句柄是 const，收尾时无条件 clearTimeout，不需要 undefined 分支
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)

  const clearTimers = (): void => {
    clearTimeout(timeoutTimer)
    if (timers.cancelGrace !== undefined) clearTimeout(timers.cancelGrace)
    if (timers.kill !== undefined) clearTimeout(timers.kill)
  }

  /** 取消 / 超时的终止链：cancel 通知 → 宽限 → SIGTERM → 宽限 → SIGKILL */
  const terminate = (): void => {
    if (terminating || link.closed()) return
    terminating = true
    if (state.sessionId !== null) link.acp.notify('session/cancel', { sessionId: state.sessionId })
    // 让等待中的请求立即失败：取消期间到达的 update 仍走通知路径入事件流，
    // 但终态由本函数的归一结果决定，不会被后续帧改写
    link.acp.dispose('运行已终止')
    // 进程已退出时下面两条定时器会被 clearTimers 清掉，因此这里不再重复判断 closed()
    timers.cancelGrace = setTimeout(() => {
      link.kill('SIGTERM')
      timers.kill = setTimeout(() => {
        link.kill('SIGKILL')
        // 对端不吐 close 事件时不再等，避免回执悬挂
        signalStop()
      }, graceKill)
    }, graceCancel)
  }

  const onAbort = (): void => {
    cancelled = true
    terminate()
  }

  /** 正常/失败收尾：结束 stdin 并 SIGTERM；宽限内没退就 SIGKILL 后不再等 */
  const settle = (): void => {
    clearTimers()
    if (link.closed()) return
    try {
      child.stdin?.end()
    } catch {
      // 管道已关闭：无需收尾
    }
    link.kill('SIGTERM')
    timers.kill = setTimeout(() => {
      link.kill('SIGKILL')
      signalStop()
    }, graceKill)
  }

  /** 已被取消/超时/进程已退：这些情况下阶段内错误不再算「明确失败」 */
  const stopping = (): boolean => terminating || link.closed() || link.error() !== null

  turn.signal.addEventListener('abort', onAbort, { once: true })

  let failure: RunFailure | null = null
  let sessionReady = false

  try {
    const info = await initializeAcp(link.acp, hermesManifest.version, handshakeTimeout)
    if (info.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(protocolVersionMessage(info.protocolVersion))
    }

    let opened: AcpSessionState | null = null
    if (resumeSessionId !== null) {
      try {
        opened = await openSession(
          link.acp,
          { cwd, resumeSessionId, receiptTool: sdk.paths.receiptTool },
          handshakeTimeout,
        )
      } catch (error) {
        // 续接被拒：记标志交给宿主换新会话重试，本次按失败收口
        state.resumeRejected = true
        failure = {
          code: 'run_failed',
          message: withStderr(`续接会话被拒：${errMsg(error)}`, link.stderr(), 'hermes stderr'),
        }
      }
    } else {
      opened = await openSession(
        link.acp,
        { cwd, resumeSessionId: null, receiptTool: sdk.paths.receiptTool },
        handshakeTimeout,
      )
    }

    if (failure === null) {
      const sessionId = opened?.sessionId ?? resumeSessionId
      if (sessionId === null) throw new Error('session/new 没有返回 sessionId')
      state.sessionId = sessionId
      io.session?.(sessionId)
      if (opened !== null) {
        await applySessionConfig(link.acp, opened, {
          sessionId,
          permissionMode: permissionModeOfAccess(turn.access),
          model: modelSelection,
          log: (line) => sdk.log(line),
          timeoutMs: requestTimeout,
        })
      }
      // reasoningEffort：ACP 没有对应方法，`hermes acp` 也不接受 `--reasoning` 参数，
      // 因此这里不作用（拼 CLI 参数是错的：那会改启动命令而不是会话配置）
      sessionReady = true
    }
  } catch (error) {
    if (!stopping()) {
      failure = {
        code: 'protocol_error',
        message: withStderr(errMsg(error), link.stderr(), 'hermes stderr'),
      }
    }
  }

  if (sessionReady) {
    try {
      const result = await link.acp.request(
        'session/prompt',
        { sessionId: state.sessionId, prompt: [{ type: 'text', text: turn.prompt }] },
        // prompt 的等待上限留一次请求超时的余量：turn 级超时先触发，
        // 终态归 timeout（而不是被误判成 run_failed）
        timeoutMs + requestTimeout,
      )
      state.result = {
        stopReason: typeof result.stopReason === 'string' ? result.stopReason : '',
      }
      applyPromptUsage(state, result.usage)
    } catch (error) {
      if (!stopping() && !timedOut) {
        failure = {
          code: 'run_failed',
          message: withStderr(errMsg(error), link.stderr(), 'hermes stderr'),
        }
      }
    }
  }

  if (!terminating) settle()
  // 等进程退出（取消/超时链走到 SIGKILL 时由 signalStop 放行）
  await Promise.race([link.exited, stopSignal])
  clearTimers()
  turn.signal.removeEventListener('abort', onAbort)

  const stopReason = state.result?.stopReason ?? null
  const base = {
    output: state.text,
    exitCode: link.exitCode(),
    sessionId: state.sessionId,
    resumeRejected: state.resumeRejected,
    usage: state.usage,
    durationMs: sdk.now() - started,
    toolReceipt: state.receipt,
  }

  if (stopReason !== null) {
    const status = mapStopReason(stopReason)
    if (status === 'succeeded') {
      // max_tokens / max_turn_requests 算成功截断：终态 succeeded，error 只留一句说明
      return toReceipt(turn, {
        ...base,
        status,
        errorCode: null,
        error: STOP_REASON_NOTES[stopReason.trim()] ?? null,
      })
    }
    if (status === 'cancelled') {
      return toReceipt(turn, { ...base, status, errorCode: 'cancelled', error: '已取消' })
    }
    return toReceipt(
      turn,
      failureOutcome(base, 'run_failed', `执行未成功（stopReason=${stopReason || '空'}）`),
    )
  }

  if (timedOut) {
    return toReceipt(turn, failureOutcome(base, 'timeout', `运行超时（${timeoutMs}ms）`))
  }
  if (cancelled) {
    return toReceipt(turn, failureOutcome(base, 'cancelled', '已取消'))
  }
  if (failure !== null) {
    return toReceipt(turn, failureOutcome(base, failure.code, failure.message))
  }
  const spawnError = link.error()
  if (spawnError !== null) {
    return toReceipt(
      turn,
      failureOutcome(
        base,
        'spawn_failed',
        withStderr(errMsg(spawnError), link.stderr(), 'hermes stderr'),
      ),
    )
  }
  if (base.exitCode !== null && base.exitCode !== 0) {
    return toReceipt(
      turn,
      failureOutcome(
        base,
        'exit_nonzero',
        withStderr(`退出码 ${base.exitCode}`, link.stderr(), 'hermes stderr'),
      ),
    )
  }
  return toReceipt(
    turn,
    failureOutcome(
      base,
      'no_result',
      withStderr('进程结束但没有返回终态结果', link.stderr(), 'hermes stderr'),
    ),
  )
}
