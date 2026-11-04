// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Run, Runtime, Task } from '../../../src/shared/ai-workflow-api'
import { Repository } from '../../../src/main/ai-workflow/repository'
import {
  agentById,
  createAgent,
  createRuntime,
  createTask,
  createWorkflow,
  createWorld,
  resetCommandIds,
  removeTask,
  runtimeById,
  type TestWorld,
} from './test-support'

let world: TestWorld
let repo: Repository

beforeEach(() => {
  resetCommandIds()
  world = createWorld()
  repo = world.repo
})
afterEach(() => world.db.close())

/** 建运行时 + 智能体 + 单阶段工作流 + 任务，返回种子 id。 */
function seed(): { runtime: Runtime; agentId: string; workflowId: string; task: Task } {
  const runtime = createRuntime(world, { name: 'ds', command: 'dsh', profile: 'multica' })
  const agent = createAgent(world, { name: 'coder', runtimeId: runtime.id, systemPrompt: 'sys' })
  const workflow = createWorkflow(world, {
    name: 'w',
    stages: [{ name: 's', entryMode: 'none' }],
  })
  const task = createTask(world, { title: 't', workflowId: workflow.id })
  return { runtime, agentId: agent.id, workflowId: workflow.id, task }
}

function queuedRun(taskId: string, runtimeId: string | null = null): Run {
  return repo.runCreate({
    taskId,
    stageId: null,
    agentId: null,
    runtimeId,
    prompt: 'p',
    status: 'queued',
  })
}

describe('repository：执行配置只读', () => {
  it('runtimeGet 返回完整配置行（默认值 / 探测结论）', () => {
    const runtime = createRuntime(world, { name: 'ds', command: 'dsh' })
    const loaded = runtimeById(world.store, runtime.id)
    expect(loaded.protocolFamily).toBe('dsh')
    expect(loaded.profile).toBe('multica')
    expect(loaded.permissionMode).toBe('workspace-write')
    expect(loaded.maxConcurrent).toBe(1)
    expect(loaded.enabled).toBe(true)
    expect(loaded.model).toBeNull()
    expect(loaded.lastProbe).toBeNull()
    expect(repo.runtimeGet(runtime.id)).toEqual(loaded)
    expect(() => repo.runtimeGet('ghost')).toThrow(/运行时不存在/)
  })

  it('agentGet 返回绑定运行时的智能体；不存在抛错', () => {
    const { runtime, agentId } = seed()
    const agent = agentById(world.store, agentId)
    expect(agent.runtimeId).toBe(runtime.id)
    expect(agent.systemPrompt).toBe('sys')
    expect(repo.agentGet(agentId)).toEqual(agent)
    expect(() => repo.agentGet('ghost')).toThrow(/智能体不存在/)
  })
})

describe('repository：runs', () => {
  it('runCreate / runGet / runsListByTask / runsListByStatus', () => {
    const { task } = seed()
    const run = queuedRun(task.id)
    expect(run.taskId).toBe(task.id)
    expect(run.status).toBe('queued')
    expect(run.prompt).toBe('p')
    expect(run.output).toBe('')
    expect(run.agentId).toBeNull()
    expect(run.runtimeId).toBeNull()
    expect(run.sessionId).toBeNull()
    expect(run.usage).toBeNull()
    expect(run.startedAt).toBeNull()
    expect(run.endedAt).toBeNull()
    expect(repo.runGet(run.id).id).toBe(run.id)
    expect(repo.runsListByTask(task.id)).toEqual([run])
    expect(repo.runsListByStatus('queued')).toEqual([run])
    expect(repo.runsListByStatus('succeeded')).toEqual([])
    expect(() => repo.runGet('ghost')).toThrow(/运行记录不存在/)
  })

  it('runUpdate 更新状态与时间戳', () => {
    const { task } = seed()
    const run = queuedRun(task.id)
    const updated = repo.runUpdate(run.id, { status: 'running', startedAt: 't1' })
    expect(updated.status).toBe('running')
    expect(updated.startedAt).toBe('t1')
    expect(repo.runGet(run.id).status).toBe('running')
    expect(repo.runsListByStatus('queued')).toEqual([])
    expect(repo.runsListByStatus('running')).toHaveLength(1)
  })

  it('run 的新增字段（runtime/session/usage/errorCode）可写可读', () => {
    const { runtime, task } = seed()
    const run = queuedRun(task.id, runtime.id)
    expect(run.runtimeId).toBe(runtime.id)
    const updated = repo.runUpdate(run.id, {
      status: 'failed',
      error: 'boom',
      errorCode: 'run_failed',
      exitCode: 2,
      sessionId: 's1',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 12,
      endedAt: 't2',
    })
    expect(updated).toMatchObject({
      errorCode: 'run_failed',
      exitCode: 2,
      sessionId: 's1',
      durationMs: 12,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    // null 清除 usage
    expect(repo.runUpdate(run.id, { usage: null }).usage).toBeNull()
  })

  it('runUpdate 未给的字段保持原值（output 只改一个字段）', () => {
    const { task } = seed()
    const run = queuedRun(task.id)
    const updated = repo.runUpdate(run.id, { output: 'o' })
    expect(updated.status).toBe('queued')
    expect(updated.output).toBe('o')
    expect(updated.error).toBeNull()
  })

  it('runEventsAppend / runEventsList：按 seq 幂等覆盖', () => {
    const { task } = seed()
    const run = queuedRun(task.id)
    repo.runEventsAppend(run.id, [
      { seq: 1, type: 'text', text: 'a' },
      { seq: 2, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' },
      { seq: 3, type: 'status', status: 'running' },
    ])
    expect(repo.runEventsList(run.id)).toEqual([
      { seq: 1, type: 'text', text: 'a' },
      { seq: 2, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' },
      { seq: 3, type: 'status', status: 'running' },
    ])
    // 空事件数组是 no-op
    expect(() => repo.runEventsAppend(run.id, [])).not.toThrow()
    expect(repo.runEventsList(run.id)).toHaveLength(3)
    // 重复 seq 覆盖而不是新增
    repo.runEventsAppend(run.id, [{ seq: 1, type: 'text', text: 'b' }])
    expect(repo.runEventsList(run.id)[0]).toEqual({ seq: 1, type: 'text', text: 'b' })
    expect(repo.runEventsList(run.id)).toHaveLength(3)
    expect(repo.runEventsList('ghost')).toEqual([])
  })
})

describe('repository：运行时负载与活跃 run', () => {
  it('runtimeWorkloads 只统计 queued/running，按运行时分组', () => {
    const { runtime, task } = seed()
    const make = (status: 'queued' | 'running' | 'succeeded') =>
      repo.runCreate({
        taskId: task.id,
        stageId: null,
        agentId: null,
        runtimeId: runtime.id,
        prompt: 'p',
        status,
      })
    make('queued')
    make('queued')
    const running = make('running')
    make('succeeded')
    repo.runUpdate(running.id, { status: 'running' })
    expect(repo.runtimeWorkloads()).toEqual([{ runtimeId: runtime.id, running: 1, queued: 2 }])
    // 未关联运行时的 run 不计入
    const orphan = createTask(world, { title: 't2', workflowId: createWorkflowSingle().id })
    repo.runCreate({
      taskId: orphan.id,
      stageId: null,
      agentId: null,
      runtimeId: null,
      prompt: 'p',
      status: 'running',
    })
    expect(repo.runtimeWorkloads()).toEqual([{ runtimeId: runtime.id, running: 1, queued: 2 }])
  })

  it('activeRunForTask：只认 queued/running，取最新一条', () => {
    const { task } = seed()
    expect(repo.activeRunForTask(task.id)).toBeNull()
    repo.runCreate({
      taskId: task.id,
      stageId: null,
      agentId: null,
      runtimeId: null,
      prompt: 'p',
      status: 'succeeded',
    })
    expect(repo.activeRunForTask(task.id)).toBeNull()
    const running = queuedRun(task.id)
    repo.runUpdate(running.id, { status: 'running' })
    expect(repo.activeRunForTask(task.id)?.id).toBe(running.id)
    // 失败后不再算「执行中」
    repo.runUpdate(running.id, { status: 'failed' })
    expect(repo.activeRunForTask(task.id)).toBeNull()
  })

  it('同一毫秒创建多条 run：按 rowid 取最新一条', () => {
    const { task } = seed()
    const first = queuedRun(task.id)
    const second = queuedRun(task.id)
    expect(repo.activeRunForTask(task.id)?.id).toBe(second.id)
    expect(repo.activeRunForTask(task.id)?.id).not.toBe(first.id)
  })
})

describe('repository：测试夹具 removeTask（T12b 覆盖率）', () => {
  it('走真实 task.remove 决策路径：产 task.removed 事实', () => {
    const { task } = seed()
    removeTask(world, task.id)

    const types = (
      world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
        type: string
      }>
    ).map((row) => row.type)
    expect(types).toContain('task.removed')
  })
})

/** 单阶段工作流（负载用例中用不到阶段，仅为满足任务外键）。 */
function createWorkflowSingle(): { id: string } {
  return createWorkflow(world, { name: 'w-extra', stages: [{ name: 's', entryMode: 'none' }] })
}
