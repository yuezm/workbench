// @vitest-environment node
/**
 * 命令层的公共读取（`scopes/commands/common.ts`）的两条边缘臂。
 *
 * 两条都只在「视图里同时有别的工作流 / 别的对话」时才走到：
 *
 * 1. `tasksOf` 按 `workflowId` 过滤——别的工作流的任务不能被当成自己的（否则删一条工作流会连带
 *    别人的任务与 run）；
 * 2. `chatMessageFacts` 查不到对话（对话已删、run 还在跑）时不补消息，也不写 `conversation.updated`
 *    ——脏投影下宁可少一条消息，也不能把事实挂到不存在的对话上。
 */
import { describe, expect, it } from 'vitest'
import type { RunRow, Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import type { Input } from '@workbench/protocol/inputs'
import { settleRunByHost } from '@workbench/kernel/scopes/commands/run'
import { removeWorkflow } from '@workbench/kernel/scopes/commands/workflow'
import { TEST_AT, emptyView, testEnv } from '../../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const workflow = (id: string, name: string): Workflow => ({
  id,
  name,
  description: '',
  createdAt: CREATED,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
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
  currentStageId: 'st-1',
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

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'running',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: CREATED,
  endedAt: null,
  createdAt: CREATED,
  conversationId: null,
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'command',
  threadId: null,
  cwd: 'C:/work',
  access: 'full',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  attempt: 1,
  attempts: 0,
  leaseId: 'lease-1',
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  script: null,
  ...over,
})

const removeCommand = (id: string) =>
  ({ type: 'workflow.remove', commandId: 'c-1', id }) as unknown as Extract<
    Input,
    { type: 'workflow.remove' }
  >

const hostSettled = (over: Record<string, unknown> = {}) =>
  ({
    type: 'run.host_settled',
    runId: 'run-1',
    status: 'succeeded',
    leaseId: 'lease-1',
    turn: 1,
    ...over,
  }) as unknown as Extract<Input, { type: 'run.host_settled' }>

describe('removeWorkflow：只清本工作流的任务与 run', () => {
  it('视图里还有别的工作流的任务：一并删掉就会误伤别人', () => {
    const decision = removeWorkflow(
      emptyView({
        workflows: new Map([
          ['wf-1', workflow('wf-1', '研发')],
          ['wf-2', workflow('wf-2', '发布')],
        ]),
        stages: new Map([
          ['st-1', stage()],
          ['st-2', stage({ id: 'st-2', workflowId: 'wf-2' })],
        ]),
        tasks: new Map([
          ['t-1', task()],
          ['t-2', task({ id: 't-2', workflowId: 'wf-2', currentStageId: 'st-2' })],
        ]),
        runs: new Map([
          ['run-1', run()],
          ['run-2', run({ id: 'run-2', taskId: 't-2', stageId: 'st-2' })],
        ]),
      }),
      removeCommand('wf-1'),
      TEST_AT,
    )
    const removedTasks = decision.facts
      .filter((fact) => fact.type === 'task.removed')
      .map((fact) => (fact.payload as { task: Task }).task.id)
    const removedRuns = decision.facts
      .filter((fact) => fact.type === 'run.removed')
      .map((fact) => (fact.payload as { runId: string }).runId)
    expect(removedTasks).toEqual(['t-1'])
    expect(removedRuns).toEqual(['run-1'])
  })
})

describe('chatMessageFacts：对话已不在视图里', () => {
  it('run 指向已删的对话：落 run 终态，不补 assistant 消息、不写对话行', () => {
    const decision = settleRunByHost(
      emptyView({
        runs: new Map([
          [
            'run-1',
            run({
              purpose: 'chat',
              taskId: null,
              stageId: null,
              conversationId: 'conv-gone',
            }) as RunRow,
          ],
        ]),
      }),
      hostSettled({ status: 'cancelled' }),
      TEST_AT,
      testEnv(),
    )
    expect(decision.facts.some((fact) => fact.type === 'run.cancelled')).toBe(true)
    expect(decision.facts.some((fact) => fact.type === 'message.appended')).toBe(false)
    expect(decision.facts.some((fact) => fact.type === 'conversation.updated')).toBe(false)
  })
})
