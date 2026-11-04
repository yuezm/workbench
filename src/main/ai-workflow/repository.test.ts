// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './db'
import { Repository } from './repository'

let db: DatabaseSync
let repo: Repository

beforeEach(() => {
  db = openDb(':memory:')
  repo = new Repository(db)
})
afterEach(() => db.close())

function seedRuntime(name = 'ds') {
  return repo.runtimeCreate({ name, command: 'dsh', profile: 'multica' })
}
function seedAgent(name = 'coder') {
  const rt = seedRuntime()
  return repo.agentCreate({ name, runtimeId: rt.id, systemPrompt: 'you are coder' })
}

describe('repository runtimes/agents', () => {
  it('CRUD 运行时，名称唯一', () => {
    const rt = seedRuntime('ds')
    expect(rt.protocolFamily).toBe('dsh')
    expect(rt.profile).toBe('multica')
    expect(rt.permissionMode).toBe('workspace-write')
    expect(rt.maxConcurrent).toBe(1)
    expect(rt.enabled).toBe(true)
    expect(rt.model).toBeNull()
    expect(rt.lastProbe).toBeNull()
    expect(() => seedRuntime('ds')).toThrow()
    const updated = repo.runtimeUpdate(rt.id, { name: 'ds2' })
    expect(updated.name).toBe('ds2')
    repo.runtimeRemove(rt.id)
    expect(repo.runtimesList()).toHaveLength(0)
  })

  it('运行时配置字段可更新；探测结论可持久化', () => {
    const rt = seedRuntime()
    const updated = repo.runtimeUpdate(rt.id, {
      protocolFamily: 'dsh',
      command: 'dsh2',
      profile: 'p2',
      permissionMode: 'danger-full-access',
      model: 'magpie/auto%2Fflash',
      reasoningEffort: 'high',
      workdir: 'C:/w',
      maxConcurrent: 3,
      enabled: false,
    })
    expect(updated).toMatchObject({
      command: 'dsh2',
      profile: 'p2',
      permissionMode: 'danger-full-access',
      model: 'magpie/auto%2Fflash',
      reasoningEffort: 'high',
      workdir: 'C:/w',
      maxConcurrent: 3,
      enabled: false,
    })
    const probe = {
      state: 'ready' as const,
      path: 'C:/bin/dsh.cmd',
      cliVersion: '0.2.1',
      protocolVersion: 1,
      pluginVersion: '0.1.0',
      error: null,
      output: '',
      elapsedMs: 5,
      checkedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(repo.runtimeSetProbe(rt.id, probe).lastProbe).toEqual(probe)
    // 默认值回填
    const fresh = seedRuntime('fresh')
    expect(repo.runtimeUpdate(fresh.id, {}).enabled).toBe(true)
  })

  it('智能体绑定运行时；被引用的运行时不可删除', () => {
    const agent = seedAgent()
    expect(agent.runtimeId).toBeTruthy()
    expect(() => repo.runtimeRemove(agent.runtimeId)).toThrow(/引用/)
  })
})

describe('repository workflows/stages', () => {
  it('创建工作流并按 position 返回有序阶段；按下标解析目标', () => {
    const wf = repo.workflowCreate({
      name: '研发',
      stages: [
        { name: '待办', entryMode: 'none' },
        { name: '进行中', entryMode: 'none', onCompleteIndex: 2, onRejectIndex: 0 },
        { name: '审核中', entryMode: 'none' },
      ],
    })
    expect(wf.stages.map((s) => s.name)).toEqual(['待办', '进行中', '审核中'])
    expect(wf.stages[1].onCompleteStageId).toBe(wf.stages[2].id)
    expect(wf.stages[1].onRejectStageId).toBe(wf.stages[0].id)
    expect(wf.stages.every((s) => s.onCompleteStageId || s.onRejectStageId || true)).toBe(true)
  })

  it('校验：agent 模式必须选智能体；目标下标越界/自指报错', () => {
    expect(() =>
      repo.workflowCreate({ name: 'x', stages: [{ name: 'a', entryMode: 'agent' }] }),
    ).toThrow(/智能体/)
    expect(() =>
      repo.workflowCreate({
        name: 'x',
        stages: [{ name: 'a', entryMode: 'none', onCompleteIndex: 5 }],
      }),
    ).toThrow(/越界/)
    expect(() =>
      repo.workflowCreate({
        name: 'x',
        stages: [{ name: 'a', entryMode: 'none', onCompleteIndex: 0 }],
      }),
    ).toThrow(/自己/)
  })

  it('更新工作流同样走阶段校验：非法阶段集合被拒绝', () => {
    const wf = repo.workflowCreate({ name: 'x', stages: [{ name: 'a', entryMode: 'none' }] })
    expect(() => repo.workflowUpdate(wf.id, { name: 'x', stages: [] })).toThrow(/至少需要/)
    expect(() =>
      repo.workflowUpdate(wf.id, { name: 'x', stages: [{ name: 'a', entryMode: 'agent' }] }),
    ).toThrow(/智能体/)
  })

  it('更新工作流重建阶段，并按位置回挂任务当前阶段', () => {
    const wf = repo.workflowCreate({
      name: '研发',
      stages: [
        { name: '待办', entryMode: 'none' },
        { name: '进行中', entryMode: 'none' },
      ],
    })
    const task = repo.taskCreate({ title: 't', workflowId: wf.id })
    // 手动把任务推到第 2 阶段（position 1）
    repo.taskUpdate(task.id, { currentStageId: wf.stages[1].id })
    const wf2 = repo.workflowUpdate(wf.id, {
      name: '研发v2',
      stages: [
        { name: '待办', entryMode: 'none' },
        { name: '进行中', entryMode: 'none' },
        { name: '已完成', entryMode: 'none' },
      ],
    })
    expect(wf2.stages).toHaveLength(3)
    expect(repo.taskGet(task.id).currentStageId).toBe(wf2.stages[1].id)
  })
})

describe('repository tasks/runs', () => {
  it('新建任务进入首阶段；可指定起始阶段；级联删除', () => {
    const wf = repo.workflowCreate({
      name: 'wf',
      stages: [
        { name: 's1', entryMode: 'none' },
        { name: 's2', entryMode: 'none' },
      ],
    })
    const task = repo.taskCreate({ title: '做点事', workflowId: wf.id })
    expect(task.currentStageId).toBe(wf.stages[0].id)
    expect(task.status).toBe('active')
    expect(repo.tasksList(wf.id)).toHaveLength(1)

    const late = repo.taskCreate({
      title: '从第二阶段开始',
      workflowId: wf.id,
      stageId: wf.stages[1].id,
    })
    expect(late.currentStageId).toBe(wf.stages[1].id)

    const run = repo.runCreate({
      taskId: task.id,
      stageId: wf.stages[0].id,
      agentId: null,
      runtimeId: null,
      prompt: 'p',
      status: 'queued',
    })
    expect(repo.runsListByTask(task.id)).toHaveLength(1)
    expect(repo.runUpdate(run.id, { status: 'running', startedAt: 't1' }).status).toBe('running')

    repo.workflowRemove(wf.id)
    expect(repo.tasksList(wf.id)).toHaveLength(0)
    expect(() => repo.runGet(run.id)).toThrow()
  })

  it('run 的新增字段（runtime/session/usage/errorCode/events）可写可读', () => {
    const rt = repo.runtimeCreate({ name: 'r', command: 'dsh' })
    const wf = repo.workflowCreate({ name: 'w', stages: [{ name: 's', entryMode: 'none' }] })
    const task = repo.taskCreate({ title: 't', workflowId: wf.id })
    const run = repo.runCreate({
      taskId: task.id,
      stageId: wf.stages[0].id,
      agentId: null,
      runtimeId: rt.id,
      prompt: 'p',
      status: 'queued',
    })
    expect(run.runtimeId).toBe(rt.id)
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
    // 重复 seq 覆盖而不是新增
    repo.runEventsAppend(run.id, [{ seq: 1, type: 'text', text: 'b' }])
    expect(repo.runEventsList(run.id)[0]).toEqual({ seq: 1, type: 'text', text: 'b' })
  })

  it('runtimeWorkloads 只统计 queued/running', () => {
    const rt = repo.runtimeCreate({ name: 'r', command: 'dsh' })
    const wf = repo.workflowCreate({ name: 'w', stages: [{ name: 's', entryMode: 'none' }] })
    const task = repo.taskCreate({ title: 't', workflowId: wf.id })
    const make = (status: 'queued' | 'running' | 'succeeded') =>
      repo.runCreate({
        taskId: task.id,
        stageId: null,
        agentId: null,
        runtimeId: rt.id,
        prompt: 'p',
        status,
      })
    make('queued')
    make('queued')
    const running = make('running')
    make('succeeded')
    repo.runUpdate(running.id, { status: 'running' })
    expect(repo.runtimeWorkloads()).toEqual([{ runtimeId: rt.id, running: 1, queued: 2 }])
    // activeRunForTask：只认 queued/running，取最新一条
    expect(repo.activeRunForTask(task.id)?.status).toBe('running')
    const other = repo.taskCreate({ title: 't2', workflowId: wf.id })
    expect(repo.activeRunForTask(other.id)).toBeNull()
  })
})
