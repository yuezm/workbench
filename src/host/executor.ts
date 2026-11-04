/**
 * 宿主侧执行器装配（M2 T9）：端口类型 + 通用适配器。
 *
 * 本文件只依赖 `src/protocol`（ESLint 强制 host 不 import `main` / `renderer` / `electron`）：
 * 具体执行器实现由装配根（`src/main`）注入。适配器把「后端的一轮结果」归一成
 * 执行器端口的 `Receipt`：
 *
 * - 状态归一：后端多一个 `timeout` 状态 → `failed` + `errorCode='timeout'`（SPEC-ai-workflow 的归一表）；
 * - 帧转发：后端 `onEvent` → `io.emit`（宿主按批入账 `run.frames`）；
 * - 会话回传：后端结果里的 `sessionId` → 回执 + `io.session` 旁路；
 * - 续接失败：`resume_rejected` → 清掉续接会话、用**新会话**重试一次（SPEC-plugins「executor」），
 *   仍被拒则按 `failed` 收口。
 *
 * 为什么还要 `ExecutorBackend`（而不是直接实现 `ExecutorPort`）：M2 的 dsh 适配层在
 * `main`（`RuntimeBackend.execute` 的请求/结果形状携带 `runtime` 配置与 `timeout` 状态），
 * 而 host 不能 import main；这层窄接口让适配逻辑留在 host、可单测，M3 插件直接实现
 * `ExecutorPort` 后本接口随适配层一起删除。
 */
import type { RunErrorCode, RunEvent, RunUsage } from '../protocol/entities'
import type { ExecutorIO, ExecutorPort, Turn } from '../protocol/executor'
import type { Receipt } from '../protocol/inputs'

export type { ExecutorIO, ExecutorModelOption, ExecutorPort, Turn } from '../protocol/executor'
export type { Receipt } from '../protocol/inputs'

/** 后端一轮的请求（M2 过渡契约：`main` 的 dsh 适配层实现它） */
export interface ExecutorBackendRequest {
  turn: Turn
  /** 协议 request_id：cancel 帧与结果帧用它过滤；每次尝试唯一 */
  requestId: string
  timeoutMs: number
  signal: AbortSignal
  /** 增量事件：适配器原样转给 `io.emit` */
  onEvent: (event: RunEvent) => void
  /** 子进程 pid（M2 T13）：适配器转给 `io.process`，宿主据此登记/对账 */
  onSpawn?: (pid: number) => void
}

/**
 * 后端一轮的原始结果：比 `Receipt` 宽一点（多一个 `timeout` 状态），由适配器归一成回执。
 * 失败原因文本（`error`）原样带进回执（`Receipt.error`，T6 用它重建 `runs.error` 与聊天失败文案）。
 */
export interface ExecutorBackendOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timeout'
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  exitCode: number | null
  sessionId: string | null
  /** 续接的会话已失效（适配器据此换新会话重试一次） */
  resumeRejected: boolean
  usage: RunUsage
  durationMs: number
}

/** 执行器后端（M2 的 dsh 适配层实现；M3 由插件直接实现 `ExecutorPort`） */
export interface ExecutorBackend {
  execute(request: ExecutorBackendRequest): Promise<ExecutorBackendOutcome>
}

export interface ExecutorPortOptions {
  /** 续接被拒时换新会话重试一次（默认 true） */
  retryOnResumeRejected?: boolean
  /** 一轮的协议 request_id；默认 `<runId>:<turn>:<第几次尝试>` */
  requestId?: (turn: Turn, attempt: number) => string
}

const defaultRequestId = (turn: Turn, attempt: number): string =>
  `${turn.runId}:${turn.turn}:${attempt}`

/** 后端状态 → 回执状态（`timeout` 在回执里归为 `failed`，靠 `errorCode` 区分） */
const receiptStatus = (outcome: ExecutorBackendOutcome): Receipt['status'] =>
  outcome.status === 'timeout' ? 'failed' : outcome.status

/** 失败归类的兜底：后端没给 errorCode 时按状态补一个（成功为 null） */
const errorCodeOf = (outcome: ExecutorBackendOutcome): RunErrorCode | null => {
  if (outcome.status === 'succeeded') return null
  if (outcome.errorCode !== null) return outcome.errorCode
  if (outcome.status === 'timeout') return 'timeout'
  if (outcome.status === 'cancelled') return 'cancelled'
  return 'run_failed'
}

const toReceipt = (turn: Turn, outcome: ExecutorBackendOutcome): Receipt => {
  const receipt: Receipt = {
    status: receiptStatus(outcome),
    leaseId: turn.leaseId,
    turn: turn.turn,
    output: outcome.output,
    usage: outcome.usage,
    durationMs: outcome.durationMs,
  }
  if (outcome.sessionId !== null) receipt.sessionId = outcome.sessionId
  if (outcome.error !== null) receipt.error = outcome.error
  // 聊天失败轮次没给错误文案时补「执行失败」（旧 ChatService 的文案，T14b 迁移不放松）
  else if (turn.purpose === 'chat' && receipt.status === 'failed') receipt.error = '执行失败'
  const errorCode = errorCodeOf(outcome)
  if (errorCode !== null) receipt.errorCode = errorCode
  if (outcome.exitCode !== null) receipt.exitCode = outcome.exitCode
  if (outcome.resumeRejected) receipt.resumeRejected = true
  return receipt
}

/**
 * 把一个执行器后端包装成 `ExecutorPort`。
 *
 * 适配器只做归一与一次续接重试，不做业务判断：是否该重试、重试后的终态如何归账
 * 都由内核决定（这里只把「新会话重试」这一条 SPEC 行为落在适配层）。
 */
export function createExecutorPort(
  backend: ExecutorBackend,
  options: ExecutorPortOptions = {},
): ExecutorPort {
  const retryOnResumeRejected = options.retryOnResumeRejected ?? true
  const requestIdOf = options.requestId ?? defaultRequestId

  const attempt = async (
    turn: Turn,
    io: ExecutorIO,
    resumeSessionId: string | null,
    attemptNumber: number,
    prompt: string = turn.prompt,
  ): Promise<ExecutorBackendOutcome> => {
    const outcome = await backend.execute({
      turn: { ...turn, resumeSessionId, prompt },
      requestId: requestIdOf(turn, attemptNumber),
      timeoutMs: turn.timeoutMs,
      signal: turn.signal,
      onEvent: (event) => io.emit(event),
      // 子进程 pid 是旁路信息：宿主写进 process_registry 供崩溃对账
      onSpawn: (pid) => io.process?.(pid),
    })
    // 会话 id 是旁路信息：执行器可能只通过结果帧带回来，宿主据此续接下一轮。
    if (outcome.sessionId !== null) io.session?.(outcome.sessionId)
    return outcome
  }

  return {
    async run(turn: Turn, io: ExecutorIO): Promise<Receipt> {
      const resumeSessionId = turn.resumeSessionId ?? null
      const first = await attempt(turn, io, resumeSessionId, 1)
      const shouldRetry =
        retryOnResumeRejected &&
        first.resumeRejected &&
        resumeSessionId !== null &&
        !turn.signal.aborted
      if (!shouldRetry) return toReceipt(turn, first)

      // 续接已失效：换新会话、带完整历史提示词重试一次（聊天续接轮只发新消息，
      // 重试必须回退到整段历史的 prompt，否则 CLI 看不到前文——旧 ChatService 同口径）
      const second = await attempt(turn, io, null, 2, turn.fallbackPrompt ?? turn.prompt)
      if (!second.resumeRejected) return toReceipt(turn, second)
      // 取消/超时优先于「续接仍被拒」：不把已取消的轮次改写成 failed
      if (second.status === 'cancelled' || second.status === 'timeout') {
        return toReceipt(turn, second)
      }
      // 仍被拒：按 failed 落库（SPEC-plugins「executor」：重试一次后仍失败不再重试）
      return toReceipt(turn, {
        ...second,
        status: 'failed',
        errorCode: errorCodeOf(second) ?? 'run_failed',
      })
    },
  }
}
