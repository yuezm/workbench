import type { Runtime, RunStatus } from '../../shared/ai-workflow-api'
import type { StageEvent } from '../../shared/stage-machine'
import { advanceTask } from './engine'
import type { Repository } from './repository'
import { createDeepseekHarnessAdapter, type RuntimeAdapter } from './runtime/deepseek-harness'

export interface RunnerDeps {
  repo: Repository
  notifyChanged: () => void
  /** 可注入：按运行时返回适配器（测试用假 adapter） */
  adapterFor?: (runtime: Runtime) => RuntimeAdapter
  now?: () => string
}

/** 单并发 FIFO 运行队列：取出 queued run → 调 adapter → 写结果 → 推进阶段。 */
export class Runner {
  private readonly repo: Repository
  private readonly adapterFor: (runtime: Runtime) => RuntimeAdapter
  private readonly now: () => string
  private readonly queue: string[] = []
  private readonly controllers = new Map<string, AbortController>()
  private running = false

  constructor(private readonly deps: RunnerDeps) {
    this.repo = deps.repo
    this.adapterFor = deps.adapterFor ?? ((r) => createDeepseekHarnessAdapter(r))
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** 重启后恢复历史遗留的 queued run（简单实现）。 */
  resumeQueued(status: RunStatus = 'queued'): void {
    for (const run of this.repo.runsListByStatus(status)) this.enqueue(run.id)
  }

  enqueue(runId: string): void {
    this.queue.push(runId)
    void this.drain()
  }

  cancel(runId: string): void {
    this.controllers.get(runId)?.abort()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const id = this.queue.shift() as string
        await this.execute(id)
      }
    } finally {
      this.running = false
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

  async execute(runId: string): Promise<void> {
    let run
    try {
      run = this.repo.runGet(runId)
    } catch {
      return
    }
    if (run.status !== 'queued') return

    const agent = run.agentId ? this.repo.agentGet(run.agentId) : null
    if (!agent) {
      this.safeUpdate(runId, { status: 'failed', error: '运行缺少智能体', endedAt: this.now() })
      this.deps.notifyChanged()
      return
    }
    const runtime = this.repo.runtimeGet(agent.runtimeId)
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    this.safeUpdate(runId, { status: 'running', startedAt: this.now() })
    this.deps.notifyChanged()

    let output = ''
    try {
      const adapter = this.adapterFor(runtime)
      const res = await adapter.run({
        prompt: run.prompt,
        workdir: runtime.workdir ?? process.cwd(),
        signal: controller.signal,
        onOutput: (c) => {
          output += c
        },
      })
      if (controller.signal.aborted) {
        this.safeUpdate(runId, {
          status: 'cancelled',
          output: res.output || output,
          endedAt: this.now(),
        })
        return
      }
      const ok = res.code === 0
      this.safeUpdate(runId, {
        status: ok ? 'succeeded' : 'failed',
        output: res.output || output,
        error: ok ? null : `退出码 ${res.code}`,
        endedAt: this.now(),
      })
      const ev: StageEvent = ok ? { type: 'RUN_SUCCEEDED', runId } : { type: 'RUN_FAILED', runId }
      advanceTask(this.repo, run.taskId, ev, (id) => this.enqueue(id))
    } catch (e) {
      if (controller.signal.aborted) {
        this.safeUpdate(runId, { status: 'cancelled', output, endedAt: this.now() })
        return
      }
      this.safeUpdate(runId, {
        status: 'failed',
        output,
        error: e instanceof Error ? e.message : String(e),
        endedAt: this.now(),
      })
      try {
        advanceTask(this.repo, run.taskId, { type: 'RUN_FAILED', runId }, (id) => this.enqueue(id))
      } catch {
        // 阶段推进失败不影响 run 结果记录
      }
    } finally {
      this.controllers.delete(runId)
      this.deps.notifyChanged()
    }
  }
}
