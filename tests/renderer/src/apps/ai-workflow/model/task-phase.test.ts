import { describe, expect, it } from 'vitest'
import type { Task, WorkflowWithStages } from '@workbench/protocol/entities'
import { phaseOfTask, stageOfTask } from '@workbench/client-app-ai-workflow/model/task-phase'

function stage(
  id: string,
  workflowId: string,
  builtin: 'todo' | 'blocked' | 'done' | 'cancelled' | null,
): WorkflowWithStages['stages'][number] {
  return {
    id,
    workflowId,
    name: id,
    position: 0,
    entryMode: 'none',
    agentId: null,
    exits: {},
    judge: null,
    handoffs: [],
    builtin,
  }
}

const task: Task = {
  id: 't1',
  title: '任务',
  description: '',
  workflowId: 'w1',
  projectId: null,
  currentStageId: 's1',
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
  createdAt: 't',
  updatedAt: 't',
}

const workflows: WorkflowWithStages[] = [
  {
    id: 'w1',
    name: '研发',
    description: '',
    createdAt: 't',
    stages: [stage('s1', 'w1', null), stage('s-done', 'w1', 'done')],
  },
  {
    id: 'w2',
    name: '验收',
    description: '',
    createdAt: 't',
    stages: [stage('s2-done', 'w2', 'cancelled')],
  },
]

describe('model/task-phase', () => {
  it('stageOfTask：按任务自己的工作流查阶段（跨工作流）', () => {
    expect(stageOfTask(task, workflows)?.id).toBe('s1')
    expect(stageOfTask({ ...task, workflowId: 'w2', currentStageId: 's2-done' }, workflows)?.id).toBe(
      's2-done',
    )
    expect(stageOfTask(task, [])).toBeUndefined()
  })

  it('phaseOfTask：内置阶段取类别，自己添加的进行中，阶段缺失按未开始', () => {
    expect(phaseOfTask(task, workflows)).toBe('active')
    expect(phaseOfTask({ ...task, currentStageId: 's-done' }, workflows)).toBe('finished')
    expect(
      phaseOfTask({ ...task, workflowId: 'w2', currentStageId: 's2-done' }, workflows),
    ).toBe('cancelled')
    expect(phaseOfTask({ ...task, currentStageId: 'gone' }, workflows)).toBe('todo')
  })

  it('phaseOfTask 与任务状态无关：归档与否不影响阶段语义（M53）', () => {
    const archived: Task = { ...task, currentStageId: 's-done', archivedAt: 'archived-at' }
    expect(phaseOfTask(archived, workflows)).toBe('finished')
  })
})
