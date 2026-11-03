import type { Runtime, RuntimeTestResult } from '../../../shared/ai-workflow-api'
import { createDeepseekHarnessAdapter, type RuntimeAdapter } from './deepseek-harness'

/** 探测提示词：最小、无副作用，只用来判断「命令能跑起来」 */
export const PROBE_PROMPT = '仅回复 OK，不要做其它事。'
/** 连通性测试默认超时（毫秒） */
export const PROBE_TIMEOUT_MS = 30_000
/** 输出尾部默认保留的字符数（便于排查 stderr，又不撑爆 IPC） */
export const PROBE_OUTPUT_LIMIT = 2000

export interface ProbeDeps {
  /** 由运行时配置生成适配器；缺省为本机 CLI 的真实 spawn 适配器 */
  adapterFor?: (runtime: Runtime) => RuntimeAdapter
  timeoutMs?: number
  now?: () => number
  outputLimit?: number
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 取输出尾部；超限时截断并加省略号前缀 */
function tail(text: string, limit: number): string {
  return text.length > limit ? '…' + text.slice(-limit) : text
}

/**
 * 运行时连通性测试：真实跑一次探测提示词，只读（不写库、不建 run）。
 * 任何失败都以结果对象返回，绝不向外抛异常。
 */
export async function probeRuntime(
  runtime: Runtime,
  deps: ProbeDeps = {},
): Promise<RuntimeTestResult> {
  const adapterFor = deps.adapterFor ?? createDeepseekHarnessAdapter
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const outputLimit = deps.outputLimit ?? PROBE_OUTPUT_LIMIT
  const startedAt = now()

  const controller = new AbortController()
  /** 经 onOutput 累计的输出（适配器返回的 output 作为兜底） */
  let streamed = ''
  let timedOut = false

  const timeoutError = new Error(`测试超时（${timeoutMs}ms）`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      // 先 abort，给适配器结束子进程的机会，再按超时收口
      controller.abort()
      reject(timeoutError)
    }, timeoutMs)
  })

  try {
    const pending = adapterFor(runtime).run({
      prompt: PROBE_PROMPT,
      workdir: runtime.workdir ?? process.cwd(),
      signal: controller.signal,
      onOutput: (chunk) => {
        streamed += chunk
      },
    })
    const res = await Promise.race([pending, timeout])
    const elapsedMs = now() - startedAt
    const output = tail(streamed.length > 0 ? streamed : res.output, outputLimit)
    if (res.code !== 0) {
      return { ok: false, code: res.code, elapsedMs, output, error: `退出码 ${res.code}` }
    }
    return { ok: true, code: 0, elapsedMs, output, error: null }
  } catch (e) {
    return {
      ok: false,
      code: null,
      elapsedMs: now() - startedAt,
      output: tail(streamed, outputLimit),
      // 超时 abort 后适配器可能先以 abort 类错误 reject，仍按「超时」上报
      error: timedOut ? timeoutError.message : errMsg(e),
    }
  } finally {
    // 无论成功、失败还是超时都不留定时器
    clearTimeout(timer)
  }
}
