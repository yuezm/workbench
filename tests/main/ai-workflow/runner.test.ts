// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RunUsage, Task } from '../../../src/shared/ai-workflow-api'
import { Repository } from '../../../src/main/ai-workflow/repository'
import { Runner } from '../../../src/main/ai-workflow/runner'
import type { DshRunOutcome } from '../../../src/main/ai-workflow/runtime/dsh'
import type { RuntimeBackend } from '../../../src/main/ai-workflow/runtime/registry'
import {
  createAgent,
  createRuntime,
  createTask,
  createWorkflow,
  createWorld,
  removeAgent,
  removeTask,
  resetCommandIds,
  taskById,
  updateRuntime,
  type TestWorld,
} from './test-support'

let world: TestWorld
let db: DatabaseSync
let repo: Repository
let notify: Mock<() => void>
let notifyChanged: () => void

const usage: RunUsage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function outcome(over: Partial<DshRunOutcome> = {}): DshRunOutcome {
  return {
    status: 'succeeded',
    output: 'ok',
    error: null,
    errorCode: null,
    exitCode: 0,
    sessionId: 'sess-1',
    resumeRejected: false,
    usage,
    durationMs: 7,
    ...over,
  }
}

function backend(execute: RuntimeBackend['execute']): RuntimeBackend {
  return { probe: vi.fn(), models: vi.fn(), execute }
}

interface Seed {
  task: Task
  runtimeId: string
  workflowId: string
  stage1Id: string
  agentId: string
}

function seed(maxConcurrent = 1): Seed {
  const runtime = createRuntime(world, {
    name: 'ds-' + Math.random().toString(36).slice(2, 8),
    command: 'dsh',
    maxConcurrent,
  })
  const agent = createAgent(world, {
    name: 'coder',
    runtimeId: runtime.id,
    systemPrompt: 'sys',
  })
  const wf = createWorkflow(world, {
    name: 'w',
    stages: [
      { name: '执行', entryMode: 'agent', agentId: agent.id },
      { name: '完成', entryMode: 'none' },
    ],
  })
  const task = createTask(world, { title: 'T', description: 'd', workflowId: wf.id })
  return {
    task,
    runtimeId: runtime.id,
    workflowId: wf.id,
    stage1Id: wf.stages[1].id,
    agentId: agent.id,
  }
}

function queuedRun(
  s: Seed,
  agentId: string | null = s.agentId,
  runtimeId: string | null = s.runtimeId,
) {
  return repo.runCreate({
    taskId: s.task.id,
    stageId: s.task.currentStageId as string,
    agentId,
    runtimeId,
    prompt: 'p',
    status: 'queued',
  })
}

function makeRunner(execute: RuntimeBackend['execute']): Runner {
  return new Runner({
    repo,
    store: world.store,
    notifyChanged,
    backendFor: () => backend(execute),
    now: () => '2026-01-01T00:00:00.000Z',
    requestId: () => 'req-1',
    timeoutMs: 1_000,
  })
}

beforeEach(() => {
  resetCommandIds()
  world = createWorld()
  db = world.db
  repo = world.repo
  notify = vi.fn<() => void>()
  notifyChanged = () => notify()
})
afterEach(() => world.db.close())

describe('Runner', () => {
  it('成功：run 全字段落库、事件保存、任务推进到下一阶段', async () => {
    const s = seed()
    const run = queuedRun(s)
    const events: Array<{ type: string }> = []
    const runner = makeRunner(async ({ onEvent }) => {
      onEvent?.({ seq: 1, type: 'text', text: 'a' })
      onEvent?.({ seq: 2, type: 'text', text: 'b' })
      events.push(...(onEvent ? [{ type: 'text' }] : []))
      return outcome({ output: 'ab' })
    })
    runner.enqueue(run.id)
    await runner.waitForIdle()

    const saved = repo.runGet(run.id)
    expect(saved.status).toBe('succeeded')
    expect(saved.runtimeId).toBe(s.runtimeId)
    expect(saved.sessionId).toBe('sess-1')
    expect(saved.usage).toEqual(usage)
    expect(saved.durationMs).toBe(7)
    expect(saved.exitCode).toBe(0)
    expect(saved.errorCode).toBeNull()
    expect(saved.startedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(saved.endedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(repo.runEventsList(run.id).map((e) => e.text)).toEqual(['a', 'b'])
    expect(taskById(world.store, s.task.id).currentStageId).toBe(s.stage1Id)
    expect(events).toHaveLength(1)
    expect(notify).toHaveBeenCalled()
  })

  it('outcome 没有 output 时用事件累计的文本', async () => {
    const s = seed()
    const run = queuedRun(s)
    const runner = makeRunner(async ({ onEvent }) => {
      onEvent?.({ seq: 1, type: 'text', text: 'streamed' })
      return outcome({ output: '' })
    })
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(repo.runGet(run.id).output).toBe('streamed')
  })

  it('失败：errorCode/error 落库，任务原地退回', async () => {
    const s = seed()
    const run = queuedRun(s)
    const runner = makeRunner(async () =>
      outcome({
        status: 'failed',
        output: 'bad',
        error: '退出码 1',
        errorCode: 'exit_nonzero',
        exitCode: 1,
      }),
    )
    runner.enqueue(run.id)
    await runner.waitForIdle()
    const saved = repo.runGet(run.id)
    expect(saved.status).toBe('failed')
    expect(saved.errorCode).toBe('exit_nonzero')
    expect(saved.error).toBe('退出码 1')
    expect(taskById(world.store, s.task.id).currentStageId).toBe(s.task.currentStageId)
  })

  it('缺智能体：runtime_missing', async () => {
    const s = seed()
    const run = queuedRun(s, null, null)
    const runner = makeRunner(async () => outcome())
    runner.enqueue(run.id)
    await runner.waitForIdle()
    const saved = repo.runGet(run.id)
    expect(saved.status).toBe('failed')
    expect(saved.errorCode).toBe('runtime_missing')
    expect(saved.error).toContain('智能体')
  })

  it('智能体在 run 期间被删除：runtime_missing', async () => {
    const s = seed()
    // 新建一个不被任何阶段引用的智能体，run 之后删掉它
    const extraRuntime = createRuntime(world, { name: 'extra' })
    const extraAgent = createAgent(world, { name: 'temp', runtimeId: extraRuntime.id })
    const run = queuedRun(s, extraAgent.id, extraRuntime.id)
    removeAgent(world, extraAgent.id)
    const runner = makeRunner(async () => outcome())
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(repo.runGet(run.id).errorCode).toBe('runtime_missing')
  })

  it('运行时停用：runtime_disabled，不调用后端', async () => {
    const s = seed()
    const run = queuedRun(s)
    updateRuntime(world, s.runtimeId, { enabled: false })
    const execute = vi.fn()
    const runner = makeRunner(execute)
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(execute).not.toHaveBeenCalled()
    const saved = repo.runGet(run.id)
    expect(saved.status).toBe('failed')
    expect(saved.errorCode).toBe('runtime_disabled')
  })

  it('取消：abort 后记为 cancelled', async () => {
    const s = seed()
    const run = queuedRun(s)
    const runner = makeRunner(
      ({ signal }) =>
        new Promise<DshRunOutcome>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve(outcome({ status: 'cancelled', error: '已取消', errorCode: 'cancelled' })),
          )
        }),
    )
    runner.enqueue(run.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    runner.cancel(run.id)
    await runner.waitForIdle()
    expect(repo.runGet(run.id).status).toBe('cancelled')
  })

  it('后端抛错：failed + run_failed', async () => {
    const s = seed()
    const run = queuedRun(s)
    const runner = makeRunner(async () => {
      throw new Error('backend boom')
    })
    runner.enqueue(run.id)
    await runner.waitForIdle()
    const saved = repo.runGet(run.id)
    expect(saved.status).toBe('failed')
    expect(saved.errorCode).toBe('run_failed')
    expect(saved.error).toContain('backend boom')
  })

  it('同一运行时按 maxConcurrent 限流', async () => {
    const s = seed(1)
    const r1 = queuedRun(s)
    const r2 = queuedRun(s)
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const runner = makeRunner(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return outcome()
    })
    runner.enqueue(r1.id)
    runner.enqueue(r2.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(peak).toBe(1)
    expect(runner.queued()).toEqual([r2.id])
    // 释放第一个：第二个立刻补位，但仍不会并发
    releases[0]()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(active).toBe(1)
    expect(peak).toBe(1)
    releases[1]()
    await runner.waitForIdle()
    expect(repo.runGet(r1.id).status).toBe('succeeded')
    expect(repo.runGet(r2.id).status).toBe('succeeded')
  })

  it('不同运行时并行执行', async () => {
    const a = seed(1)
    const b = seed(1)
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const runner = makeRunner(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return outcome()
    })
    runner.enqueue(queuedRun(a).id)
    runner.enqueue(queuedRun(b).id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(peak).toBe(2)
    releases.forEach((release) => release())
    await runner.waitForIdle()
  })

  it('重复入队不会执行两次', async () => {
    const s = seed()
    const run = queuedRun(s)
    const execute = vi.fn(async () => outcome())
    const runner = makeRunner(execute)
    runner.enqueue(run.id)
    runner.enqueue(run.id)
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('非 queued 的 run 直接出队不执行', async () => {
    const s = seed()
    const run = queuedRun(s)
    repo.runUpdate(run.id, { status: 'succeeded' })
    const execute = vi.fn(async () => outcome())
    const runner = makeRunner(execute)
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(execute).not.toHaveBeenCalled()
  })

  it('不存在的 run id 不抛错', async () => {
    const runner = makeRunner(async () => outcome())
    runner.enqueue('ghost')
    await runner.waitForIdle()
    expect(notify).not.toHaveBeenCalled()
  })

  it('resumeQueued 恢复遗留的 queued run', async () => {
    const s = seed()
    const run = queuedRun(s)
    const execute = vi.fn(async () => outcome())
    const runner = new Runner({
      repo,
      store: world.store,
      notifyChanged,
      backendFor: () => backend(execute),
      now: () => 't',
      requestId: () => 'r',
    })
    runner.resumeQueued()
    await runner.waitForIdle()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(repo.runGet(run.id).status).toBe('succeeded')
  })
})

describe('Runner 边界', () => {
  it('运行时在 run 期间被删除：runtime_missing', async () => {
    const s = seed()
    const run = queuedRun(s)
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare('DELETE FROM runtimes WHERE id=?').run(s.runtimeId)
    db.exec('PRAGMA foreign_keys = ON')
    const runner = makeRunner(async () => outcome())
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(repo.runGet(run.id).errorCode).toBe('runtime_missing')
  })

  it('智能体在 run 期间被删除（run.agent_id 悬空）：runtime_missing', async () => {
    const s = seed()
    const run = queuedRun(s)
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare('DELETE FROM agents WHERE id=?').run(s.agentId)
    db.exec('PRAGMA foreign_keys = ON')
    const runner = makeRunner(async () => outcome())
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(repo.runGet(run.id).errorCode).toBe('runtime_missing')
  })

  it('任务在 run 期间被删除：写结果与推进阶段都不抛错', async () => {
    const s = seed()
    const run = queuedRun(s)
    let release: (() => void) | null = null
    const runner = makeRunner(
      () =>
        new Promise<DshRunOutcome>((resolve) => {
          release = () => resolve(outcome())
        }),
    )
    runner.enqueue(run.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    removeTask(world, s.task.id)
    ;(release as unknown as () => void)()
    await runner.waitForIdle()
    expect(() => repo.runGet(run.id)).toThrow()
  })

  it('不注入 now/requestId 时用默认值', async () => {
    const s = seed()
    const run = queuedRun(s)
    const execute = vi.fn(async () => outcome())
    const runner = new Runner({
      repo,
      store: world.store,
      notifyChanged,
      backendFor: () => backend(execute),
    })
    runner.enqueue(run.id)
    await runner.waitForIdle()
    const saved = repo.runGet(run.id)
    expect(saved.status).toBe('succeeded')
    expect(saved.startedAt).toMatch(/^\d{4}-/)
    const request = (execute.mock.calls[0] as unknown as [{ requestId: string }])[0]
    expect(request.requestId).toMatch(/[0-9a-f-]{36}/)
  })

  it('maxConcurrent=2：两个 run 并行，先完成一个后计数回落到 1', async () => {
    const s = seed(2)
    const r1 = queuedRun(s)
    const r2 = queuedRun(s)
    const releases: Array<() => void> = []
    const runner = makeRunner(
      () =>
        new Promise<DshRunOutcome>((resolve) => {
          releases.push(() => resolve(outcome()))
        }),
    )
    runner.enqueue(r1.id)
    runner.enqueue(r2.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(releases).toHaveLength(2)
    releases[0]()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(repo.runGet(r1.id).status).toBe('succeeded')
    releases[1]()
    await runner.waitForIdle()
    expect(repo.runGet(r2.id).status).toBe('succeeded')
  })
})
describe('Runner 推进与兜底', () => {
  it('后端抛非 Error：error 文案转成字符串', async () => {
    const s = seed()
    const run = queuedRun(s)
    const runner = makeRunner((() =>
      Promise.reject('字符串错误')) as unknown as RuntimeBackend['execute'])
    runner.enqueue(run.id)
    await runner.waitForIdle()
    expect(repo.runGet(run.id).error).toBe('字符串错误')
  })

  it('成功推进到下一个 agent 阶段：自动创建并执行下一条 run', async () => {
    const runtime = createRuntime(world, { name: 'chain' })
    const agent = createAgent(world, { name: 'a', runtimeId: runtime.id })
    const wf = createWorkflow(world, {
      name: 'chain',
      stages: [
        { name: '执行1', entryMode: 'agent', agentId: agent.id },
        { name: '执行2', entryMode: 'agent', agentId: agent.id },
      ],
    })
    const task = createTask(world, { title: 'T', workflowId: wf.id })
    const execute = vi.fn(async () => outcome({ output: 'ok' }))
    const runner = makeRunner(execute)
    // 从首阶段进入效果开始：先手动入队第一条 run
    const runsBefore = repo.runsListByTask(task.id)
    expect(runsBefore).toHaveLength(0)
    runner.enqueue(
      repo.runCreate({
        taskId: task.id,
        stageId: wf.stages[0].id,
        agentId: agent.id,
        runtimeId: runtime.id,
        prompt: 'p',
        status: 'queued',
      }).id,
    )
    await runner.waitForIdle()
    const runs = repo.runsListByTask(task.id)
    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true)
    expect(taskById(world.store, task.id).currentStageId).toBe(wf.stages[1].id)
  })
})
