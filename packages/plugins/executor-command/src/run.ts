/**
 * `command` 执行器一轮执行（D12 / M42）：解析步骤 → 逐条 spawn → 汇总回执。
 *
 * 安全约定：
 * - 提示词只能作为**独立 argv 元素**（模板含 `{prompt}` 时）或走 stdin；
 *   绝不拼进任何命令字符串，也不经过 shell。
 * - Windows 的 `.cmd/.bat` 固定包装成 `cmd.exe /c <脚本> <参数...>`，`shell:false`；
 *   `cmd.exe` 会重新解析命令行，因此批处理脚本**禁止**用 `{prompt}` 传提示词
 *   （BatBadBut / CVE-2024-27980 类别），提示词只能走 stdin。
 * - 不抛异常：模板非法、解析不到可执行文件、spawn 抛错、非零退出、超时、取消
 *   都归一成回执。
 *
 * 步骤（M42 脚本阶段）：`turn.steps` 是同一条连接上的 N 组 argv，按顺序执行；每步跑完
 * 产一条 `checks`（`cmd` = 步骤标签），`acceptance` 原样带回给闸门核对。整轮的
 * `timeoutMs` 是所有步骤共用的预算，任何一步超时即整轮「没跑完」。
 */
import type { GateCheck, RunErrorCode, RunEvent, RunUsage } from '@workbench/protocol/entities'
import type { ExecutorIO, Receipt, Turn, TurnStep } from '@workbench/protocol/executor'
import type { ExecutorContext, Spawned } from '@workbench/capabilities/types'
import { expandArgs, parseArgsTemplate } from '@workbench/plugins-kit/argv'
import { errMsg } from '@workbench/plugins-kit/executor-kit'
import { applyReceiptBlock } from '@workbench/plugins-kit/receipt-block'
import { tail, withStderr } from '@workbench/plugins-kit/text'

/** 运行默认超时（`turn.timeoutMs <= 0` 时兜底，与 dsh 执行器同口径） */
const DEFAULT_TIMEOUT_MS = 30 * 60_000
/** stderr 诊断保留的尾部字符数 */
const STDERR_TAIL_LIMIT = 4_000
/** 证据标签上限：与协议层 `checkGateCheck` 的 cmd 口径（500）留出余量 */
const CMD_LABEL_LIMIT = 500
/** Windows 命令脚本后缀：需要固定包装（大小写不敏感） */
const CMD_SCRIPT_RE = /\.(cmd|bat)$/i
/**
 * 批处理脚本不接受 `{prompt}`：`cmd.exe` 不遵循 MSVCRT 引号规则，会重新解析命令行，
 * 提示词里的 `& | > ^ " %VAR%` 可能被二次解释（BatBadBut / CVE-2024-27980 类别）。
 */
const BATCH_PROMPT_UNSUPPORTED =
  'Windows .cmd/.bat 不能用 {prompt} 传提示词（cmd.exe 会重新解析参数）；请从参数模板移除 {prompt}，提示词将经 stdin 传入'
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
  /** 脚本轮的逐条证据（每步一条）；智能体轮不产 */
  checks?: GateCheck[]
}

/**
 * 一步的结局：正常跑完（带退出码）/ 超时 / 取消 / 起不来 / 异常结束。
 *
 * 判别联合而不是「退出码可空 + 原因可空」：调用方按 `ended` 窄化后拿到的都是实值，
 * 不需要 `?? 0` / `?? '启动失败'` 这类永远走不到的兜底分支。
 */
type StepOutcome =
  | { ended: 'done'; output: string; stderr: string; exitCode: number; error: '' }
  | {
      ended: 'timeout' | 'cancelled' | 'spawn_failed' | 'run_failed'
      output: string
      stderr: string
      exitCode: null
      /** 失败原因（带 stderr 尾部），落回执的 `error` */
      error: string
    }

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
  // 回执块：command 从 stdout（最终 output）解析，失败不改终态与 output
  applyReceiptBlock(receipt, outcome.output)
  // 脚本轮：逐条退出码由执行器实测，覆盖脚本自报的 `checks`（自报的只当诊断材料）
  if (outcome.checks !== undefined) receipt.checks = outcome.checks
  return receipt
}

/** Windows 命令脚本（`.cmd/.bat`）需要 `cmd.exe /c` 固定包装 */
const isWindowsCommandScript = (file: string): boolean =>
  WINDOWS_PATH_RE.test(file) && CMD_SCRIPT_RE.test(file)

/**
 * 一步的证据标签：有 `label` 用 label，否则用「可执行文件 + 参数」拼；
 * 两者都截断到协议层 `checks[].cmd` 的长度上限内。
 */
function stepLabel(command: string, step: TurnStep): string {
  const text = step.label.trim() !== '' ? step.label.trim() : [command, ...step.args].join(' ')
  return text.length > CMD_LABEL_LIMIT ? text.slice(0, CMD_LABEL_LIMIT) : text
}

/** 步骤来源：脚本轮用 `turn.steps`；智能体轮把运行时模板展开成唯一一步。 */
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

  // 插件只防御非法 JSON：项数/长度/占位符白名单由协议层与 IPC 拒绝。
  // M42：脚本轮给 `steps`（逐项原样传参）；智能体轮把运行时模板展开成唯一一步。
  let steps: TurnStep[]
  let promptInArgs = false
  if (turn.steps !== undefined) {
    steps = [...turn.steps]
  } else {
    let template: string[]
    try {
      template = parseArgsTemplate(runtime.argsTemplate)
    } catch (error) {
      return report({ status: 'failed', output: '', error: errMsg(error), errorCode: 'run_failed' })
    }
    const expanded = expandArgs(template, {
      // 占位符 {model} 保持 `provider/model` 原文（与配置里写的形态一致）
      model: turn.model ? `${turn.model.provider}/${turn.model.id}` : '',
      effort: turn.effort ?? '',
      cwd: turn.cwd || sdk.paths.cwd || '',
      context: turn.contextFile ?? '',
      prompt: turn.prompt,
    })
    steps = [{ label: '', args: expanded.args }]
    promptInArgs = expanded.promptInArgs
  }
  const isScript = turn.steps !== undefined

  // M40 / M42：命令只来自运行时连接——脚本阶段给的是步骤，不给可执行文件
  const commandName = runtime.command
  const resolved = sdk.process.resolve(commandName)
  if (!resolved.path) {
    return report({
      status: 'failed',
      output: '',
      error: resolved.error ?? `找不到可执行文件：${commandName}`,
      errorCode: 'spawn_failed',
    })
  }

  // cwd 由内核按「项目文件夹 > 目标的工作目录」写进 run.cwd；空串回落到宿主默认目录
  // （不把空串传给 spawn，避免 ENOENT）
  const cwd = turn.cwd || sdk.paths.cwd
  const command = resolved.path
  // 安全：批处理脚本经 cmd.exe 执行时，argv 仍会被 cmd.exe 重新解析；提示词只允许走 stdin。
  if (isWindowsCommandScript(command) && promptInArgs) {
    return report({
      status: 'failed',
      output: '',
      error: BATCH_PROMPT_UNSUPPORTED,
      errorCode: 'run_failed',
    })
  }

  // 整轮预算：所有步骤共用（M42）；到点即整轮「没跑完」，不再开新步骤
  const budgetMs =
    turn.timeoutMs > 0 ? turn.timeoutMs : (options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)
  const deadline = started + budgetMs
  const runAll = turn.runAll !== false

  let seq = 0
  const emit = (event: Omit<RunEvent, 'seq'>): void => {
    seq += 1
    try {
      io.emit({ ...event, seq })
    } catch {
      // 订阅方异常不能打断执行
    }
  }

  let output = ''
  const checks: GateCheck[] = []
  /** 首个非 0 步骤：退出码 + 带 stderr 尾部的失败原因（整轮按它落 `error` / `exitCode`） */
  let first: { code: number; error: string } | null = null
  /** 脚本轮才产证据：智能体轮的回执 `checks` 由执行器自己（回执块）给 */
  const evidence = (): GateCheck[] | undefined => (isScript ? checks : undefined)

  for (const [index, step] of steps.entries()) {
    if (turn.signal.aborted) {
      return report({
        status: 'cancelled',
        output,
        error: '已取消',
        errorCode: 'cancelled',
        exitCode: null,
        checks: evidence(),
      })
    }
    const remaining = deadline - sdk.now()
    if (remaining <= 0) {
      return report({
        status: 'failed',
        output,
        error: `运行超时（${budgetMs}ms）`,
        errorCode: 'timeout',
        exitCode: null,
        checks: evidence(),
      })
    }
    // 多步时把「这一步在跑什么」写进输出（output.md 的段头）与事件流
    if (steps.length > 1) {
      const header = `## ${stepLabel(command, step)}\n\n`
      output += header
      emit({ type: 'text', text: header })
    }

    const outcome = await runStep({
      step,
      index,
      command,
      cwd,
      env: turn.env ?? {},
      timeoutMs: remaining,
      // 提示词是资料：只喂第一步（脚本读 stdin 的老行为），模板含 {prompt} 时不写
      stdin: promptInArgs || index > 0 || turn.prompt === '' ? null : turn.prompt,
      sdk,
      io,
      signal: turn.signal,
      emit,
    })
    output += outcome.output
    // 非正常结束：按结局收口（cancelled 与 failed 分两条），保留已跑完步骤的证据
    if (outcome.ended !== 'done') {
      if (outcome.ended === 'cancelled') {
        return report({
          status: 'cancelled',
          output,
          error: outcome.error,
          errorCode: 'cancelled',
          exitCode: null,
          checks: evidence(),
        })
      }
      return report({
        status: 'failed',
        output,
        error: outcome.error,
        errorCode: outcome.ended,
        exitCode: null,
        checks: evidence(),
      })
    }

    const exitCode = outcome.exitCode
    if (isScript) {
      checks.push({
        cmd: stepLabel(command, step),
        exitCode,
        ...(step.acceptance === undefined ? {} : { acceptance: step.acceptance }),
      })
    }
    if (exitCode !== 0) {
      if (first === null) {
        first = {
          code: exitCode,
          error: withStderr(`退出码 ${exitCode}`, outcome.stderr, STDERR_TAG),
        }
      }
      // 「首个失败即停」：后面的步骤不再跑（证据不全，闸门会显示少了哪条）
      if (!runAll) break
    }
  }

  if (first !== null) {
    return report({
      status: 'failed',
      output,
      error: first.error,
      errorCode: 'exit_nonzero',
      exitCode: first.code,
      checks: evidence(),
    })
  }
  return report({ status: 'succeeded', output, exitCode: 0, checks: evidence() })
}

/** 一次 spawn 的入参（从 `executeCommandRun` 的闭包里拆出来，便于按步骤复用）。 */
interface StepRun {
  step: TurnStep
  index: number
  command: string
  cwd?: string
  env: Record<string, string>
  /** 本步可用时间（整轮预算的剩余）；到点强杀并归成 timeout */
  timeoutMs: number
  /** 要写进 stdin 的文本；null = 不写（模板已含 {prompt} / 非第一步 / 空串） */
  stdin: string | null
  sdk: ExecutorContext['sdk']
  io: ExecutorIO
  signal: AbortSignal
  emit: (event: Omit<RunEvent, 'seq'>) => void
}

/**
 * 跑一步：spawn → 收 stdout/stderr → 等 close，把超时 / 取消 / 起不来都归成 `StepOutcome`。
 *
 * 不抛异常；pid 一拿到就上报（崩溃对账的唯一线索）。
 */
async function runStep(run: StepRun): Promise<StepOutcome> {
  const { sdk, io, signal } = run
  const step = run.step
  let child: Spawned
  try {
    child = isWindowsCommandScript(run.command)
      ? // 固定包装：脚本路径与参数都作为 cmd.exe 的独立参数（此时 argv 内不得有提示词）
        sdk.process.spawn('cmd.exe', ['/c', run.command, ...step.args], {
          cwd: run.cwd,
          env: run.env,
          shell: false,
        })
      : sdk.process.spawn(run.command, [...step.args], {
          cwd: run.cwd,
          env: run.env,
          shell: false,
        })
  } catch (error) {
    return {
      ended: 'spawn_failed',
      output: '',
      stderr: '',
      exitCode: null,
      error: `启动失败：${errMsg(error)}`,
    }
  }
  if (child.pid !== undefined) {
    try {
      io.process?.(child.pid)
    } catch {
      // 旁路通道异常不影响执行
    }
  }

  return await new Promise<StepOutcome>((resolve) => {
    let settled = false
    let exitCode: number | null = null
    let signalName: string | null = null
    let stdoutText = ''
    let stderrText = ''
    let timedOut = false
    let cancelRequested = false
    let spawnError: Error | null = null

    const terminate = (): void => {
      if (child.pid !== undefined) sdk.process.killTree(child.pid)
      else child.kill('SIGKILL')
    }

    const onAbort = (): void => {
      cancelRequested = true
      terminate()
    }

    const withErr = (message: string): string => withStderr(message, stderrText, STDERR_TAG)

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      signal.removeEventListener('abort', onAbort)
      try {
        child.stdin?.end()
      } catch {
        // 管道已关闭：无需收尾
      }
      if (timedOut) {
        resolve({
          ended: 'timeout',
          output: stdoutText,
          stderr: stderrText,
          exitCode: null,
          error: withErr(`运行超时（${run.timeoutMs}ms）`),
        })
        return
      }
      if (cancelRequested) {
        resolve({
          ended: 'cancelled',
          output: stdoutText,
          stderr: stderrText,
          exitCode: null,
          error: '已取消',
        })
        return
      }
      if (spawnError) {
        resolve({
          ended: 'spawn_failed',
          output: stdoutText,
          stderr: stderrText,
          exitCode: null,
          error: withErr(errMsg(spawnError)),
        })
        return
      }
      if (exitCode === null) {
        resolve({
          ended: 'run_failed',
          output: stdoutText,
          stderr: stderrText,
          exitCode: null,
          error: withErr(`进程异常结束${signalName === null ? '' : `（signal=${signalName}）`}`),
        })
        return
      }
      resolve({ ended: 'done', output: stdoutText, stderr: stderrText, exitCode, error: '' })
    }

    // 超时定时器先于监听建立；回调只标记超时并终止，归一在 finish 里统一做
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, run.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdoutText += text
      run.emit({ type: 'text', text })
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
    signal.addEventListener('abort', onAbort, { once: true })

    if (run.stdin !== null) {
      // 模板没有 {prompt}：提示词只经 stdin 传给子进程，不进 argv。
      // M40：脚本轮的提示词只是资料，可能为空——空串不写 stdin（脚本秒退时管道已关，
      // 写入会抛错并被当成 spawn_failed）。
      try {
        child.stdin?.write(run.stdin)
        child.stdin?.end()
      } catch (error) {
        spawnError = new Error(`写入 stdin 失败：${errMsg(error)}`)
        terminate()
        finish()
      }
    }
  })
}
