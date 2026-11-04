import { describe, expect, it } from 'vitest'
import type { Task, WorkflowStage, WorkflowWithStages } from './ai-workflow-api'
import {
  completeTask,
  enterStage,
  entryEffects,
  moveTask,
  moveTaskToStage,
  resolveNextStage,
  resolveRejectStage,
  type StageEvent,
} from './stage-machine'

function stage(partial: Partial<WorkflowStage> & { id: string; position: number }): WorkflowStage {
  return {
    workflowId: 'w1',
    name: partial.id,
    entryMode: 'none',
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
    ...partial,
  }
}

function wf(stages: WorkflowStage[]): WorkflowWithStages {
  return { id: 'w1', name: 'wf', description: '', createdAt: 't', stages }
}

function task(currentStageId: string | null, status: Task['status'] = 'active'): Task {
  return {
    id: 't1',
    title: '任务',
    description: '',
    workflowId: 'w1',
    currentStageId,
    status,
    createdAt: 't',
    updatedAt: 't',
  }
}

const s0 = stage({ id: 's0', position: 0 })
const s1 = stage({ id: 's1', position: 1 })
const s2 = stage({ id: 's2', position: 2 })

describe('entryEffects', () => {
  it('none → [{none}]', () => {
    expect(entryEffects(s0)).toEqual([{ type: 'none' }])
  })
  it('user → [{waitUser}]', () => {
    expect(entryEffects(stage({ id: 'u', position: 0, entryMode: 'user' }))).toEqual([
      { type: 'waitUser' },
    ])
  })
  it('agent 且配置了 agentId → createRun', () => {
    expect(
      entryEffects(stage({ id: 'a', position: 0, entryMode: 'agent', agentId: 'ag1' })),
    ).toEqual([{ type: 'createRun', stageId: 'a', agentId: 'ag1' }])
  })
  it('agent 但缺 agentId（异常兜底）→ []', () => {
    expect(
      entryEffects(stage({ id: 'a', position: 0, entryMode: 'agent', agentId: null })),
    ).toEqual([])
  })
})

describe('resolveNextStage', () => {
  it('显式配置且存在 → 该阶段', () => {
    const a = stage({ id: 'a', position: 0, onCompleteStageId: 's2' })
    expect(resolveNextStage(a, wf([a, s1, s2]))?.id).toBe('s2')
  })
  it('显式配置但目标不存在 → null', () => {
    const a = stage({ id: 'a', position: 0, onCompleteStageId: 'ghost' })
    expect(resolveNextStage(a, wf([a, s1]))).toBeNull()
  })
  it('未配置 → 下一顺序阶段', () => {
    expect(resolveNextStage(s1, wf([s0, s1, s2]))?.id).toBe('s2')
  })
  it('未配置且已是最后 → null（终端）', () => {
    expect(resolveNextStage(s2, wf([s0, s1, s2]))).toBeNull()
  })
  it('阶段不在工作流中 → null', () => {
    expect(resolveNextStage(stage({ id: 'zz', position: 9 }), wf([s0, s1]))).toBeNull()
  })
})

describe('resolveRejectStage', () => {
  it('显式配置且存在 → 该阶段', () => {
    const a = stage({ id: 'a', position: 2, onRejectStageId: 's0' })
    expect(resolveRejectStage(a, wf([s0, s1, a])).id).toBe('s0')
  })
  it('显式配置但目标不存在 → 回落到上一顺序阶段', () => {
    const a = stage({ id: 'a', position: 2, onRejectStageId: 'ghost' })
    expect(resolveRejectStage(a, wf([s0, s1, a])).id).toBe('s1')
  })
  it('未配置 → 上一顺序阶段', () => {
    expect(resolveRejectStage(s2, wf([s0, s1, s2])).id).toBe('s1')
  })
  it('未配置且已是首阶段 → 原地', () => {
    expect(resolveRejectStage(s0, wf([s0, s1])).id).toBe('s0')
  })
  it('阶段不在工作流中 → 原地', () => {
    const orphan = stage({ id: 'zz', position: 9 })
    expect(resolveRejectStage(orphan, wf([s0, s1]))).toBe(orphan)
  })
})

describe('enterStage', () => {
  it('进入阶段：更新 currentStageId、status=active、返回效果', () => {
    const userStage = stage({ id: 'u', position: 0, entryMode: 'user' })
    const r = enterStage(task(null, 'completed'), userStage, wf([userStage]))
    expect(r.task.currentStageId).toBe('u')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([{ type: 'waitUser' }])
  })
})

describe('moveTask（自动流转）', () => {
  const flow = wf([s0, s1, s2])

  it('当前阶段不在工作流 → 原样返回', () => {
    const t = task('ghost')
    const e: StageEvent = { type: 'RUN_SUCCEEDED', runId: 'r' }
    expect(moveTask(t, e, flow)).toEqual({ task: t, effects: [] })
  })

  it('任务已完成 → 原样返回', () => {
    const t = task('s1', 'completed')
    const e: StageEvent = { type: 'RUN_FAILED', runId: 'r' }
    expect(moveTask(t, e, flow)).toEqual({ task: t, effects: [] })
  })

  it('RUN_SUCCEEDED 推进到下一阶段', () => {
    const r = moveTask(task('s1'), { type: 'RUN_SUCCEEDED', runId: 'r' }, flow)
    expect(r.task.currentStageId).toBe('s2')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([{ type: 'none' }])
  })

  it('RUN_SUCCEEDED 在最后阶段 → 任务完成', () => {
    const r = moveTask(task('s2'), { type: 'RUN_SUCCEEDED', runId: 'r' }, flow)
    expect(r.task.status).toBe('completed')
    expect(r.effects).toEqual([])
  })

  it('RUN_FAILED 退回上一阶段', () => {
    const r = moveTask(task('s2'), { type: 'RUN_FAILED', runId: 'r' }, flow)
    expect(r.task.currentStageId).toBe('s1')
    expect(r.task.status).toBe('active')
  })

  it('RUN_FAILED 在首阶段 → 原地且不重触发进入效果（避免无限重试）', () => {
    const r = moveTask(task('s0'), { type: 'RUN_FAILED', runId: 'r' }, flow)
    expect(r.task.currentStageId).toBe('s0')
    expect(r.effects).toEqual([])
  })

  it('进入下一阶段时若是 user 阶段 → 产生 waitUser 效果', () => {
    const userS = stage({ id: 'u', position: 1, entryMode: 'user' })
    const f = wf([s0, userS])
    const r = moveTask(task('s0'), { type: 'RUN_SUCCEEDED', runId: 'r' }, f)
    expect(r.effects).toEqual([{ type: 'waitUser' }])
  })
})

describe('moveTaskToStage（手动拖拽）', () => {
  const flow = wf([s0, s1, s2])

  it('直接落到任意阶段，不套用完成后/打回目标', () => {
    // s0 配了「完成后进入 s2」，拖拽仍以落点为准
    const from = stage({ id: 's0', position: 0, onCompleteStageId: 's2' })
    const f = wf([from, s1, s2])
    const r = moveTaskToStage(task('s0'), 's1', f)
    expect(r.task.currentStageId).toBe('s1')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([{ type: 'none' }])
  })

  it('可以往回拖', () => {
    const r = moveTaskToStage(task('s2'), 's0', flow)
    expect(r.task.currentStageId).toBe('s0')
  })

  it('拖到 user / agent 阶段 → 产生对应进入效果', () => {
    const userS = stage({ id: 'u', position: 1, entryMode: 'user' })
    const agentS = stage({ id: 'a', position: 2, entryMode: 'agent', agentId: 'ag1' })
    expect(moveTaskToStage(task('s0'), 'u', wf([s0, userS])).effects).toEqual([
      { type: 'waitUser' },
    ])
    expect(moveTaskToStage(task('s0'), 'a', wf([s0, agentS])).effects).toEqual([
      { type: 'createRun', stageId: 'a', agentId: 'ag1' },
    ])
  })

  it('目标阶段不存在 → 原样返回', () => {
    const t = task('s0')
    expect(moveTaskToStage(t, 'ghost', flow)).toEqual({ task: t, effects: [] })
  })

  it('落在当前阶段 → 原样返回', () => {
    const t = task('s1')
    expect(moveTaskToStage(t, 's1', flow)).toEqual({ task: t, effects: [] })
  })

  it('已完成任务不参与拖拽', () => {
    const t = task('s1', 'completed')
    expect(moveTaskToStage(t, 's2', flow)).toEqual({ task: t, effects: [] })
  })
})

describe('completeTask', () => {
  it('标记为 completed，其余字段不变', () => {
    const t = task('s1')
    expect(completeTask(t)).toEqual({ ...t, status: 'completed' })
  })
})
