import { describe, expect, it } from 'vitest'
import type { Task, WorkflowStage, WorkflowWithStages } from '../../../../../shared/ai-workflow-api'
import {
  enterStage,
  entryEffects,
  moveTask,
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

describe('moveTask', () => {
  const flow = wf([s0, s1, s2])
  const event = (e: StageEvent) => e

  it('当前阶段不在工作流 → 原样返回', () => {
    const t = task('ghost')
    expect(moveTask(t, event({ type: 'APPROVE' }), flow)).toEqual({ task: t, effects: [] })
  })

  it('任务已完成 → 原样返回', () => {
    const t = task('s1', 'completed')
    expect(moveTask(t, event({ type: 'APPROVE' }), flow)).toEqual({ task: t, effects: [] })
  })

  it.each<StageEvent>([
    { type: 'RUN_SUCCEEDED', runId: 'r' },
    { type: 'APPROVE' },
    { type: 'MOVE_NEXT' },
  ])('$type 推进到下一阶段', (e) => {
    const r = moveTask(task('s1'), e, flow)
    expect(r.task.currentStageId).toBe('s2')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([{ type: 'none' }])
  })

  it('RUN_SUCCEEDED 在最后阶段 → 任务完成', () => {
    const r = moveTask(task('s2'), event({ type: 'RUN_SUCCEEDED', runId: 'r' }), flow)
    expect(r.task.status).toBe('completed')
    expect(r.effects).toEqual([])
  })

  it.each<StageEvent>([{ type: 'RUN_FAILED', runId: 'r' }, { type: 'REJECT' }])(
    '$type 退回上一阶段',
    (e) => {
      const r = moveTask(task('s2'), e, flow)
      expect(r.task.currentStageId).toBe('s1')
      expect(r.task.status).toBe('active')
    },
  )

  it('REJECT 在首阶段 → 原地', () => {
    const r = moveTask(task('s0'), event({ type: 'REJECT' }), flow)
    expect(r.task.currentStageId).toBe('s0')
  })

  it('进入下一阶段时若是 user 阶段 → 产生 waitUser 效果', () => {
    const userS = stage({ id: 'u', position: 1, entryMode: 'user' })
    const f = wf([s0, userS])
    const r = moveTask(task('s0'), event({ type: 'APPROVE' }), f)
    expect(r.effects).toEqual([{ type: 'waitUser' }])
  })
})
