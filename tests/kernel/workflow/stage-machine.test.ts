import { describe, expect, it } from 'vitest'
import type { Task, WorkflowStage, WorkflowWithStages } from '../../../src/protocol/entities'
import { moveTask, moveTaskToStage } from '../../../src/kernel/workflow/stage-machine'

const stage = (id: string, over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id,
  workflowId: 'wf',
  name: id,
  position: 0,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
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
  currentStageId,
  status: 'active',
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
