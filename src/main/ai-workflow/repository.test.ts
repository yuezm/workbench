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
  return repo.runtimeCreate({ name, command: 'dsh', args: ['-p', '{prompt}'] })
}
function seedAgent(name = 'coder') {
  const rt = seedRuntime()
  return repo.agentCreate({ name, runtimeId: rt.id, systemPrompt: 'you are coder' })
}

describe('repository runtimes/agents', () => {
  it('CRUD 运行时，名称唯一', () => {
    const rt = seedRuntime('ds')
    expect(rt.kind).toBe('deepseek-harness')
    expect(rt.args).toEqual(['-p', '{prompt}'])
    expect(() => seedRuntime('ds')).toThrow()
    const updated = repo.runtimeUpdate(rt.id, { name: 'ds2' })
    expect(updated.name).toBe('ds2')
    repo.runtimeRemove(rt.id)
    expect(repo.runtimesList()).toHaveLength(0)
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
  it('新建任务进入首阶段；级联删除', () => {
    const wf = repo.workflowCreate({
      name: 'wf',
      stages: [{ name: 's1', entryMode: 'none' }],
    })
    const task = repo.taskCreate({ title: '做点事', workflowId: wf.id })
    expect(task.currentStageId).toBe(wf.stages[0].id)
    expect(task.status).toBe('active')
    expect(repo.tasksList(wf.id)).toHaveLength(1)

    const run = repo.runCreate({
      taskId: task.id,
      stageId: wf.stages[0].id,
      agentId: null,
      prompt: 'p',
      status: 'queued',
    })
    expect(repo.runsListByTask(task.id)).toHaveLength(1)
    expect(repo.runUpdate(run.id, { status: 'running', startedAt: 't1' }).status).toBe('running')

    repo.workflowRemove(wf.id)
    expect(repo.tasksList(wf.id)).toHaveLength(0)
    expect(() => repo.runGet(run.id)).toThrow()
  })
})
