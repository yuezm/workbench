// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Runtime, Task } from '../../shared/ai-workflow-api'
import { openDb } from './db'
import { Repository } from './repository'
import { Runner } from './runner'
import type { RuntimeAdapter } from './runtime/deepseek-harness'

let db: DatabaseSync
let repo: Repository
let notify: Mock<() => void>
let notifyChanged: () => void

interface Seed {
  task: Task
  runtime: Runtime
  workflowId: string
  stage1Id: string
}

beforeEach(() => {
  db = openDb(':memory:')
  repo = new Repository(db)
  notify = vi.fn<() => void>()
  notifyChanged = () => {
    notify()
  }
})
afterEach(() => db.close())

function seed(): Seed {
  const runtime = repo.runtimeCreate({ name: 'ds', command: 'dsh' })
  const agent = repo.agentCreate({ name: 'coder', runtimeId: runtime.id, systemPrompt: 'sys' })
  const wf = repo.workflowCreate({
    name: 'w',
    stages: [
      { name: '执行', entryMode: 'agent', agentId: agent.id },
      { name: '完成', entryMode: 'none' },
    ],
  })
  const task = repo.taskCreate({ title: 'T', description: 'd', workflowId: wf.id })
  return { task, runtime, workflowId: wf.id, stage1Id: wf.stages[1].id }
}

function queuedRun(taskId: string, stageId: string, agentId: string | null) {
  return repo.runCreate({ taskId, stageId, agentId, prompt: 'p', status: 'queued' })
}

describe('Runner', () => {
  it('成功：run 记 succeeded，任务推进到下一阶段', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = {
      run: async ({ onOutput }) => (onOutput('x'), { code: 0, output: 'x' }),
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    await runner.execute(run.id)
    expect(repo.runGet(run.id).status).toBe('succeeded')
    expect(repo.taskGet(s.task.id).currentStageId).toBe(s.stage1Id)
    expect(notify).toHaveBeenCalled()
  })

  it('失败：run 记 failed，任务退回（首阶段原地）', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = { run: async () => ({ code: 1, output: 'bad' }) }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    await runner.execute(run.id)
    const r = repo.runGet(run.id)
    expect(r.status).toBe('failed')
    expect(r.error).toContain('1')
    expect(repo.taskGet(s.task.id).currentStageId).toBe(s.task.currentStageId)
  })

  it('缺智能体：直接 failed', async () => {
    const s = seed()
    const run = queuedRun(s.task.id, s.task.currentStageId as string, null)
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => ({ run: vi.fn() }) })
    await runner.execute(run.id)
    expect(repo.runGet(run.id).status).toBe('failed')
  })

  it('取消：abort 后记为 cancelled', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = {
      run: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    const p = runner.execute(run.id)
    runner.cancel(run.id)
    await p
    expect(repo.runGet(run.id).status).toBe('cancelled')
  })

  it('单并发：队列串行执行且不同时运行', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const r1 = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const r2 = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    let active = 0
    let maxConcurrent = 0
    const adapter: RuntimeAdapter = {
      run: async () => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return { code: 0, output: 'ok' }
      },
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    runner.enqueue(r1.id)
    runner.enqueue(r2.id)
    await new Promise((r) => setTimeout(r, 60))
    expect(maxConcurrent).toBe(1)
    expect(repo.runGet(r1.id).status).toBe('succeeded')
    expect(repo.runGet(r2.id).status).toBe('succeeded')
  })

  it('resumeQueued 恢复历史 queued run', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = { run: async () => ({ code: 0, output: 'ok' }) }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    runner.resumeQueued()
    await new Promise((r) => setTimeout(r, 40))
    expect(repo.runGet(run.id).status).toBe('succeeded')
  })

  it('默认构造（无 adapterFor）；execute 不存在 run 直接返回；cancel 未知 id 无副作用', async () => {
    const runner = new Runner({ repo, notifyChanged })
    await runner.execute('ghost')
    expect(() => runner.cancel('ghost')).not.toThrow()
  })

  it('adapter 抛错：run 记 failed，错误信息写入', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = {
      run: async () => {
        throw new Error('boom')
      },
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    await runner.execute(run.id)
    const r = repo.runGet(run.id)
    expect(r.status).toBe('failed')
    expect(r.error).toContain('boom')
  })

  it('输出回退：adapter 返回空 output 时用流式累积', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = {
      run: async ({ onOutput }) => {
        onOutput('streamed')
        return { code: 0, output: '' }
      },
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    await runner.execute(run.id)
    expect(repo.runGet(run.id).output).toBe('streamed')
  })

  it('execute 非 queued 的 run 直接返回', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    repo.runUpdate(run.id, { status: 'succeeded' })
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => ({ run: vi.fn() }) })
    await runner.execute(run.id)
    expect(repo.runGet(run.id).status).toBe('succeeded')
  })

  it('abort 后 adapter 仍 resolve → cancelled 且不推进任务', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = {
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ code: 0, output: 'x' }))
        }),
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    const p = runner.execute(run.id)
    runner.cancel(run.id)
    await p
    expect(repo.runGet(run.id).status).toBe('cancelled')
    expect(repo.taskGet(s.task.id).currentStageId).toBe(s.task.currentStageId)
  })

  it('adapter 抛非 Error → failed 且错误被字符串化', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    const adapter: RuntimeAdapter = {
      run: async () => {
        throw 'boom-str'
      },
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    await runner.execute(run.id)
    expect(repo.runGet(run.id).error).toContain('boom-str')
  })

  it('任务在 run 执行中被删除：execute 不抛未捕获错误', async () => {
    const s = seed()
    const agent = repo.agentGet(repo.workflowGet(s.workflowId).stages[0].agentId as string)
    const run = queuedRun(s.task.id, s.task.currentStageId as string, agent.id)
    let release!: (r: { code: number; output: string }) => void
    const adapter: RuntimeAdapter = {
      run: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    }
    const runner = new Runner({ repo, notifyChanged, adapterFor: () => adapter })
    const p = runner.execute(run.id)
    repo.taskRemove(s.task.id)
    release({ code: 0, output: 'ok' })
    await expect(p).resolves.toBeUndefined()
  })
})
