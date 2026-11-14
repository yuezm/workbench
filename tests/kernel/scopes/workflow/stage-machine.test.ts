// @vitest-environment node
import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  JudgeConfig,
  StageExitGuard,
  StageExits,
  StagePrimary,
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../src/protocol/entities'
import { STAGE_EXIT_ACTIONS } from '../../../../src/protocol/entities'
import {
  completeExits,
  completeTask,
  enterStage,
  entryEffects,
  legacyExits,
  legacyJudge,
  moveTask,
  moveTaskToStage,
  resolveNextStage,
  applyExit,
  type StageEvent,
} from '../../../../src/kernel/scopes/workflow/stage-machine'

const stage = (id: string, over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id,
  workflowId: 'wf',
  name: id,
  position: 0,
  entryMode: 'none',
  agentId: null,
  exits: {},
  judge: null,
  handoffs: [],
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
  handoffFromRunId: null,
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
        stage('s0', { exits: { done: { do: 'goto', stageId: 's2' } } }),
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
        stage('s2', { exits: { errored: { do: 'goto', stageId: 's0' } } }),
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
    exits: {},
    judge: null,
    handoffs: [],
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
    handoffFromRunId: null,
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
    const a = sStage({ id: 'a', position: 0, exits: { done: { do: 'goto', stageId: 's2' } } })
    expect(resolveNextStage(a, sWf([a, s1, s2]))?.id).toBe('s2')
  })
  it('显式配置但目标不存在 → null', () => {
    const a = sStage({ id: 'a', position: 0, exits: { done: { do: 'goto', stageId: 'ghost' } } })
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

describe('stage-machine applyExit（M32：主去向）', () => {
  const flow = (): WorkflowWithStages => sWf([s0, s1, s2])

  it('goto：换阶段并清零预算', () => {
    const r = applyExit({ ...sTask('s0'), gateFails: 2 }, { do: 'goto', stageId: 's1' }, flow())

    expect(r.task.currentStageId).toBe('s1')
    expect(r.task.gateFails).toBe(0)
  })

  it('goto 目标不存在（脏投影）→ 原样不动、零效果', () => {
    const task = sTask('s0')
    const r = applyExit(task, { do: 'goto', stageId: 'ghost' }, flow())

    expect(r.task).toBe(task)
    expect(r.effects).toEqual([])
  })

  it('await：不流转，但预算按传入值落下', () => {
    const r = applyExit({ ...sTask('s1'), gateFails: 1 }, { do: 'await' }, flow(), { gateFails: 2 })

    expect(r.task.currentStageId).toBe('s1')
    expect(r.task.gateFails).toBe(2)
  })

  it('close：任务完成并清零预算', () => {
    const r = applyExit({ ...sTask('s1'), gateFails: 2 }, { do: 'close' }, flow())

    expect(r.task.status).toBe('completed')
    expect(r.task.gateFails).toBe(0)
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
    const from = sStage({ id: 's0', position: 0, exits: { done: { do: 'goto', stageId: 's2' } } })
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
        judge: { maxFails: 3 },
        exits: { passed: { do: 'goto', stageId: 'done' }, failed: { do: 'goto', stageId: 'exec' } },
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
        judge: { maxFails: 2 },
        exits: { failed: { do: 'goto', stageId: 'exec' } },
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
        judge: { maxFails: 3 },
        exits: { passed: { do: 'goto', stageId: 'done' } },
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
        judge: { maxFails: 3 },
        exits: {
          errored: { do: 'goto', stageId: 'exec' },
          passed: { do: 'goto', stageId: 'done' },
          failed: { do: 'goto', stageId: 'exec' },
        },
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
        judge: { maxFails: 1 },
        exits: {},
      }),
    ])
    const r = moveTask(
      { ...sTask('test'), gateFails: 0 },
      { type: 'RUN_SUCCEEDED', runId: 'r', verdict: 'fail' },
      f,
    )
    expect(r.task.status).toBe('completed')
    expect(r.task.gateFails).toBe(0)
    expect(r.gateExhausted).toBe(true)
  })

  it('人工拖拽落位视为重新开始：预算清零', () => {
    const r = moveTaskToStage({ ...sTask('exec'), gateFails: 3 }, 'test', gateFlow())
    expect(r.task.gateFails).toBe(0)
  })
})

describe('kernel 闸门目标缺失（脏投影）', () => {
  it('闸门「通过时进入」指向已不存在的阶段：原地停住，不猜去向', () => {
    const flow: WorkflowWithStages = {
      ...workflow(),
      stages: [
        stage('s0', {
          judge: { maxFails: 2 },
          exits: { passed: { do: 'goto', stageId: 'ghost' } },
        }),
        stage('s1'),
      ],
    }

    const { task: next } = moveTask(
      task('s0'),
      { type: 'RUN_SUCCEEDED', runId: 'r1', verdict: 'pass' },
      flow,
    )
    expect(next.currentStageId).toBe('s0')
  })

  it('闸门「未通过时进入」指向已不存在的阶段：原地累计次数，不重建 run', () => {
    const flow: WorkflowWithStages = {
      ...workflow(),
      stages: [
        stage('s0', {
          judge: { maxFails: 3 },
          exits: { failed: { do: 'goto', stageId: 'ghost' } },
        }),
        stage('s1'),
      ],
    }

    const { task: next, effects } = moveTask(
      task('s0'),
      { type: 'RUN_SUCCEEDED', runId: 'r1', verdict: 'fail' },
      flow,
    )
    expect(next.currentStageId).toBe('s0')
    expect(next.gateFails).toBe(1)
    expect(effects).toEqual([])
  })
})

describe('stage-machine 内置阶段（M18）', () => {
  const builtin = (
    key: 'todo' | 'blocked' | 'done' | 'cancelled',
    position: number,
  ): WorkflowStage =>
    stage(`bs-${key}`, {
      name: {
        todo: '待办',
        blocked: '已阻塞',
        done: '已完成',
        cancelled: '已取消',
      }[key],
      builtin: key,
      position,
    })

  const flow = (): WorkflowWithStages => ({
    id: 'wf',
    name: 'wf',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    stages: [
      builtin('todo', 0),
      stage('u1', { position: 1 }),
      stage('u2', { position: 2 }),
      builtin('blocked', 3),
      builtin('done', 4),
      builtin('cancelled', 5),
    ],
  })

  it('默认流转跳过「已阻塞」，用户阶段之间照常前进', () => {
    expect(resolveNextStage(stage('u1', { position: 1 }), flow())?.id).toBe('u2')
  })

  it('最后一个用户阶段成功后落入「已完成」', () => {
    expect(resolveNextStage(stage('u2', { position: 2 }), flow())?.id).toBe('bs-done')
  })

  it('「已完成」再成功 → 无下一阶段（任务走完）', () => {
    expect(resolveNextStage(builtin('done', 4), flow())).toBeNull()
  })

  it('显式配到「已阻塞」时按显式目标走（跳过规则只作用于缺省）', () => {
    const explicit = stage('u1', {
      position: 1,
      exits: { done: { do: 'goto', stageId: 'bs-blocked' } },
    })
    expect(resolveNextStage(explicit, flow())?.id).toBe('bs-blocked')
  })

  it('进入「已完成」仍是 active（归档走 task.complete），离开「已阻塞」成功后也回「已完成」', () => {
    const { task: next } = moveTask(task('u2'), { type: 'RUN_SUCCEEDED', runId: 'run-1' }, flow())
    expect(next.currentStageId).toBe('bs-done')
    expect(next.status).toBe('active')
    const fromBlocked = moveTask(
      task('bs-blocked'),
      { type: 'RUN_SUCCEEDED', runId: 'run-1' },
      flow(),
    )
    expect(fromBlocked.task.currentStageId).toBe('bs-done')
  })
})

describe('stage-machine 去向与位置无关（M29 删掉 exitsForward）', () => {
  /** s2 显式把「完成后进入」指回 s0：回路是合法边，不再被判成「不向前」 */
  const backFlow = (): WorkflowWithStages => ({
    ...workflow(),
    stages: [
      stage('s0'),
      stage('s1'),
      stage('s2', { entryMode: 'user', exits: { done: { do: 'goto', stageId: 's0' } } }),
    ],
  })

  it('成功后显式去更前的阶段：照样落过去', () => {
    const moved = moveTask(task('s2'), { type: 'RUN_SUCCEEDED', runId: 'r1' }, backFlow())

    expect(moved.task.currentStageId).toBe('s0')
    expect(moved.effects).toEqual([{ type: 'none' }])
  })

  it('未配去向 → 仍是下一个阶段（默认值只看顺序，不看位置语义）', () => {
    const moved = moveTask(task('s0'), { type: 'RUN_SUCCEEDED', runId: 'r1' }, backFlow())

    expect(moved.task.currentStageId).toBe('s1')
  })

  it('打回显式配到更前的阶段：照样落过去', () => {
    const flow: WorkflowWithStages = {
      ...workflow(),
      stages: [
        stage('s0'),
        stage('s1', { exits: { errored: { do: 'goto', stageId: 's0' } } }),
        stage('s2'),
      ],
    }
    const moved = moveTask(task('s1'), { type: 'RUN_FAILED', runId: 'r1' }, flow)

    expect(moved.task.currentStageId).toBe('s0')
  })

  it('人工拖到更前 / 更后的阶段都以落点为准', () => {
    expect(moveTaskToStage(task('s2'), 's1', workflow()).task.currentStageId).toBe('s1')
    expect(moveTaskToStage(task('s1'), 's2', workflow()).effects).toEqual([{ type: 'waitUser' }])
  })

  it('完成任务只改状态，不动阶段', () => {
    const done = completeTask(task('s1'))

    expect(done.status).toBe('completed')
    expect(done.currentStageId).toBe('s1')
  })
})

// M34 移除 `retry` 出口动作（原「原地重跑预算」三例删除）：出口只剩 goto / await / close，
// 原地再来一轮只能由人触发（拖回阶段 / 重新执行）。
describe('stage-machine applyExit 出口只有三种动作（M34 移除 retry）', () => {
  const flow = (): WorkflowWithStages =>
    sWf([s0, s1, sStage({ id: 'ag', position: 2, entryMode: 'agent', agentId: 'ag1' })])

  it('动作表就是 goto / await / close，没有 retry', () => {
    expect(STAGE_EXIT_ACTIONS).toEqual(['goto', 'await', 'close'])
  })

  it('goto：换阶段并重建入口 run', () => {
    const r = applyExit(sTask('s0'), { do: 'goto', stageId: 'ag' }, flow())

    expect(r.task.currentStageId).toBe('ag')
    expect(r.effects).toEqual([{ type: 'createRun', stageId: 'ag', agentId: 'ag1' }])
  })

  it('await：原地不动、零效果（不再有重跑计数与「预算用尽」收口）', () => {
    const r = applyExit(sTask('ag'), { do: 'await' }, flow())

    expect(r.task.currentStageId).toBe('ag')
    expect(r.task.status).toBe('active')
    expect(r.effects).toEqual([])
    expect(Object.hasOwn(r, 'retryExhausted')).toBe(false)
  })
})

// 老事实的判定者（M11 的 `gate` 列 → M32 的 `judge`）：只搬护栏，去向搬进出口表。
describe('stage-machine legacyJudge（老 gate 列只搬护栏）', () => {
  it('judge 已给就原样用；只有老 gate 时只取 maxFails；都没有时 null', () => {
    expect(legacyJudge({ judge: { maxFails: 2 }, gate: { maxFails: 5 } })).toEqual({ maxFails: 2 })
    expect(legacyJudge({ judge: null, gate: { maxFails: 5 } })).toBeNull()
    expect(legacyJudge({ gate: { maxFails: 3 } })).toEqual({ maxFails: 3 })
    expect(legacyJudge({})).toBeNull()
    expect(legacyJudge({ judge: undefined, gate: null })).toBeNull()
  })
})

// M34：`retry` 从动作表里删了，但旧库 / 老事实的 JSON 里还留着——归一成 `await`
// （不替用户猜目标阶段），其余出口原样保留。
describe('stage-machine legacyExits（M34：老 retry 归一成 await）', () => {
  it('老 exits 里的 retry → await，goto / await / close 原样', () => {
    const legacy = {
      errored: { do: 'retry', max: 2 },
      done: { do: 'goto', stageId: 's2' },
      passed: { do: 'await' },
      failed: { do: 'close' },
    } as unknown as WorkflowStage['exits']

    expect(legacyExits({ exits: legacy })).toEqual({
      errored: { do: 'await' },
      done: { do: 'goto', stageId: 's2' },
      passed: { do: 'await' },
      failed: { do: 'close' },
    })
    expect(legacyExits({ exits: {} })).toEqual({})
    // null 项丢掉（老事实里可能是显式 null）
    expect(legacyExits({ exits: { done: null } as unknown as WorkflowStage['exits'] })).toEqual({})
  })

  it('没有 exits 时按老的 onComplete / onReject / 闸门两列还原', () => {
    expect(legacyExits({ onCompleteStageId: 's1', onRejectStageId: 's0' })).toEqual({
      done: { do: 'goto', stageId: 's1' },
      errored: { do: 'goto', stageId: 's0' },
    })
    expect(legacyExits({ gate: { onPassStageId: 's2', onFailStageId: null } })).toEqual({
      passed: { do: 'goto', stageId: 's2' },
    })
    expect(legacyExits({ gate: null, onCompleteStageId: null })).toEqual({})
  })
})

// —— 性质测试（fast-check）：阶段流转的不变量 ————————————————————————————————————
//
// 阶段图是随机的：阶段数、顺序、内置终态、缺省出口、判定护栏都随机生成，任务是「任意
// 阶段 + 任意状态」。断言：
// ① `completeExits` 幂等且形状封闭（非终态必有 done/errored，判定阶段才有 passed/failed）；
// ② `applyExit` 只在目标真实存在且不是当前阶段时才动任务，预算按传入值落下；
// ③ 脏投影（当前阶段不存在）、已完成的任任务、自指 goto 一律零流转；
// ④ 判定预算只在 `verdict='fail'` 时累计，达到 maxFails 才放行；`RUN_FAILED` 不消耗预算。
// 固定种子，反例可复现（`FC_SEED` 换一批）。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261113)
const PROPERTY_RUNS = 100
const AT = '2026-01-01T00:00:00.000Z'

const judgeArb: Arbitrary<JudgeConfig | null> = fc.oneof(
  fc.constant<JudgeConfig | null>(null),
  fc.record({
    maxFails: fc.oneof(fc.constant<number | null>(null), fc.integer({ min: 1, max: 3 })),
  }),
)

const actionArb: Arbitrary<StagePrimary> = fc.oneof(
  fc
    .constantFrom('s0', 's1', 's2', 's3', 'ghost')
    .map((stageId): StagePrimary => ({ do: 'goto', stageId })),
  fc.constant<StagePrimary>({ do: 'await' }),
  fc.constant<StagePrimary>({ do: 'close' }),
)

const exitsArb: Arbitrary<StageExits> = fc
  .array(
    fc.tuple(fc.constantFrom<StageExitGuard>('done', 'errored', 'passed', 'failed'), actionArb),
    { maxLength: 4 },
  )
  .map((rows) => Object.fromEntries(rows) as StageExits)

const stageArbFor = (id: string): Arbitrary<WorkflowStage> =>
  fc
    .tuple(
      fc.constantFrom<WorkflowStage['entryMode']>('none', 'agent', 'user'),
      fc.constantFrom('ag-1', null),
      judgeArb,
      exitsArb,
      fc.constantFrom<'done' | 'cancelled' | null>('done', 'cancelled', null),
    )
    .map(([entryMode, agentId, judge, exits, builtin]) =>
      stage(id, { entryMode, agentId, judge, exits, ...(builtin === null ? {} : { builtin }) }),
    )

const stagesArb: Arbitrary<WorkflowStage[]> = fc
  .tuple(stageArbFor('s0'), stageArbFor('s1'), stageArbFor('s2'), stageArbFor('s3'))
  .chain((list) =>
    fc.tuple(fc.integer({ min: 1, max: 4 }), fc.boolean()).map(([count, reversed]) => {
      const picked = list.slice(0, count)
      return reversed ? [...picked].reverse() : picked
    }),
  )

const flowArb: Arbitrary<WorkflowWithStages> = stagesArb.map((stages) => ({
  id: 'wf',
  name: 'wf',
  description: '',
  createdAt: AT,
  stages,
}))

const judgedFlow = (maxFails: number): WorkflowWithStages => ({
  id: 'wf',
  name: 'wf',
  description: '',
  createdAt: AT,
  stages: [stage('s0', { judge: { maxFails } }), stage('s1')],
})

describe('kernel 阶段状态机的性质（fast-check 随机生成）', () => {
  it('completeExits 幂等且形状封闭：非终态必有 done/errored，判定阶段才有 passed/failed', () => {
    fc.assert(
      fc.property(flowArb, (flow) => {
        const once = completeExits(flow.stages)
        expect(completeExits(once)).toEqual(once)
        once.forEach((row) => {
          if (row.builtin === 'done' || row.builtin === 'cancelled') {
            expect(row.exits).toEqual({})
            return
          }
          expect(row.exits.done).toBeDefined()
          expect(row.exits.errored).toBeDefined()
          if (row.judge === null) {
            expect(row.exits.passed).toBeUndefined()
            expect(row.exits.failed).toBeUndefined()
          } else {
            expect(row.exits.passed).toBeDefined()
            expect(row.exits.failed).toBeDefined()
          }
        })
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('applyExit(goto)：目标存在且不是当前阶段才换阶段，悬空目标与自指原地不动', () => {
    fc.assert(
      fc.property(
        flowArb,
        fc.constantFrom('s0', 's1', 's2', 's3', 'ghost'),
        fc.integer({ min: 0, max: 3 }),
        (flow, targetId, gateFails) => {
          const before = { ...task('s2'), gateFails: 9 }
          const target = flow.stages.find((row) => row.id === targetId)
          const result = applyExit(before, { do: 'goto', stageId: targetId }, flow, { gateFails })
          if (target === undefined || target.id === before.currentStageId) {
            expect(result.effects).toEqual([])
            expect(result.task.currentStageId).toBe('s2')
            expect(result.task.status).toBe('active')
          } else {
            expect(result.task.currentStageId).toBe(target.id)
            expect(result.task.status).toBe('active')
            expect(result.effects).toEqual(entryEffects(target))
          }
          // 预算按传入值落下（清不清零由调用方决定，不是这里猜）
          expect(result.task.gateFails).toBe(gateFails)
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('applyExit(close) 归档并清零预算；(await) 原地保留传入预算', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), (gateFails) => {
        const flow = judgedFlow(1)
        const before = { ...task('s0'), gateFails: 5 }
        const closed = applyExit(before, { do: 'close' }, flow)
        expect(closed.task.status).toBe('completed')
        expect(closed.task.gateFails).toBe(0)
        expect(closed.effects).toEqual([])
        const awaited = applyExit(before, { do: 'await' }, flow, { gateFails })
        expect(awaited.task.status).toBe('active')
        expect(awaited.task.currentStageId).toBe('s0')
        expect(awaited.task.gateFails).toBe(gateFails)
        expect(awaited.effects).toEqual([])
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('脏投影与已完成任务：moveTask 零流转并返回同一对象', () => {
    fc.assert(
      fc.property(
        flowArb,
        fc.constantFrom<Task['status']>('active', 'completed'),
        (flow, status) => {
          const row: Task =
            status === 'completed'
              ? { ...task(flow.stages[0]?.id ?? 'ghost'), status, gateFails: 2 }
              : { ...task('ghost'), status }
          const result = moveTask(row, { type: 'RUN_SUCCEEDED', runId: 'r1' }, flow)
          expect(result.task).toBe(row)
          expect(result.effects).toEqual([])
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('moveTaskToStage：目标缺失 / 已在目标 / 已完成时原样返回，否则落位并清零预算', () => {
    fc.assert(
      fc.property(flowArb, fc.constantFrom('s0', 's1', 's2', 's3', 'ghost'), (flow, targetId) => {
        const before = { ...task('s0'), gateFails: 3 }
        const target = flow.stages.find((row) => row.id === targetId)
        const result = moveTaskToStage(before, targetId, flow)
        if (target === undefined || target.id === before.currentStageId) {
          expect(result).toEqual({ task: before, effects: [] })
          return
        }
        expect(result.task.currentStageId).toBe(target.id)
        expect(result.task.gateFails).toBe(0)
        expect(result.effects).toEqual(entryEffects(target))
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('判定失败累计到 maxFails 才放行：放行时清零并标 gateExhausted', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (maxFails) => {
        const flow = judgedFlow(maxFails)
        let current: Task = task('s0')
        for (let round = 1; round <= maxFails; round += 1) {
          const result = moveTask(
            current,
            { type: 'RUN_SUCCEEDED', runId: 'r1', verdict: 'fail' },
            flow,
          )
          current = result.task
          const exhausted = round === maxFails
          expect(result.gateExhausted).toBe(exhausted ? true : undefined)
          expect(current.gateFails).toBe(exhausted ? 0 : round)
          // 预算没用完时 failed 出口缺省 await：停在原阶段等人
          expect(current.currentStageId).toBe(exhausted ? 's1' : 's0')
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('执行出错不消耗判定预算：RUN_FAILED 保 gateFails 并停在原阶段', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), (fails) => {
        const flow = judgedFlow(3)
        const result = moveTask(
          { ...task('s0'), gateFails: fails },
          { type: 'RUN_FAILED', runId: 'r1' },
          flow,
        )
        expect(result.task.currentStageId).toBe('s0')
        expect(result.task.gateFails).toBe(fails)
        expect(result.gateExhausted).toBeUndefined()
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})
