import type {
  RunErrorCode,
  RunEvent,
  RunUsage,
  Runtime,
  RuntimeModelOption,
  RuntimeProbe,
} from '../../../shared/ai-workflow-api'
import { needsShell, resolveExecutable } from './executable'
import {
  createLineReader,
  defaultSpawn,
  killProcessTree,
  tail,
  type SpawnFn,
  type SpawnedProcess,
} from './process'

/** dsh profile 暴露的 stdio 协议版本（与 Multica 的 DshProtocolVersion 一致） */
export const DSH_PROTOCOL_VERSION = 1
/** --probe 帧里的 runtime 标识 */
export const DSH_RUNTIME_ID = 'dsh'
/** 探测超时：冷启动要加载 profile 插件，实测可达 10s 级 */
export const PROBE_TIMEOUT_MS = 60_000
/** 读 CLI 版本超时 */
export const VERSION_TIMEOUT_MS = 15_000
/** 模型目录超时 */
export const MODELS_TIMEOUT_MS = 120_000
/** 单次运行的默认超时 */
export const RUN_TIMEOUT_MS = 30 * 60_000
/** 已发 cancel 帧后等待优雅退出的宽限 */
export const CANCEL_GRACE_MS = 3_000
/** SIGTERM 后等待退出的宽限，仍未退则 SIGKILL */
export const KILL_GRACE_MS = 2_000
/** stderr/诊断输出保留的尾部字符数 */
export const OUTPUT_TAIL_LIMIT = 4_000

export interface DshDeps {
  /** 可注入：子进程启动（测试用假进程） */
  spawn?: SpawnFn
  /** 可注入：进程树终止 */
  killTree?: (pid: number, signal?: NodeJS.Signals) => boolean
  now?: () => number
  /** 子进程环境基线（默认 process.env） */
  baseEnv?: NodeJS.ProcessEnv
  /** 会话持久化目录（MULTICA_DSH_SESSION_ROOT），用于跨轮续接 */
  sessionRoot?: string | null
  /** 超时覆盖（测试用；缺省取模块常量） */
  timeouts?: { probe?: number; version?: number; models?: number; run?: number }
  /** 取消宽限覆盖（测试用） */
  grace?: { cancel?: number; kill?: number }
}

const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

interface DshThinkingLevel {
  value?: unknown
}

interface DshModelFrame {
  id?: unknown
  label?: unknown
  provider?: unknown
  default?: unknown
  thinking?: { supported_levels?: unknown; default_level?: unknown } | null
}

interface DshFrame {
  v?: number
  type?: string
  runtime?: string
  protocol_version?: number
  plugin_version?: string
  request_id?: string
  session_id?: string
  content?: string
  call_id?: string
  name?: string
  arguments?: string
  output?: string
  is_error?: boolean
  provider?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  status?: string
  stop_reason?: string
  resume_rejected?: boolean
  error?: { code?: string; message?: string } | null
  code?: string
  message?: string
  models?: DshModelFrame[]
}

/** 一个 run 的终态（协议帧归一后的结果） */
export interface DshRunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timeout'
  /** 最终文本：result 帧 output 优先，否则为 text 帧累计 */
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  exitCode: number | null
  sessionId: string | null
  /** 续接的会话已失效（调用方可清掉本地 session 后重试一次） */
  resumeRejected: boolean
  usage: RunUsage
  durationMs: number
}

export interface DshRunRequest {
  runtime: Pick<
    Runtime,
    'command' | 'profile' | 'permissionMode' | 'model' | 'reasoningEffort' | 'workdir'
  >
  /** 协议 request_id：cancel 帧与结果帧都用它过滤 */
  requestId: string
  prompt: string
  /** 上一轮的协议会话 id（追加续接） */
  resumeSessionId?: string | null
  timeoutMs?: number
  signal: AbortSignal
  /** 事件回调（seq 由本模块递增） */
  onEvent?: (event: RunEvent) => void
}

interface Collected {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  spawnError: Error | null
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 安全解析 JSON 行；不是 JSON 或不是对象返回 null */
function parseFrame(line: string): DshFrame | null {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as DshFrame
  } catch {
    return null
  }
}

/** 把 frame.error 归一成一行文本 */
function frameErrorText(frame: DshFrame): string {
  const code = frame.error?.code?.trim() ?? ''
  const message = frame.error?.message?.trim() ?? ''
  if (code && message) return `${code}: ${message}`
  return code || message
}

/** 序列化错误码 + stderr 尾部，便于用户直接看到 CLI 的诊断 */
function withStderr(message: string, stderr: string): string {
  const tailText = stderr.trim()
  return tailText ? `${message}\n[dsh stderr]\n${tailText}` : message
}

/** 解析 provider/model 形式的模型 id；格式不对返回 null（由调用方报错） */
export function parseModelId(value: string): { provider: string; id: string } | null {
  const trimmed = value.trim()
  const index = trimmed.indexOf('/')
  if (index <= 0 || index === trimmed.length - 1) return null
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  }
  const provider = decode(trimmed.slice(0, index)).trim()
  const id = decode(trimmed.slice(index + 1)).trim()
  if (!provider || !id) return null
  return { provider, id }
}

/** 启动 dsh 子进程；解析不到可执行文件或 spawn 抛错时返回 error */
function startProcess(
  deps: Required<Pick<DshDeps, 'spawn'>> & DshDeps,
  runtime: DshRunRequest['runtime'],
  args: string[],
): { process?: SpawnedProcess; error?: string } {
  const resolved = resolveExecutable(runtime.command)
  if (!resolved.path) return { error: resolved.error ?? `找不到可执行文件：${runtime.command}` }

  const env: NodeJS.ProcessEnv = { ...(deps.baseEnv ?? process.env) }
  env.DSH_PERMISSION_MODE = runtime.permissionMode
  if (deps.sessionRoot) env.MULTICA_DSH_SESSION_ROOT = deps.sessionRoot

  try {
    const process_ = deps.spawn(resolved.path, args, {
      cwd: runtime.workdir ?? undefined,
      env,
      shell: needsShell(resolved.path),
    })
    return { process: process_ }
  } catch (e) {
    return { error: errMsg(e) }
  }
}

/**
 * 跑一个一次性命令并收集输出（--version / --probe / --list-models 共用）。
 * 不抛异常：超时、非零退出、启动失败都落进返回值。
 */
async function collect(
  deps: Required<Pick<DshDeps, 'spawn'>> & DshDeps,
  command: string,
  profile: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<Collected> {
  const resolved = resolveExecutable(command)
  if (!resolved.path) {
    return {
      stdout: '',
      stderr: '',
      code: null,
      timedOut: false,
      spawnError: new Error(resolved.error ?? `找不到可执行文件：${command}`),
    }
  }

  const args = ['--profile', profile, ...extraArgs]
  const env: NodeJS.ProcessEnv = { ...(deps.baseEnv ?? process.env) }
  let child: SpawnedProcess
  try {
    child = deps.spawn(resolved.path, args, {
      env,
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
      if (child.pid !== undefined) (deps.killTree ?? killProcessTree)(child.pid)
      else child.kill('SIGKILL')
      finish()
    }, timeoutMs)
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: tail(stderrChunks.join(''), OUTPUT_TAIL_LIMIT),
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
async function readCliVersion(
  deps: Required<Pick<DshDeps, 'spawn'>> & DshDeps,
  command: string,
  profile: string,
): Promise<string | null> {
  const collected = await collect(
    deps,
    command,
    profile,
    ['--version'],
    deps.timeouts?.version ?? VERSION_TIMEOUT_MS,
  )
  if (collected.spawnError || collected.timedOut) return null
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(collected.stdout)
  return match?.[1] ?? null
}

/** 探测：--probe 帧 + CLI 版本；结论持久化到运行时（由调用方写库） */
export async function probeDshRuntime(
  params: { command: string; profile: string },
  deps: DshDeps = {},
): Promise<RuntimeProbe> {
  const resolvedDeps = { ...deps, spawn: deps.spawn ?? defaultSpawn }
  const started = resolvedDeps.now ? resolvedDeps.now() : Date.now()
  const checkedAtMs = resolvedDeps.now ? resolvedDeps.now() : Date.now()
  const checkedAt = new Date(checkedAtMs).toISOString()
  const elapsed = (): number => (resolvedDeps.now ? resolvedDeps.now() : Date.now()) - started

  const resolved = resolveExecutable(params.command)
  if (!resolved.path) {
    return {
      state: 'unavailable',
      path: null,
      cliVersion: null,
      protocolVersion: null,
      pluginVersion: null,
      error: resolved.error ?? `找不到可执行文件：${params.command}`,
      output: '',
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  const cliVersion = await readCliVersion(resolvedDeps, params.command, params.profile)
  const collected = await collect(
    resolvedDeps,
    params.command,
    params.profile,
    ['--probe'],
    resolvedDeps.timeouts?.probe ?? PROBE_TIMEOUT_MS,
  )
  const diagnostic = tail(collected.stderr.trim() || collected.stdout.trim(), OUTPUT_TAIL_LIMIT)

  if (collected.spawnError) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion: null,
      pluginVersion: null,
      error: withStderr(`启动探测失败：${errMsg(collected.spawnError)}`, collected.stderr),
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }
  if (collected.timedOut) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion: null,
      pluginVersion: null,
      error: withStderr(
        `探测超时（${resolvedDeps.timeouts?.probe ?? PROBE_TIMEOUT_MS}ms）`,
        collected.stderr,
      ),
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  let frame: DshFrame | null = null
  for (const line of collected.stdout.split('\n')) {
    const candidate = parseFrame(line)
    if (candidate?.type === 'probe') {
      frame = candidate
      break
    }
  }

  if (!frame) {
    const reason =
      collected.code !== 0
        ? `探测退出码 ${collected.code ?? 'null'}`
        : '探测没有返回协议帧（profile 未提供 --probe？）'
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion: null,
      pluginVersion: null,
      error: withStderr(reason, collected.stderr),
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  const protocolVersion = typeof frame.protocol_version === 'number' ? frame.protocol_version : null
  if (frame.v !== DSH_PROTOCOL_VERSION || protocolVersion !== DSH_PROTOCOL_VERSION) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion,
      pluginVersion: null,
      error: `不兼容的协议版本：帧 v=${String(frame.v)}，protocol_version=${String(protocolVersion)}（需要 ${DSH_PROTOCOL_VERSION}）`,
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }
  if (frame.runtime !== DSH_RUNTIME_ID) {
    return {
      state: 'unavailable',
      path: resolved.path,
      cliVersion,
      protocolVersion,
      pluginVersion: null,
      error: `探测帧的 runtime 不是 dsh：${String(frame.runtime)}`,
      output: diagnostic,
      elapsedMs: elapsed(),
      checkedAt,
    }
  }

  return {
    state: 'ready',
    path: resolved.path,
    cliVersion,
    protocolVersion,
    pluginVersion: frame.plugin_version ?? null,
    error: null,
    output: diagnostic,
    elapsedMs: elapsed(),
    checkedAt,
  }
}

/** provider 展示名缺失时从模型 id 前缀兜底 */
function providerOf(model: DshModelFrame): string {
  if (typeof model.provider === 'string' && model.provider.trim()) return model.provider.trim()
  const id = typeof model.id === 'string' ? model.id : ''
  const index = id.indexOf('/')
  return index > 0 ? id.slice(0, index) : ''
}

/** thinking 帧兼容 {value,label} 与裸字符串两种形态 */
function thinkingLevels(model: DshModelFrame): string[] {
  const raw = model.thinking?.supported_levels
  if (!Array.isArray(raw)) return []
  const levels: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      levels.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const value = (item as DshThinkingLevel).value
      if (typeof value === 'string' && value.trim()) levels.push(value.trim())
    }
  }
  return levels
}

/** 读取模型目录（--list-models）；失败抛错，由 IPC 转成可读错误 */
export async function listDshModels(
  params: { command: string; profile: string },
  deps: DshDeps = {},
): Promise<RuntimeModelOption[]> {
  const resolvedDeps = { ...deps, spawn: deps.spawn ?? defaultSpawn }
  const collected = await collect(
    resolvedDeps,
    params.command,
    params.profile,
    ['--list-models'],
    resolvedDeps.timeouts?.models ?? MODELS_TIMEOUT_MS,
  )
  const modelsTimeout = resolvedDeps.timeouts?.models ?? MODELS_TIMEOUT_MS
  if (collected.spawnError)
    throw new Error(withStderr(`启动失败：${errMsg(collected.spawnError)}`, collected.stderr))
  if (collected.timedOut) throw new Error(`读取模型目录超时（${modelsTimeout}ms）`)

  const models: RuntimeModelOption[] = []
  for (const line of collected.stdout.split('\n')) {
    const frame = parseFrame(line)
    if (!frame || frame.type !== 'models' || !Array.isArray(frame.models)) continue
    for (const item of frame.models) {
      if (typeof item.id !== 'string' || !item.id.trim()) continue
      const id = item.id.trim()
      models.push({
        id,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id,
        provider: providerOf(item),
        default: item.default === true,
        thinkingLevels: thinkingLevels(item),
        defaultThinkingLevel:
          typeof item.thinking?.default_level === 'string' && item.thinking.default_level.trim()
            ? item.thinking.default_level.trim()
            : null,
      })
    }
  }

  if (models.length === 0) {
    const reason =
      collected.code !== 0
        ? `读取模型目录退出码 ${collected.code ?? 'null'}`
        : '模型目录为空（profile 未提供 --list-models？）'
    throw new Error(withStderr(reason, collected.stderr))
  }
  return models
}

/** result 帧 status → run 终态 */
function mapResultStatus(status: string | undefined): DshRunOutcome['status'] {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'completed':
    case 'succeeded':
    case 'success':
      return 'succeeded'
    case 'cancelled':
    case 'canceled':
    case 'aborted':
      return 'cancelled'
    case 'timeout':
    case 'timed_out':
      return 'timeout'
    default:
      return 'failed'
  }
}

interface DshRunState {
  ready: boolean
  sessionId: string | null
  protocolError: string
  text: string
  usage: RunUsage
  result: {
    status: string | undefined
    output: string
    error: string
    sessionId: string | null
    resumeRejected: boolean
  } | null
}

/** 处理单帧：只翻译已知类型，未知类型忽略 */
function handleFrame(
  frame: DshFrame,
  requestId: string,
  state: DshRunState,
  emit: (event: Omit<RunEvent, 'seq'>) => void,
): void {
  if (frame.v !== DSH_PROTOCOL_VERSION) {
    state.protocolError = `不支持的协议版本：${String(frame.v)}`
    return
  }
  if (frame.request_id && frame.request_id !== requestId) return

  switch (frame.type) {
    case 'ready':
      if (frame.runtime !== DSH_RUNTIME_ID) {
        state.protocolError = `协议运行时不是 dsh：${String(frame.runtime)}`
        return
      }
      state.ready = true
      return
    case 'session':
      state.sessionId = frame.session_id ?? null
      emit({ type: 'status', status: 'running' })
      return
    case 'text':
      if (frame.content) {
        state.text += frame.content
        emit({ type: 'text', text: frame.content })
      }
      return
    case 'thinking':
      if (frame.content) emit({ type: 'thinking', text: frame.content })
      return
    case 'tool_call':
      emit({
        type: 'tool_call',
        tool: frame.name ?? '',
        callId: frame.call_id ?? '',
        input: frame.arguments ?? '',
      })
      return
    case 'tool_result':
      emit({
        type: 'tool_result',
        tool: frame.name ?? '',
        callId: frame.call_id ?? '',
        output: frame.output ?? '',
        isError: frame.is_error === true,
      })
      return
    case 'usage':
      state.usage.inputTokens += frame.input_tokens ?? 0
      state.usage.outputTokens += frame.output_tokens ?? 0
      state.usage.cacheReadTokens += frame.cache_read_tokens ?? 0
      state.usage.cacheWriteTokens += frame.cache_write_tokens ?? 0
      return
    case 'protocol_error': {
      const parts = [frame.code, frame.message].filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      )
      if (parts.length > 0) state.protocolError = parts.join(': ')
      return
    }
    case 'result':
      state.result = {
        status: frame.status,
        output: frame.output ?? '',
        error: frameErrorText(frame),
        sessionId: frame.session_id ?? null,
        resumeRejected: frame.resume_rejected === true,
      }
      return
    default:
      return
  }
}

/**
 * 执行一次任务：启动 `dsh --profile <p> --stdio`，写 execute 帧，读事件帧。
 *
 * - 超时/取消都走同一套 cancel 协议：cancel 帧 → 宽限 → SIGTERM → SIGKILL。
 * - 不抛异常：spawn 失败、协议错误、超时都归一成终态结果。
 */
export async function executeDshRun(
  request: DshRunRequest,
  deps: DshDeps = {},
): Promise<DshRunOutcome> {
  const resolvedDeps = { ...deps, spawn: deps.spawn ?? defaultSpawn }
  const now = resolvedDeps.now ?? (() => Date.now())
  const killTree = resolvedDeps.killTree ?? killProcessTree
  const started = now()
  const usage = emptyUsage()

  if (request.signal.aborted) {
    return {
      status: 'cancelled',
      output: '',
      error: '已取消',
      errorCode: 'cancelled',
      exitCode: null,
      sessionId: null,
      resumeRejected: false,
      usage,
      durationMs: 0,
    }
  }

  const model = request.runtime.model
  const modelSelection = model ? parseModelId(model) : null
  if (model && !modelSelection) {
    return {
      status: 'failed',
      output: '',
      error: `模型 id 格式不对（应为 provider/model）：${model}`,
      errorCode: 'run_failed',
      exitCode: null,
      sessionId: null,
      resumeRejected: false,
      usage,
      durationMs: 0,
    }
  }

  const launched = startProcess(resolvedDeps, request.runtime, [
    '--profile',
    request.runtime.profile,
    '--stdio',
  ])
  if (!launched.process) {
    return {
      status: 'failed',
      output: '',
      error: launched.error ?? '启动失败',
      errorCode: 'spawn_failed',
      exitCode: null,
      sessionId: null,
      resumeRejected: false,
      usage,
      durationMs: 0,
    }
  }
  const child = launched.process
  const state: DshRunState = {
    ready: false,
    sessionId: null,
    protocolError: '',
    text: '',
    usage,
    result: null,
  }

  let seq = 0
  const emit = (event: Omit<RunEvent, 'seq'>): void => {
    seq += 1
    try {
      request.onEvent?.({ ...event, seq })
    } catch {
      // 订阅方异常不能打断协议读取
    }
  }

  const writeFrame = (frame: Record<string, unknown>): boolean => {
    try {
      child.stdin?.write(JSON.stringify(frame) + '\n')
      return true
    } catch {
      return false
    }
  }

  return await new Promise<DshRunOutcome>((resolve) => {
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
      cancelGrace?: ReturnType<typeof setTimeout>
      kill?: ReturnType<typeof setTimeout>
    } = {}

    const lines = createLineReader((line) => {
      const frame = parseFrame(line)
      if (!frame) return
      handleFrame(frame, request.requestId, state, emit)
    })

    const clearTimers = (): void => {
      if (timers.timeout !== undefined) clearTimeout(timers.timeout)
      if (timers.cancelGrace !== undefined) clearTimeout(timers.cancelGrace)
      if (timers.kill !== undefined) clearTimeout(timers.kill)
    }

    const terminate = (): void => {
      if (closed) return
      cancelRequested = true
      writeFrame({ v: DSH_PROTOCOL_VERSION, type: 'cancel', request_id: request.requestId })
      timers.cancelGrace = setTimeout(() => {
        if (closed) return
        if (child.pid !== undefined) killTree(child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
        timers.kill = setTimeout(() => {
          if (closed) return
          if (child.pid !== undefined) killTree(child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        }, deps.grace?.kill ?? KILL_GRACE_MS)
      }, deps.grace?.cancel ?? CANCEL_GRACE_MS)
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
        durationMs: now() - started,
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

      const failure = (errorCode: RunErrorCode, message: string): DshRunOutcome => ({
        ...base,
        status:
          errorCode === 'timeout' ? 'timeout' : errorCode === 'cancelled' ? 'cancelled' : 'failed',
        errorCode,
        error: message,
      })

      if (timedOut)
        return failure(
          'timeout',
          `运行超时（${request.timeoutMs ?? resolvedDeps.timeouts?.run ?? RUN_TIMEOUT_MS}ms）`,
        )
      if (cancelRequested) return failure('cancelled', '已取消')
      if (spawnError) return failure('spawn_failed', withStderr(errMsg(spawnError), stderrText))
      if (state.protocolError)
        return failure('protocol_error', withStderr(state.protocolError, stderrText))
      if (!state.ready)
        return failure(
          'protocol_error',
          withStderr('运行时协议未就绪进程就退出了（profile 是否支持 --stdio？）', stderrText),
        )
      if (exitCode !== null && exitCode !== 0)
        return failure('exit_nonzero', withStderr(`退出码 ${exitCode}`, stderrText))
      return failure('no_result', withStderr('进程结束但没有返回终态结果', stderrText))
    }

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimers()
      request.signal.removeEventListener('abort', onAbort)
      try {
        child.stdin?.end()
      } catch {
        // 管道已关闭：无需收尾
      }
      resolve(buildOutcome())
    }

    timers.timeout = setTimeout(
      () => {
        timedOut = true
        terminate()
      },
      request.timeoutMs ?? resolvedDeps.timeouts?.run ?? RUN_TIMEOUT_MS,
    )
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
    request.signal.addEventListener('abort', onAbort, { once: true })

    const executeFrame: Record<string, unknown> = {
      v: DSH_PROTOCOL_VERSION,
      type: 'execute',
      request_id: request.requestId,
      cwd: request.runtime.workdir ?? process.cwd(),
      prompt: request.prompt,
      mcp_servers: [],
    }
    if (modelSelection) executeFrame.model = modelSelection
    if (request.runtime.reasoningEffort)
      executeFrame.reasoning_effort = request.runtime.reasoningEffort
    if (request.resumeSessionId) executeFrame.resume_session_id = request.resumeSessionId
    if (!writeFrame(executeFrame)) {
      // 写不进去（子进程已退）：按启动失败收口，避免悬挂
      spawnError = new Error('无法写入 execute 帧（子进程已退出）')
      if (child.pid !== undefined) killTree(child.pid)
      else child.kill('SIGKILL')
      finish()
    }
  })
}
