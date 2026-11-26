// @vitest-environment node
/**
 * 子任务汇总（`scopes/spawn.ts`）：本批删掉的子任务按「已放弃」算完成，不阻塞 rollup。
 *
 * 覆盖表里记着 `removed` 的子任务不进终结判定；父任务停在等人阶段时汇总动作是 notify。
 */
import { describe, expect, it } from 'vitest'
import type { Task, WorkflowStage } from '@workbench/protocol/entities'
import { childrenSettledFacts } from '@workbench/kernel/scopes/spawn'
import { TEST_AT, emptyView, testEnv } from '../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-park',
  workflowId: 'wf-1',
  name: '人工验收',
  position: 0,
  entryMode: 'user',
  agentId: null,
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
  id: 't-p',
  title: '父任务',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-park',
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

const parent = task()
/** 子任务：还在做（视图里的阶段语义是「进行中」），但本批已经被删掉了。 */
const child = task({ id: 't-c', title: '子任务', currentStageId: 'st-work', parentTaskId: 't-p' })

describe('childrenSettledFacts：本批删掉的子任务按完成算', () => {
  it('唯一子任务被删：照样汇总（childIds 记得它）', () => {
    const facts = childrenSettledFacts(
      emptyView({
        stages: new Map([
          [stage().id, stage()],
          ['st-work', stage({ id: 'st-work', name: '实现', entryMode: 'agent', agentId: 'ag-1' })],
        ]),
        tasks: new Map([
          [parent.id, parent],
          [child.id, child],
        ]),
      }),
      't-p',
      TEST_AT,
      testEnv(),
      { kind: 'host', via: 'scheduler' },
      new Map([['t-c', 'removed']]),
    )
    const settled = facts.find((fact) => fact.type === 'task.children_settled')
    expect(settled?.payload).toMatchObject({
      parentTaskId: 't-p',
      childIds: ['t-c'],
      action: 'notify',
    })
  })

  it('子任务还在做（没有覆盖）：不汇总', () => {
    expect(
      childrenSettledFacts(
        emptyView({
          stages: new Map([
            [stage().id, stage()],
            [
              'st-work',
              stage({ id: 'st-work', name: '实现', entryMode: 'agent', agentId: 'ag-1' }),
            ],
          ]),
          tasks: new Map([
            [parent.id, parent],
            [child.id, child],
          ]),
        }),
        't-p',
        TEST_AT,
        testEnv(),
        { kind: 'host', via: 'scheduler' },
      ),
    ).toEqual([])
  })
})
