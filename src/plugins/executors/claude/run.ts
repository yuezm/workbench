/**
 * claude 一轮执行（claude 专属）：启动
 * `claude --print --output-format stream-json --verbose <flags>`，把提示词写 stdin
 * 后立刻 `end()`（不占 argv：既避开命令行长度上限，也不给提示词任何注入面），
 * 再逐行读 stdout 的 JSON 帧。
 *
 * - print 模式没有 cancel 帧可写：超时/取消统一走「SIGTERM → 宽限 → SIGKILL」杀进程树。
 * - 不抛异常：spawn 失败、超时、协议未就绪、非零退出、无终态都归一成回执。
 * - `result=timeout` 在插件内折成 `Receipt{status:'failed', errorCode:'timeout'}`
 *   （回执状态只有三种终态，timeout 靠 errorCode 区分）。
 * - 续接被拒的重试不在插件里：插件只上报 `resumeRejected` 标志，宿主包装层负责
 *   换新会话 + 完整历史重试一次（与 dsh 同口径）。
 */
import type { PermissionMode, RunErrorCode, RunEvent, RunUsage } from '../../../protocol/entities'
import { permissionModeOfAccess } from '../../../protocol/entities'
import type { ExecutorIO, Receipt, Turn } from '../../../protocol/executor'
import type { ExecutorContext } from '../../../sdk/types'
import { createLineReader, parseFrame } from '../../shared/jsonl'
import { applyReceiptBlock } from '../../shared/receipt-block'
import { mapResultStatus, type NormalizedRunStatus } from '../../shared/status'
import { tail, withStderr } from '../../shared/text'
import { KILL_GRACE_MS, OUTPUT_TAIL_LIMIT, RUN_TIMEOUT_MS } from './constants'
import { emptyUsage, handleFrame, type ClaudeFrame, type ClaudeRunState } from './frames'
import { errMsg, startProcess, type ClaudeOptions } from './process'

export type { ClaudeOptions } from './process'

/** 一个 run 归一后的终态（插件内部；timeout 尚未折成回执状态） */
interface ClaudeRunOutcome {
  status: NormalizedRunStatus
  /** 最终文本：result 帧的 result 优先，否则为 assistant text 累计 */
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  exitCode: number | null
  sessionId: string | null
  /** 续接的会话已失效（宿主据此换新会话重试一次） */
  resumeRejected: boolean
  usage: RunUsage
  durationMs: number
}

/**
 * 权限模式 → `claude --permission-mode` 取值。
 * 三个取值分别对应「只读 / 可改工作区 / 全权」；越界操作用 CLI 自己的判定。
 */
const PERMISSION_ARGS: Record<PermissionMode, string> = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'bypassPermissions',
}

/** 续接被拒的 stderr 特征（claude 找不到会话时打这几类文案） */
const RESUME_REJECT_RE = /no conversation found|session.*not found|could not find session/i

/**
 * 一轮执行配置 → CLI 参数：每个字段都是独立 argv 元素，不做 shell 拼接。
 *
 * `--permission-prompts none` 恒定追加：print 模式没有人工审批往返，提示类权限一律
 * 自动拒（越界即失败），否则进程会挂在审批上直到超时。
 */
export function claudeArgs(
  permissionMode: PermissionMode,
  model: { provider: string; id: string } | null,
  effort: string | null,
  resumeSessionId: string | null,
): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    // print + stream-json 下 --verbose 是必需的（否则 CLI 直接拒跑）
    '--verbose',
    '--permission-mode',
    PERMISSION_ARGS[permissionMode],
    '--permission-prompts',
    'none',
  ]
  // --model 只吃别名或完整模型名，不吃 provider/id：只传斜杠后那段
  if (model) args.push('--model', model.id)
  if (effort) args.push('--effort', effort)
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  return args
}

/**
 * result 帧 → 执行器内部终态。
 *
 * subtype 含 cancel/aborted（CLI 侧中止）算取消；`is_error===true` 与
 * error_max_turns / error_max_budget_usd / error_during_execution 等一律失败；
 * 其余按通用词表归一（success → succeeded，未知 → failed）。
 */
export function mapResultSubtype(
  subtype: string | undefined,
  isError: boolean,
): NormalizedRunStatus {
  const value = (subtype ?? '').trim().toLowerCase()
  if (/cancel|abort/.test(value)) return 'cancelled'
  if (isError) return 'failed'
  return mapResultStatus(value)
}

/** 插件终态 → 回执（timeout 折成 failed + errorCode='timeout'） */
function toReceipt(turn: Turn, outcome: ClaudeRunOutcome): Receipt {
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
  // 回执块：从最终 output 解析，失败不改终态与 output
  applyReceiptBlock(receipt, outcome.output)
  return receipt
}

/** 失败终态（无 result 帧时的归一分支） */
function failureOutcome(
  base: Omit<ClaudeRunOutcome, 'status' | 'errorCode' | 'error'>,
  errorCode: RunErrorCode,
  message: string,
): ClaudeRunOutcome {
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
export async function executeClaudeRun(
  ctx: ExecutorContext,
  turn: Turn,
  io: ExecutorIO,
  options: ClaudeOptions = {},
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
    })
  }

  // 执行配置来自智能体（宿主已折算进 Turn）；cwd 由内核按项目 / 智能体工作目录写进 run，
  // 空串回落到宿主默认目录（`sdk.paths.cwd` 由宿主启动时解析并注入）。
  const modelSelection = turn.model ?? null
  const cwd = turn.cwd || sdk.paths.cwd
  const resumeSessionId = turn.resumeSessionId ?? null
  const launched = startProcess(
    sdk,
    runtime.command,
    claudeArgs(
      permissionModeOfAccess(turn.access),
      modelSelection,
      turn.effort ?? null,
      resumeSessionId,
    ),
    cwd,
    turn.env ?? {},
  )
  if ('error' in launched) {
    return toReceipt(turn, {
      status: 'failed',
      output: '',
      error: launched.error,
      errorCode: 'spawn_failed',
      exitCode: null,
      sessionId: null,
      resumeRejected: false,
      usage,
      durationMs: 0,
    })
  }
  const child = launched.process
  // pid 是崩溃对账的唯一线索：spawn 成功就立刻上报（拿不到 pid 的平台放弃登记）
  if (child.pid !== undefined) io.process?.(child.pid)
  const state: ClaudeRunState = {
    ready: false,
    sessionId: null,
    cliVersion: null,
    text: '',
    usage,
    toolNames: {},
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

  const killTreeOrChild = (signal: NodeJS.Signals): void => {
    if (child.pid !== undefined) sdk.process.killTree(child.pid, signal)
    else child.kill(signal)
  }

  return await new Promise<Receipt>((resolve) => {
    let settled = false
    let closed = false
    let exitCode: number | null = null
    let stderrText = ''
    let timedOut = false
    let cancelRequested = false
    let spawnError: Error | null = null
    // 定时器集中放在可写容器里：finish/terminate 互相引用，便于统一清理
    const timers: {
      timeout?: ReturnType<typeof setTimeout>
      kill?: ReturnType<typeof setTimeout>
    } = {}

    const lines = createLineReader((line) => {
      const frame = parseFrame<ClaudeFrame>(line)
      if (!frame) return
      handleFrame(frame, state, emit)
    })

    const clearTimers = (): void => {
      // 超时定时器在建链时就位（finish 只可能在它之后触发），直接清；
      // SIGKILL 定时器只在 terminate 里排上，可能缺省，因此仍要判空
      clearTimeout(timers.timeout)
      if (timers.kill !== undefined) clearTimeout(timers.kill)
    }

    /** 终止流程：没有 cancel 帧，直接杀进程树；宽限内没退就 SIGKILL */
    const terminate = (): void => {
      if (closed) return
      cancelRequested = true
      killTreeOrChild('SIGTERM')
      timers.kill = setTimeout(() => {
        // 重复 terminate（超时与取消撞在一起）会重排本定时器，被遗弃的旧定时器仍会到点；
        // 进程已经退出时（closed 置位）不再补刀，避免对已回收的 pid 发 SIGKILL
        if (closed) return
        killTreeOrChild('SIGKILL')
      }, options.grace?.kill ?? KILL_GRACE_MS)
    }

    const onAbort = (): void => terminate()

    /** 归一终态：result 帧优先，其次按取消/超时/启动失败/协议/退出码判定 */
    const buildOutcome = (): ClaudeRunOutcome => {
      const output = state.result?.output ? state.result.output : state.text
      const sessionId = state.result?.sessionId ?? state.sessionId
      const versionTag = state.cliVersion ? `（claude ${state.cliVersion}）` : ''
      const base = {
        output,
        exitCode,
        sessionId,
        // 续接被拒：带了 resumeSessionId、没拿到 result 帧、stderr 命中会话失效特征
        resumeRejected:
          Boolean(resumeSessionId) && state.result === null && RESUME_REJECT_RE.test(stderrText),
        usage: state.usage,
        durationMs: sdk.now() - started,
      }
      if (state.result) {
        const status = mapResultSubtype(state.result.subtype ?? undefined, state.result.isError)
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
            : status === 'cancelled'
              ? '已取消'
              : withStderr(
                  `执行未成功（subtype=${state.result.subtype ?? '空'}` +
                    `${state.result.isError ? '，is_error=true' : ''}）`,
                  stderrText,
                )
        return { ...base, status, errorCode, error: message }
      }

      if (timedOut) return failureOutcome(base, 'timeout', `运行超时（${timeoutMs}ms）`)
      if (cancelRequested) return failureOutcome(base, 'cancelled', '已取消')
      if (spawnError) {
        return failureOutcome(base, 'spawn_failed', withStderr(errMsg(spawnError), stderrText))
      }
      if (!state.ready) {
        return failureOutcome(
          base,
          'protocol_error',
          withStderr('运行时协议未就绪进程就退出了（未收到 init 帧）', stderrText),
        )
      }
      if (exitCode !== null && exitCode !== 0) {
        return failureOutcome(
          base,
          'exit_nonzero',
          withStderr(`退出码 ${exitCode}${versionTag}`, stderrText),
        )
      }
      return failureOutcome(
        base,
        'no_result',
        withStderr(`进程结束但没有返回终态结果${versionTag}`, stderrText),
      )
    }

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimers()
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

    // 提示词只能走 stdin（不占 argv）：写完立刻关，CLI 读到 EOF 就开始干活
    try {
      child.stdin?.write(turn.prompt)
      child.stdin?.end()
    } catch (e) {
      // 写不进去（子进程已退）：按启动失败收口，避免悬挂
      spawnError = new Error(`无法写入提示词（子进程已退出）：${errMsg(e)}`)
      killTreeOrChild('SIGKILL')
      finish()
    }
  })
}
