import { describe, expect, it } from 'vitest'
import type { Task, WorkflowStage, WorkflowWithStages } from '../../../src/protocol/entities'
import {
  completeTask,
  enterStage,
  entryEffects,
  exitsForward,
  moveTask,
  moveTaskToStage,
  resolveNextStage,
  resolveRejectStage,
  type StageEvent,
} from '../../../src/kernel/workflow/stage-machine'

const stage = (id: string, over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id,
  workflowId: 'wf',
  name: id,
  position: 0,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffWorkflowId: null,
  handoffStageId: null,
  ...over,
})

const workflow = (): WorkflowWithStages => ({
  id: 'wf',
  name: 'wf',
  description: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  stages: [stage('s0'), stage('s1'), stage('s2', { entryMode: 'user' })],
})

const task = (currentStageId: string | null): Task => ({
  id: 't1',
  title: 't',
  description: '',
  workflowId: 'wf',
  projectId: null,
  currentStageId,
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('kernel 阶段状态机', () => {
  it('RUN_SUCCEEDED 推进到下一阶段', () => {
    const { task: next, effects } = moveTask(
      task('s0'),
      { type: 'RUN_SUCCEEDED', runId: 'r1' },
      workflow(),
    )

    expect(next.currentStageId).toBe('s1')
    expect(effects).toEqual([{ type: 'none' }])
  })

  it('RUN_FAILED 打回原地时零效果，不重建 run', () => {
    const { task: next, effects } = moveTask(
      task('s0'),
      { type: 'RUN_FAILED', runId: 'r1' },
      workflow(),
    )

    expect(next.currentStageId).toBe('s0')
    expect(effects).toEqual([])
  })

  it('手动拖拽到不存在的阶段时原样返回', () => {
    const current = task('s0')

    expect(moveTaskToStage(current, 'ghost', workflow())).toEqual({ task: current, effects: [] })
  })

  it('RUN_SUCCEEDED 按 onCompleteStageId 跳过中间阶段', () => {
    const flow: WorkflowWithStages = {
      ...workflow(),
      stages: [
        stage('s0', { onCompleteStageId: 's2' }),
        stage('s1'),
        stage('s2', { entryMode: 'agent', agentId: 'ag1' }),
      ],
    }

    const { task: next, effects } = moveTask(
      task('s0'),
      { type: 'RUN_SUCCEEDED', runId: 'r1' },
      flow,
    )

    expect(next.currentStageId).toBe('s2')
    expect(effects).toEqual([{ type: 'createRun', stageId: 's2', agentId: 'ag1' }])
  })

  it('RUN_FAILED 按 onRejectStageId 打回非原地并重触发进入效果', () => {
    const flow: WorkflowWithStages = {
      ...workflow(),
      stages: [
        stage('s0', { entryMode: 'agent', agentId: 'ag0' }),
        stage('s1'),
        stage('s2', { onRejectStageId: 's0' }),
      ],
    }

    const { task: next, effects } = moveTask(task('s2'), { type: 'RUN_FAILED', runId: 'r1' }, flow)

    expect(next.currentStageId).toBe('s0')
    expect(effects).toEqual([{ type: 'createRun', stageId: 's0', agentId: 'ag0' }])
  })
})

// ---------- 原 tests/shared/stage-machine.test.ts 的 29 例并入（M0 re-export 删除，T16） ----------

function sStage(partial: Partial<WorkflowStage> & { id: string; position: number }): WorkflowStage {
  return {
    workflowId: 'w1',
    name: partial.id,
    entryMode: 'none',
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
    handoffWorkflowId: null,
    handoffStageId: null,
    ...partial,
  }
}

function sWf(stages: WorkflowStage[]): WorkflowWithStages {
  return { id: 'w1', name: 'wf', description: '', createdAt: 't', stages }
}

function sTask(currentStageId: string | null, status: Task['status'] = 'active'): Task {
  return {
    id: 't1',
    title: '任务',
    description: '',
    workflowId: 'w1',
    projectId: null,
    currentStageId,
    status,
    origin: 'manual',
    ruleId: null,
    externalRef: null,
    labels: [],
    threadId: null,
    parentTaskId: null,
    handoffFromTaskId: null,
    handoffFromStageId: null,
    createdAt: 't',
    updatedAt: 't',
  }
}

const s0 = sStage({ id: 's0', position: 0 })
const s1 = sStage({ id: 's1', position: 1 })
const s2 = sStage({ id: 's2', position: 2 })

describe('stage-machine（shared 用例并入）entryEffects', () => {
  it('none → [{none}]', () => {
    expect(entryEffects(s0)).toEqual([{ type: 'none' }])
  })
  it('user → [{waitUser}]', () => {
    expect(entryEffects(sStage({ id: 'u', position: 0, entryMode: 'user' }))).toEqual([
      { type: 'waitUser' },
    ])
  })
  it('agent 且配置了 agentId → createRun', () => {
    expect(
      entryEffects(sStage({ id: 'a', position: 0, entryMode: 'agent', agentId: 'ag1' })),
    ).toEqual([{ type: 'createRun', stageId: 'a', agentId: 'ag1' }])
  })
  it('agent 但缺 agentId（异常兜底）→ []', () => {
    expect(
      entryEffects(sStage({ id: 'a', position: 0, entryMode: 'agent', agentId: null })),
    ).toEqual([])
  })
})

describe('stage-machine（shared 用例并入）resolveNextStage', () => {
  it('显式配置且存在 → 该阶段', () => {
    const a = sStage({ id: 'a', position: 0, onCompleteStageId: 's2' })
    expect(resolveNextStage(a, sWf([a, s1, s2]))?.id).toBe('s2')
  })
  it('显式配置但目标不存在 → null', () => {
    const a = sStage({ id: 'a', position: 0, onCompleteStageId: 'ghost' })
    expect(resolveNextStage(a, sWf([a, s1]))).toBeNull()
  })
  it('未配置 → 下一顺序阶段', () => {
    expect(resolveNextStage(s1, sWf([s0, s1, s2]))?.id).toBe('s2')
  })
  it('未配置且已是最后 → null（终端）', () => {
    expect(resolveNextStage(s2, sWf([s0, s1, s2]))).toBeNull()
  })
  it('阶段不在工作流中 → null', () => {
    expect(resolveNextStage(sStage({ id: 'zz', position: 9 }), sWf([s0, s1]))).toBeNull()
  })
})

describe('stage-machine（shared 用例并入）resolveRejectStage', () => {
  it('显式配置且存在 → 该阶段', () => {
    const a = sStage({ id: 'a', position: 2, onRejectStageId: 's0' })
    expect(resolveRejectStage(a, sWf([s0, s1, a])).id).toBe('s0')
  })
  it('显式配置但目标不存在 → 回落到原地（不指定）', () => {
    const a = sStage({ id: 'a', position: 2, onRejectStageId: 'ghost' })
    expect(resolveRejectStage(a, sWf([s0, s1, a])).id).toBe('a')
  })
  it('未配置（不指定）→ 原地', () => {
    expect(resolveRejectStage(s2, sWf([s0, s1, s2])).id).toBe('s2')
  })
  it('未配置且已是首阶段 → 原地', () => {
    expect(resolveRejectStage(s0, sWf([s0, s1])).id).toBe('s0')
  })
  it('阶段不在工作流中 → 原地', () => {
    const orphan = sStage({ id: 'zz', position: 9 })
    expect(resolveRejectStage(orphan, sWf([s0, s1]))).toBe(orphan)
  })
})

describe('stage-machine（shared 用例并入）enterStage', () => {
  it('进入阶段：更新 currentStageId、status=active、返回效果', () => {
    const userStage = sStage({ id: 'u', position: 0, entryMode: 'user' })
    const r = enterStage(sTask(null, 'completed'), userStage, sWf([userStage]))
    expect(r.task.currentStageId).toBe('u')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([{ type: 'waitUser' }])
  })
})

describe('stage-machine（shared 用例并入）moveTask（自动流转）', () => {
  const flow = sWf([s0, s1, s2])

  it('当前阶段不在工作流 → 原样返回', () => {
    const t = sTask('ghost')
    const e: StageEvent = { type: 'RUN_SUCCEEDED', runId: 'r' }
    expect(moveTask(t, e, flow)).toEqual({ task: t, effects: [] })
  })

  it('任务已完成 → 原样返回', () => {
    const t = sTask('s1', 'completed')
    const e: StageEvent = { type: 'RUN_FAILED', runId: 'r' }
    expect(moveTask(t, e, flow)).toEqual({ task: t, effects: [] })
  })

  it('RUN_SUCCEEDED 推进到下一阶段', () => {
    const r = moveTask(sTask('s1'), { type: 'RUN_SUCCEEDED', runId: 'r' }, flow)
    expect(r.task.currentStageId).toBe('s2')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([{ type: 'none' }])
  })

  it('RUN_SUCCEEDED 在最后阶段 → 任务完成', () => {
    const r = moveTask(sTask('s2'), { type: 'RUN_SUCCEEDED', runId: 'r' }, flow)
    expect(r.task.status).toBe('completed')
    expect(r.effects).toEqual([])
  })

  it('RUN_FAILED 未配置打回目标 → 原地不动', () => {
    const r = moveTask(sTask('s2'), { type: 'RUN_FAILED', runId: 'r' }, flow)
    expect(r.task.currentStageId).toBe('s2')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([])
  })

  it('RUN_FAILED 在首阶段 → 原地且不重触发进入效果（避免无限重试）', () => {
    const r = moveTask(sTask('s0'), { type: 'RUN_FAILED', runId: 'r' }, flow)
    expect(r.task.currentStageId).toBe('s0')
    expect(r.effects).toEqual([])
  })

  it('进入下一阶段时若是 user 阶段 → 产生 waitUser 效果', () => {
    const userS = sStage({ id: 'u', position: 1, entryMode: 'user' })
    const f = sWf([s0, userS])
    const r = moveTask(sTask('s0'), { type: 'RUN_SUCCEEDED', runId: 'r' }, f)
    expect(r.effects).toEqual([{ type: 'waitUser' }])
  })
})

describe('stage-machine（shared 用例并入）moveTaskToStage（手动拖拽）', () => {
  const flow = sWf([s0, s1, s2])

  it('直接落到任意阶段，不套用完成后/打回目标', () => {
    // s0 配了「完成后进入 s2」，拖拽仍以落点为准
    const from = sStage({ id: 's0', position: 0, onCompleteStageId: 's2' })
    const f = sWf([from, s1, s2])
    const r = moveTaskToStage(sTask('s0'), 's1', f)
    expect(r.task.currentStageId).toBe('s1')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([{ type: 'none' }])
  })

  it('可以往回拖', () => {
    const r = moveTaskToStage(sTask('s2'), 's0', flow)
    expect(r.task.currentStageId).toBe('s0')
  })

  it('拖到 user / agent 阶段 → 产生对应进入效果', () => {
    const userS = sStage({ id: 'u', position: 1, entryMode: 'user' })
    const agentS = sStage({ id: 'a', position: 2, entryMode: 'agent', agentId: 'ag1' })
    expect(moveTaskToStage(sTask('s0'), 'u', sWf([s0, userS])).effects).toEqual([
      { type: 'waitUser' },
    ])
    expect(moveTaskToStage(sTask('s0'), 'a', sWf([s0, agentS])).effects).toEqual([
      { type: 'createRun', stageId: 'a', agentId: 'ag1' },
    ])
  })

  it('目标阶段不存在 → 原样返回', () => {
    const t = sTask('s0')
    expect(moveTaskToStage(t, 'ghost', flow)).toEqual({ task: t, effects: [] })
  })

  it('落在当前阶段 → 原样返回', () => {
    const t = sTask('s1')
    expect(moveTaskToStage(t, 's1', flow)).toEqual({ task: t, effects: [] })
  })

  it('已完成任务不参与拖拽', () => {
    const t = sTask('s1', 'completed')
    expect(moveTaskToStage(t, 's2', flow)).toEqual({ task: t, effects: [] })
  })
})

describe('stage-machine（shared 用例并入）completeTask', () => {
  it('标记为 completed，其余字段不变', () => {
    const t = sTask('s1')
    expect(completeTask(t)).toEqual({ ...t, status: 'completed' })
  })
})

describe('stage-machine exitsForward（M7 交接触发判定）', () => {
  it('成功流转到更后阶段 / 任务完成 → 向前', () => {
    expect(exitsForward({ from: s0, to: s2, succeeded: true })).toBe(true)
    expect(exitsForward({ from: s2, to: null, succeeded: true })).toBe(true)
  })

  it('原地 / 拖回更前阶段 → 不向前', () => {
    expect(exitsForward({ from: s1, to: s1, succeeded: true })).toBe(false)
    expect(exitsForward({ from: s2, to: s0, succeeded: true })).toBe(false)
  })

  it('打回（成功标记为 false）→ 不向前，即使 onReject 配到更后阶段', () => {
    expect(exitsForward({ from: s1, to: s0, succeeded: false })).toBe(false)
    expect(exitsForward({ from: s0, to: s2, succeeded: false })).toBe(false)
  })
})

describe('stage-machine 闸门（M11）', () => {
  /** 执行 → 自测（闸门，失败退回执行）→ 结束 */
  const gateFlow = (over: Partial<WorkflowStage> = {}): WorkflowWithStages =>
    sWf([
      sStage({ id: 'exec', position: 0 }),
      sStage({
        id: 'test',
        position: 1,
        entryMode: 'agent',
        agentId: 'ag1',
        gate: { maxFails: 3, onPassStageId: 'done', onFailStageId: 'exec' },
        ...over,
      }),
      sStage({ id: 'done', position: 2 }),
    ])

  it('通过 → 走 onPassStageId，预算清零', () => {
    const r = moveTask(
      { ...sTask('test'), gateFails: 2 },
      { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'pass' },
      gateFlow(),
    )
    expect(r.task.currentStageId).toBe('done')
    expect(r.task.gateFails).toBe(0)
    expect(r.gateExhausted).toBeUndefined()
  })

  it('通过且未配 onPass → 按默认下一阶段', () => {
    const f = sWf([
      sStage({ id: 'exec', position: 0 }),
      sStage({
        id: 'test',
        position: 1,
        entryMode: 'agent',
        agentId: 'ag1',
        gate: { maxFails: 2, onPassStageId: null, onFailStageId: 'exec' },
      }),
      sStage({ id: 'done', position: 2 }),
    ])
    const r = moveTask(sTask('test'), { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'pass' }, f)
    expect(r.task.currentStageId).toBe('done')
  })

  it('未通过且未达上限 → 走 onFailStageId 并累计次数', () => {
    const r = moveTask(
      { ...sTask('test'), gateFails: 0 },
      { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'fail' },
      gateFlow(),
    )
    expect(r.task.currentStageId).toBe('exec')
    expect(r.task.gateFails).toBe(1)
    expect(r.gateExhausted).toBeUndefined()
  })

  it('第 maxFails 次未通过 → 放行走通过分支，预算清零并标记 gateExhausted', () => {
    const r = moveTask(
      { ...sTask('test'), gateFails: 2 },
      { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'fail' },
      gateFlow(),
    )
    expect(r.task.currentStageId).toBe('done')
    expect(r.task.gateFails).toBe(0)
    expect(r.gateExhausted).toBe(true)
  })

  it('未通过且未配失败去向 → 原地累计次数、不重建 run', () => {
    const f = sWf([
      sStage({ id: 'exec', position: 0 }),
      sStage({
        id: 'test',
        position: 1,
        entryMode: 'agent',
        agentId: 'ag1',
        gate: { maxFails: 3, onPassStageId: 'done', onFailStageId: null },
      }),
      sStage({ id: 'done', position: 2 }),
    ])
    const r = moveTask(sTask('test'), { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'fail' }, f)
    expect(r.task.currentStageId).toBe('test')
    expect(r.task.gateFails).toBe(1)
    expect(r.effects).toEqual([])
  })

  it('没给 verdict → 原地停住，不消耗预算也不放行', () => {
    const before = { ...sTask('test'), gateFails: 1 }
    const r = moveTask(before, { type: 'RUN_SUCCEEDED', runId: 'r' }, gateFlow())
    expect(r.task).toEqual(before)
    expect(r.effects).toEqual([])
    expect(r.gateExhausted).toBeUndefined()
  })

  it('执行出错（RUN_FAILED）不消耗闸门预算，仍按 onReject 走', () => {
    const f = sWf([
      sStage({ id: 'exec', position: 0 }),
      sStage({
        id: 'test',
        position: 1,
        entryMode: 'agent',
        agentId: 'ag1',
        onRejectStageId: 'exec',
        gate: { maxFails: 3, onPassStageId: 'done', onFailStageId: 'exec' },
      }),
      sStage({ id: 'done', position: 2 }),
    ])
    const r = moveTask({ ...sTask('test'), gateFails: 2 }, { type: 'RUN_FAILED', runId: 'r' }, f)
    expect(r.task.currentStageId).toBe('exec')
    expect(r.task.gateFails).toBe(2)
  })

  it('非闸门阶段带 verdict 也按普通成功流转', () => {
    const r = moveTask(
      sTask('exec'),
      { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'fail' },
      gateFlow(),
    )
    expect(r.task.currentStageId).toBe('test')
    expect(r.task.gateFails).toBe(0)
  })

  it('闸门阶段到达终点：放行后任务完成，预算清零', () => {
    const f = sWf([
      sStage({
        id: 'test',
        position: 0,
        entryMode: 'agent',
        agentId: 'ag1',
        gate: { maxFails: 1, onPassStageId: null, onFailStageId: null },
      }),
    ])
    const r = moveTask({ ...sTask('test'), gateFails: 0 }, { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'fail' }, f)
    expect(r.task.status).toBe('completed')
    expect(r.task.gateFails).toBe(0)
    expect(r.gateExhausted).toBe(true)
  })

  it('人工拖拽落位视为重新开始：预算清零', () => {
    const r = moveTaskToStage({ ...sTask('exec'), gateFails: 3 }, 'test', gateFlow())
    expect(r.task.gateFails).toBe(0)
  })
})
