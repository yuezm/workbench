import { randomUUID } from 'node:crypto'
import type {
  Agent,
  Run,
  RunErrorCode,
  RunEvent,
  Runtime,
  RuntimeProtocolFamily,
} from '../../shared/ai-workflow-api'
import type { StageEvent } from '../../shared/stage-machine'
import { advanceTask } from './engine'
import type { Repository } from './repository'
import type { RuntimeBackend } from './runtime/registry'
import { RUN_TIMEOUT_MS } from './runtime/dsh'

export interface RunnerDeps {
  repo: Repository
  notifyChanged: () => void
  /** 按协议族返回后端（装配时注入；测试用假后端） */
  backendFor: (family: RuntimeProtocolFamily) => RuntimeBackend
  now?: () => string
  requestId?: () => string
  /** 单次运行超时（默认 30 分钟） */
  timeoutMs?: number
}

/**
 * 运行调度器：按「运行时并发上限」派发 queued run，执行完写结果并推进阶段。
 *
 * 并发模型：同一运行时最多 maxConcurrent 个 run 同时执行，不同运行时互不阻塞；
 * 队列全局 FIFO，取不到名额的 run 留在队列里等下一次泵。
 */
export class Runner {
  private readonly repo: Repository
  private readonly backendFor: (family: RuntimeProtocolFamily) => RuntimeBackend
  private readonly now: () => string
  private readonly requestId: () => string
  private readonly timeoutMs: number
  private readonly queue: string[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly runningByRuntime = new Map<string, number>()
  private pumping = false
  private active = 0

  constructor(private readonly deps: RunnerDeps) {
    this.repo = deps.repo
    this.backendFor = deps.backendFor
    this.now = deps.now ?? (() => new Date().toISOString())
    this.requestId = deps.requestId ?? (() => randomUUID())
    this.timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS
  }

  /** 重启后恢复历史遗留的 queued run（简单实现）。 */
  resumeQueued(status: Run['status'] = 'queued'): void {
    for (const run of this.repo.runsListByStatus(status)) this.enqueue(run.id)
  }

  /** 入队（重复入队无副作用）；有运行时名额时立即开始。 */
  enqueue(runId: string): void {
    if (this.queue.includes(runId) || this.controllers.has(runId)) return
    this.queue.push(runId)
    this.pump()
  }

  /** 中止某个正在执行的 run（删除任务/工作流时用） */
  cancel(runId: string): void {
    this.controllers.get(runId)?.abort()
  }

  /** 当前排队中的 run（诊断/测试用） */
  queued(): string[] {
    return [...this.queue]
  }

  /** 等队列清空且没有执行中的 run（测试/关闭前收尾用） */
  async waitForIdle(): Promise<void> {
    while (this.queue.length > 0 || this.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  /** 依次派发队首可执行的 run；名额不足的留在队列里。 */
  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      let index = 0
      while (index < this.queue.length) {
        const runId = this.queue[index]
        if (!this.canStart(runId)) {
          index += 1
          continue
        }
        this.queue.splice(index, 1)
        void this.execute(runId)
      }
    } finally {
      this.pumping = false
    }
  }

  /** 该 run 能否立刻开始：运行时存在且未超并发上限；信息缺失交给 execute 归类失败 */
  private canStart(runId: string): boolean {
    let run: Run
    try {
      run = this.repo.runGet(runId)
    } catch {
      // run 已随任务删除：直接出队
      return true
    }
    if (run.status !== 'queued') return true
    if (!run.runtimeId) return true
    let runtime: Runtime
    try {
      runtime = this.repo.runtimeGet(run.runtimeId)
    } catch {
      return true
    }
    const running = this.runningByRuntime.get(run.runtimeId) ?? 0
    return running < Math.max(1, runtime.maxConcurrent)
  }

  private async execute(runId: string): Promise<void> {
    let reservedRuntimeId: string | null = null
    let processed = false
    this.active += 1
    try {
      let run: Run
      try {
        run = this.repo.runGet(runId)
      } catch {
        // run 已随任务删除：没有可写的记录
        return
      }
      if (run.status !== 'queued') return
      processed = true

      reservedRuntimeId = run.runtimeId
      if (reservedRuntimeId) {
        this.runningByRuntime.set(
          reservedRuntimeId,
          (this.runningByRuntime.get(reservedRuntimeId) ?? 0) + 1,
        )
      }

      const controller = new AbortController()
      this.controllers.set(runId, controller)

      const agent = this.loadAgent(run)
      if (!agent) {
        this.failWithoutRuntime(runId, run, 'runtime_missing', '运行缺少智能体')
        return
      }
      const runtime = this.loadRuntime(agent)
      if (!runtime) {
        this.failWithoutRuntime(runId, run, 'runtime_missing', '运行时不存在（可能已被删除）')
        return
      }
      if (!runtime.enabled) {
        this.failWithoutRuntime(runId, run, 'runtime_disabled', '运行时已停用')
        return
      }

      this.safeUpdate(runId, { status: 'running', startedAt: this.now() })
      this.deps.notifyChanged()

      let output = ''
      const onEvent = (event: RunEvent): void => {
        if (event.type === 'text' && event.text) output += event.text
        try {
          this.repo.runEventsAppend(runId, [event])
        } catch {
          // run 已随任务删除：事件无处可写
        }
        this.deps.notifyChanged()
      }

      let outcome
      try {
        const backend = this.backendFor(runtime.protocolFamily)
        outcome = await backend.execute({
          runtime,
          requestId: this.requestId(),
          prompt: run.prompt,
          timeoutMs: this.timeoutMs,
          signal: controller.signal,
          onEvent,
        })
      } catch (e) {
        this.fail(runId, run, 'run_failed', e instanceof Error ? e.message : String(e))
        return
      }

      const cancelled = controller.signal.aborted && outcome.status !== 'succeeded'
      if (cancelled) {
        this.safeUpdate(runId, {
          status: 'cancelled',
          output: outcome.output || output,
          errorCode: 'cancelled',
          error: outcome.error ?? '已取消',
          exitCode: outcome.exitCode,
          sessionId: outcome.sessionId,
          usage: outcome.usage,
          durationMs: outcome.durationMs,
          endedAt: this.now(),
        })
        return
      }

      this.safeUpdate(runId, {
        status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
        output: outcome.output || output,
        error: outcome.error,
        errorCode: outcome.errorCode,
        exitCode: outcome.exitCode,
        sessionId: outcome.sessionId,
        usage: outcome.usage,
        durationMs: outcome.durationMs,
        endedAt: this.now(),
      })

      if (outcome.status === 'succeeded') {
        this.advance(run, { type: 'RUN_SUCCEEDED', runId })
      } else {
        this.advance(run, { type: 'RUN_FAILED', runId })
      }
    } finally {
      this.active -= 1
      this.controllers.delete(runId)
      if (reservedRuntimeId) {
        const running = (this.runningByRuntime.get(reservedRuntimeId) ?? 1) - 1
        if (running <= 0) this.runningByRuntime.delete(reservedRuntimeId)
        else this.runningByRuntime.set(reservedRuntimeId, running)
      }
      if (processed) this.deps.notifyChanged()
      this.pump()
    }
  }

  private loadAgent(run: Run): Agent | null {
    if (!run.agentId) return null
    try {
      return this.repo.agentGet(run.agentId)
    } catch {
      return null
    }
  }

  private loadRuntime(agent: Agent): Runtime | null {
    try {
      return this.repo.runtimeGet(agent.runtimeId)
    } catch {
      return null
    }
  }

  /** run 或所属任务可能在执行期间被删除，写结果时忽略这种竞争。 */
  private safeUpdate(runId: string, patch: Parameters<Repository['runUpdate']>[1]): void {
    try {
      this.repo.runUpdate(runId, patch)
    } catch {
      // run 已随任务/工作流删除：没有可写的记录
    }
  }

  /** 缺运行时/被停用：直接失败，不再派发 */
  private failWithoutRuntime(
    runId: string,
    run: Run,
    errorCode: RunErrorCode,
    error: string,
  ): void {
    this.safeUpdate(runId, {
      status: 'failed',
      error,
      errorCode,
      endedAt: this.now(),
    })
    this.advance(run, { type: 'RUN_FAILED', runId })
  }

  private fail(runId: string, run: Run, errorCode: RunErrorCode, error: string): void {
    this.safeUpdate(runId, {
      status: 'failed',
      error,
      errorCode,
      endedAt: this.now(),
    })
    this.advance(run, { type: 'RUN_FAILED', runId })
  }

  /** 推进阶段；run 所属任务/工作流已删除时静默结束 */
  private advance(run: Run, event: StageEvent): void {
    try {
      advanceTask(this.repo, run.taskId, event, (id) => this.enqueue(id))
    } catch {
      // 阶段推进失败不影响 run 结果记录
    }
  }
}
