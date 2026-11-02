// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db'
import { advanceTask, applyEffects, enterTaskStage } from './engine'
import { Repository } from './repository'
import type { Task } from '../../shared/ai-workflow-api'

let db: DatabaseSync
let repo: Repository

beforeEach(() => {
  db = openDb(':memory:')
  repo = new Repository(db)
})
afterEach(() => db.close())

function seed() {
  const rt = repo.runtimeCreate({ name: 'ds', command: 'dsh' })
  const ag = repo.agentCreate({ name: 'a', runtimeId: rt.id, systemPrompt: 'sys' })
  const wf = repo.workflowCreate({
    name: 'w',
    stages: [
      { name: 's0', entryMode: 'none' },
      { name: 's1', entryMode: 'agent', agentId: ag.id },
    ],
  })
  return { ag, wf }
}

describe('engine', () => {
  it('applyEffects：非 createRun 效果跳过；createRun 入队并回调', () => {
    const { wf } = seed()
    const task = repo.taskCreate({ title: 'T', workflowId: wf.id })
    const onQueue = vi.fn()
    expect(applyEffects(repo, task, [{ type: 'none' }, { type: 'waitUser' }], onQueue)).toEqual([])
    expect(onQueue).not.toHaveBeenCalled()

    const ids = applyEffects(
      repo,
      task,
      [{ type: 'createRun', stageId: wf.stages[1].id, agentId: repo.agentsList()[0].id }],
      onQueue,
    )
    expect(ids).toHaveLength(1)
    expect(onQueue).toHaveBeenCalledWith(ids[0])
  })

  it('applyEffects：阶段不在工作流中时 prompt 不含阶段名', () => {
    const { wf } = seed()
    const task = repo.taskCreate({ title: 'T', workflowId: wf.id })
    const agent = repo.agentsList()[0]
    const other = repo.workflowCreate({ name: 'other', stages: [{ name: 'x', entryMode: 'none' }] })
    const ids = applyEffects(
      repo,
      task,
      [{ type: 'createRun', stageId: other.stages[0].id, agentId: agent.id }],
      () => {},
    )
    expect(repo.runGet(ids[0]).prompt).not.toContain('# 阶段')
  })

  it('enterTaskStage：none 阶段不产生 run；agent 阶段产生 run', () => {
    const { wf } = seed()
    const task = repo.taskCreate({ title: 'T', workflowId: wf.id })
    const onQueue = vi.fn()
    enterTaskStage(repo, task, onQueue)
    expect(onQueue).not.toHaveBeenCalled()

    repo.taskUpdate(task.id, { currentStageId: wf.stages[1].id })
    enterTaskStage(repo, repo.taskGet(task.id), onQueue)
    expect(onQueue).toHaveBeenCalledTimes(1)
  })

  it('advanceTask：当前阶段无效时抛错', () => {
    const { wf } = seed()
    const task = repo.taskCreate({ title: 'T', workflowId: wf.id })
    repo.taskUpdate(task.id, { currentStageId: null })
    expect(() => advanceTask(repo, task.id, { type: 'MOVE_NEXT' }, () => {})).toThrow(/无效/)
  })

  it('advanceTask：推进到终端完成', () => {
    const { wf } = seed()
    const task = repo.taskCreate({ title: 'T', workflowId: wf.id }) as Task
    // 直接放到最后一个阶段并无下一阶段：更新工作流仅一阶段
    const one = repo.workflowUpdate(wf.id, {
      name: 'w',
      stages: [{ name: 'only', entryMode: 'none' }],
    })
    repo.taskUpdate(task.id, { currentStageId: one.stages[0].id })
    const done = advanceTask(repo, task.id, { type: 'MOVE_NEXT' }, () => {})
    expect(done.status).toBe('completed')
  })
})
