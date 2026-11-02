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

describe('repository 错误分支与补充路径', () => {
  it('get 不存在的实体都抛错', () => {
    expect(() => repo.runtimeGet('x')).toThrow(/不存在/)
    expect(() => repo.agentGet('x')).toThrow(/不存在/)
    expect(() => repo.workflowGet('x')).toThrow(/不存在/)
    expect(() => repo.taskGet('x')).toThrow(/不存在/)
  })

  it('创建校验：必填与阶段校验', () => {
    expect(() => repo.runtimeCreate({ name: '', command: 'x' })).toThrow(/名称/)
    expect(() => repo.runtimeCreate({ name: 'n', command: '' })).toThrow(/命令/)
    expect(() => repo.agentCreate({ name: '', runtimeId: 'x' })).toThrow(/名称/)
    expect(() => repo.taskCreate({ title: '', workflowId: 'x' })).toThrow(/标题/)
    expect(() =>
      repo.workflowCreate({ name: '', stages: [{ name: 'a', entryMode: 'none' }] }),
    ).toThrow(/名称/)
    expect(() => repo.workflowCreate({ name: 'w', stages: [] })).toThrow(/至少/)
    expect(() =>
      repo.workflowCreate({ name: 'w', stages: [{ name: '', entryMode: 'none' }] }),
    ).toThrow(/名称/)
  })

  it('事务回滚：阶段引用不存在的智能体时整体失败', () => {
    expect(() =>
      repo.workflowCreate({
        name: 'w',
        stages: [{ name: 'a', entryMode: 'agent', agentId: 'ghost' }],
      }),
    ).toThrow()
    expect(repo.workflowsList()).toHaveLength(0)
  })

  it('agentsList / agentUpdate / agentRemove', () => {
    const rt = repo.runtimeCreate({ name: 'ds', command: 'dsh' })
    const ag = repo.agentCreate({ name: 'a', runtimeId: rt.id })
    expect(repo.agentsList().map((x) => x.name)).toEqual(['a'])
    const up = repo.agentUpdate(ag.id, { name: 'b', description: 'd' })
    expect(up.name).toBe('b')
    expect(up.description).toBe('d')

    repo.workflowCreate({
      name: 'w',
      stages: [{ name: 's', entryMode: 'agent', agentId: ag.id }],
    })
    expect(() => repo.agentRemove(ag.id)).toThrow(/引用/)
  })

  it('workflowUpdate 校验名称；completed 任务（current_stage_id 为空）重建时跳过回挂', () => {
    const wf = repo.workflowCreate({
      name: 'w',
      stages: [
        { name: 'a', entryMode: 'none' },
        { name: 'b', entryMode: 'none' },
      ],
    })
    expect(() => repo.workflowUpdate(wf.id, { name: '', stages: wf.stages })).toThrow(/名称/)
    const task = repo.taskCreate({ title: 't', workflowId: wf.id })
    repo.taskUpdate(task.id, { currentStageId: null })
    const upd = repo.workflowUpdate(wf.id, {
      name: 'w2',
      stages: [{ name: 'x', entryMode: 'none' }],
    })
    expect(upd.stages).toHaveLength(1)
  })

  it('update 各实体的可选字段分支', () => {
    const rt = repo.runtimeCreate({ name: 'n', command: 'c' })
    // patch 只给 workdir：覆盖 name 缺省与 workdir 两种分支
    expect(repo.runtimeUpdate(rt.id, { workdir: '/x' }).workdir).toBe('/x')
    expect(repo.runtimeUpdate(rt.id, { workdir: null }).workdir).toBeNull()

    const ag = repo.agentCreate({ name: 'a', runtimeId: rt.id })
    expect(repo.agentUpdate(ag.id, { runtimeId: rt.id }).name).toBe('a')

    const wf = repo.workflowCreate({ name: 'w', stages: [{ name: 's', entryMode: 'none' }] })
    const t = repo.taskCreate({ title: 't', workflowId: wf.id })
    expect(repo.taskUpdate(t.id, { title: 't2' }).currentStageId).toBe(t.currentStageId)

    const run = repo.runCreate({
      taskId: t.id,
      stageId: null,
      agentId: null,
      prompt: 'p',
      status: 'queued',
    })
    expect(repo.runUpdate(run.id, { output: 'o' }).status).toBe('queued')
  })
})
