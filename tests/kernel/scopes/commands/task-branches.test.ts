// @vitest-environment node
/**
 * 任务命令（`scopes/commands/task.ts`）的两处边界：父任务没有当前阶段时挂子任务、
 * 以及「补回执」在阶段 / 智能体 / 运行时缺失时的拒绝口径。
 *
 * 补回执的拒绝必须说清楚是哪一环缺了（阶段无效 vs 没配智能体），否则看板上只能看到
 * 一句「命令失败」，人不知道该去改配置还是改数据。
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import type { Input } from '@workbench/protocol/inputs'
import type { ReviewFinding, ReviewReport } from '@workbench/protocol/review'
import { createTask, reaskGate } from '@workbench/kernel/scopes/commands/task'
import { TEST_AT, emptyView, testEnv } from '../../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const workflow = (): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-fix',
  workflowId: 'wf-1',
  name: '修复',
  position: 1,
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

/** 评审阶段：失败 / 出错都打回「修复」。 */
const reviewStage = (): WorkflowStage =>
  stage({
    id: 'st-review',
    name: '评审',
    position: 2,
    judge: { maxFails: 2 },
    exits: {
      failed: { do: 'goto', stageId: 'st-fix' },
      errored: { do: 'goto', stageId: 'st-fix' },
    },
  })

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-fix',
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

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
  ...over,
})

const finding = (): ReviewFinding => ({
  id: 'rev-1#R1',
  key: 'R1',
  severity: 'blocker',
  location: null,
  claim: '断言',
  evidence: null,
  requiredAction: '验收',
  status: 'open',
  note: null,
  addressedByRunId: null,
  updatedAt: CREATED,
})

const report = (): ReviewReport => ({
  id: 'rev-1',
  taskId: 't-1',
  stageId: 'st-review',
  runId: 'run-1',
  threadId: null,
  rev: 1,
  verdict: 'fail',
  checks: [],
  findings: [finding()],
  artifact: null,
  createdAt: CREATED,
  updatedAt: CREATED,
})

const baseView = () =>
  emptyView({
    workflows: new Map([['wf-1', workflow()]]),
    stages: new Map([
      ['st-fix', stage()],
      ['st-review', reviewStage()],
    ]),
  })

const reask = (view: ReturnType<typeof baseView>, id = 't-1') =>
  reaskGate(
    view,
    { type: 'task.reask', commandId: 'c-1', id } as unknown as Extract<
      Input,
      { type: 'task.reask' }
    >,
    TEST_AT,
    testEnv(),
  )

describe('createTask：父任务没有当前阶段', () => {
  it('落点退回工作流首个阶段（父任务挂在流程外，子任务仍要能开出去）', () => {
    const decision = createTask(
      {
        ...baseView(),
        tasks: new Map([['t-p', task({ id: 't-p', currentStageId: null })]]),
      },
      {
        type: 'task.create',
        commandId: 'c-1',
        input: { title: '子任务', workflowId: 'wf-1', parentTaskId: 't-p' },
      } as unknown as Extract<Input, { type: 'task.create' }>,
      TEST_AT,
      testEnv(),
    )
    const created = decision.facts.find((fact) => fact.type === 'task.created')
    expect((created?.payload as { task: Task }).task).toMatchObject({
      parentTaskId: 't-p',
      currentStageId: 'st-fix',
    })
  })
})

describe('reaskGate：拒绝口径', () => {
  it('任务不存在：not_found', () => {
    expect(reask(baseView(), 't-9').reject?.code).toBe('not_found')
  })

  it('任务没有当前阶段：阶段无效（不猜该补哪一段）', () => {
    const decision = reask({
      ...baseView(),
      tasks: new Map([['t-1', task({ currentStageId: null })]]),
    })
    expect(decision.reject?.message).toBe('任务当前阶段无效')
  })

  it('执行阶段有待补的评审处置，但没有可用的智能体：说清楚缺的是智能体 / 运行时', () => {
    const decision = reask({
      ...baseView(),
      stages: new Map([
        ['st-fix', stage({ agentId: null })],
        ['st-review', reviewStage()],
      ]),
      tasks: new Map([['t-1', task()]]),
      reviewReports: new Map([['rev-1', report()]]),
    })
    expect(decision.reject?.message).toContain('没有可用的智能体 / 运行时')
  })

  it('闸门阶段补回执，但运行时不在：同样拒绝', () => {
    const decision = reask({
      ...baseView(),
      stages: new Map([
        ['st-fix', stage({ judge: { maxFails: 2 } })],
        ['st-review', reviewStage()],
      ]),
      agents: new Map([['ag-1', agent()]]),
      tasks: new Map([['t-1', task()]]),
    })
    expect(decision.reject?.message).toContain('没有可用的智能体 / 运行时')
  })
})
