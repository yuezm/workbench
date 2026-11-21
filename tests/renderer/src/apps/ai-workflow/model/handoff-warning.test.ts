import { describe, expect, it } from 'vitest'
import type { WorkflowStage } from '@workbench/protocol/entities'
import { handoffLandingWarning } from '@workbench/client-app-ai-workflow/model/handoff-warning'

function stage(
  id: string,
  name: string,
  over: Partial<WorkflowStage> = {},
): WorkflowStage {
  return {
    id,
    workflowId: 'w2',
    name,
    position: 0,
    entryMode: 'none',
    agentId: null,
    exits: {},
    judge: null,
    handoffs: [],
    ...over,
  }
}

const stages: WorkflowStage[] = [
  stage('b0', '待办'),
  stage('b1', '实现', { entryMode: 'agent', agentId: 'ag-1' }),
  stage('b2', '已完成', { builtin: 'done' }),
]

describe('model/handoff-warning', () => {
  it('目标阶段会派活：不提示', () => {
    expect(handoffLandingWarning(stages, 'b1')).toBeNull()
  })

  it('目标阶段不派活：提示链条会停在这里等人', () => {
    expect(handoffLandingWarning(stages, 'b0')).toBe('目标阶段「待办」不派活，链条会停在这里等人来拖。')
  })

  it('目标是终态：提示建出来就不会再派活', () => {
    expect(handoffLandingWarning(stages, 'b2')).toContain('是终态')
  })

  it('没选阶段（null）或阶段已不在清单：不提示（由别的校验管）', () => {
    expect(handoffLandingWarning(stages, null)).toBeNull()
    expect(handoffLandingWarning(stages, 'gone')).toBeNull()
  })
})
