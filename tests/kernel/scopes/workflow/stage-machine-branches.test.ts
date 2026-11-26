// @vitest-environment node
/**
 * 阶段流转（`scopes/workflow/stage-machine.ts`）的两条边缘臂。
 *
 * 1. 任务停在终态内置阶段（完成 / 取消）再收到「跑完了」：终态阶段没有出口表，
 *    原地不动、零效果（迟到的结算不该把已完成的单子又推走）；
 * 2. M32 老字段归一：只有 `gate` 没有 `judge` 的老行，`onPassStageId` 缺省时不造出口。
 */
import { describe, expect, it } from 'vitest'
import type {
  StageExits,
  Task,
  Workflow,
  WorkflowStage,
  WorkflowWithStages,
} from '@workbench/protocol/entities'
import { legacyExits, moveTask } from '@workbench/kernel/scopes/workflow/stage-machine'

const CREATED = '2026-11-20T09:00:00.000Z'

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-work',
  workflowId: 'wf-1',
  name: '实现',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  script: null,
  exits: {},
  handoffs: [],
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  instructions: '',
  acceptance: [],
  runTimeoutMs: null,
  judge: null,
  builtin: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-done',
  archivedAt: null,
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const flow = (stages: WorkflowStage[]): WorkflowWithStages => ({
  ...({ id: 'wf-1', name: '研发', description: '', createdAt: CREATED } as Workflow),
  stages,
})

describe('moveTask：终态阶段没有出口', () => {
  it('停在「已完成」再收到成功：原地不动、零效果', () => {
    const done = stage({ id: 'st-done', name: '已完成', position: 1, builtin: 'done' })
    const result = moveTask(task(), { type: 'RUN_SUCCEEDED', runId: 'run-1' }, flow([done]))
    expect(result.task).toEqual(task())
    expect(result.effects).toEqual([])
  })
})

/**
 * 工作流视图的 `stages` 在两次读取之间被替换：第一次给完整表，之后给空表。
 *
 * `moveTask` 先按 id 找到当前阶段（第一次读），再读一次表补齐缺省出口（第二次读）——
 * 产品上是「阶段表被并发重建」的那一瞬。纯函数内核不该出现这种视图，但兜底不能炸：
 * 补齐时找不到当前阶段就按空表处理（零流转），不抛也不猜。
 */
function driftingFlow(stages: WorkflowStage[]): WorkflowWithStages {
  let reads = 0
  return {
    ...({ id: 'wf-1', name: '研发', description: '', createdAt: CREATED } as Workflow),
    get stages() {
      reads += 1
      return reads === 1 ? stages : []
    },
  }
}

describe('moveTask：阶段表在两次读取之间被替换', () => {
  it('补齐出口表时当前阶段已不在表里：按空表处理，原地不动、零效果', () => {
    const work = task({ currentStageId: 'st-work' })
    const result = moveTask(
      work,
      { type: 'RUN_SUCCEEDED', runId: 'run-1' },
      driftingFlow([stage()]),
    )
    expect(result.task).toEqual(work)
    expect(result.effects).toEqual([])
  })

  it('同一份表没被替换时：缺省出口照常往前走（对照）', () => {
    const work = task({ currentStageId: 'st-work' })
    const next = stage({ id: 'st-next', name: '验收', position: 1 })
    const result = moveTask(work, { type: 'RUN_SUCCEEDED', runId: 'run-1' }, flow([stage(), next]))
    expect(result.task.currentStageId).toBe('st-next')
  })
})

describe('legacyExits：老字段只有 gate', () => {
  it('gate 缺 onPassStageId：不造 passed 出口；onFailStageId 有值就造 failed', () => {
    const exits = legacyExits({
      onCompleteStageId: 'st-next',
      onRejectStageId: 'st-back',
      gate: { onPassStageId: null, onFailStageId: 'st-fix' },
    })
    expect(exits).toEqual({
      done: { do: 'goto', stageId: 'st-next' },
      errored: { do: 'goto', stageId: 'st-back' },
      failed: { do: 'goto', stageId: 'st-fix' },
    })
  })

  it('exits 列存在但为 null（旧库里可能是空值）：按空表归一', () => {
    expect(legacyExits({ exits: null as unknown as StageExits })).toEqual({})
  })

  it('老行的 retry 去向归一成「停在这里等人」', () => {
    const exits = legacyExits({
      exits: { done: { do: 'retry' } } as unknown as StageExits,
    })
    expect(exits).toEqual({ done: { do: 'await' } })
  })

  it('没有 gate 的老行：只搬显式配过的完成 / 打回去向', () => {
    expect(legacyExits({ onCompleteStageId: null, onRejectStageId: null })).toEqual({})
  })
})
