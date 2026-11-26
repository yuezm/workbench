// @vitest-environment node
/**
 * 派单来源资料（M31，`scopes/handoff-source.ts`）：取哪一轮、缺什么就退回什么。
 *
 * 这里钉的是「退而求其次」的四步：显式 run → 来源任务在来源阶段最后一条终态 run →
 * 都没有就只给任务 / 阶段信息。工作流行缺失时用 workflowId 顶上。
 */
import { describe, expect, it } from 'vitest'
import type { RunRow, Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import { sourceHandoffOf } from '@workbench/kernel/scopes/handoff-source'
import type { View } from '@workbench/kernel/core/types'

const CREATED = '2026-11-20T09:00:00.000Z'
const LATER = '2026-11-24T09:00:00.000Z'

const workflow = (): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-src',
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
  title: '来源任务',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-src',
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
  id: 'run-src',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-src',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'succeeded',
  prompt: '',
  output: '结论正文',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: CREATED,
  endedAt: LATER,
  createdAt: CREATED,
  conversationId: null,
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: 'C:/work',
  access: 'edit',
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
  leaseId: null,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 4,
  workflows: new Map([[workflow().id, workflow()]]),
  stages: new Map([[stage().id, stage()]]),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
  activeTaskIds: new Set(),
  ...over,
})

/** 派单产物：来源任务 t-1 / 来源阶段 st-src。 */
const handoffTask = (over: Partial<Task> = {}): Task =>
  task({
    id: 't-2',
    title: '派单产物',
    handoffFromTaskId: 't-1',
    handoffFromStageId: 'st-src',
    handoffFromRunId: null,
    ...over,
  })

describe('sourceHandoffOf：定位不到就给 null', () => {
  it('不是派单产物 → null', () => {
    expect(sourceHandoffOf(view(), task())).toBeNull()
  })

  it('没记来源阶段 → null（不知道该取哪一段的结论）', () => {
    expect(sourceHandoffOf(view(), handoffTask({ handoffFromStageId: null }))).toBeNull()
  })

  it('来源任务 / 来源阶段不在视图里 → null', () => {
    expect(sourceHandoffOf(view(), handoffTask())).toBeNull()
    expect(
      sourceHandoffOf(
        view({ tasks: new Map([['t-1', task()]]), stages: new Map() }),
        handoffTask(),
      ),
    ).toBeNull()
  })
})

describe('sourceHandoffOf：退而求其次取结论', () => {
  it('工作流行缺失：工作流名退回 workflowId', () => {
    const source = sourceHandoffOf(
      view({
        workflows: new Map(),
        tasks: new Map([['t-1', task()]]),
        runs: new Map([['run-src', run()]]),
      }),
      handoffTask(),
    )
    expect(source?.workflowName).toBe('wf-1')
    expect(source?.runId).toBe('run-src')
    expect(source?.runStatus).toBe('succeeded')
    expect(source?.summary).toBe('结论正文')
  })

  it('没有显式 run：取来源任务在来源阶段最后一条终态 run（别的任务 / 别的阶段 / 非终态跳过）', () => {
    const source = sourceHandoffOf(
      view({
        tasks: new Map([['t-1', task()]]),
        runs: new Map([
          ['run-other-task', run({ id: 'run-other-task', taskId: 't-9', endedAt: LATER })],
          ['run-other-stage', run({ id: 'run-other-stage', stageId: 'st-9', endedAt: LATER })],
          ['run-running', run({ id: 'run-running', status: 'running', endedAt: null })],
          ['run-old', run({ id: 'run-old', endedAt: null, createdAt: CREATED, output: '旧的' })],
          ['run-new', run({ id: 'run-new', endedAt: LATER, createdAt: CREATED, output: '新的' })],
        ]),
      }),
      handoffTask(),
    )
    expect(source?.runId).toBe('run-new')
    expect(source?.summary).toBe('新的')
  })

  it('来源阶段上一轮都没有：只给任务 / 阶段信息，runId 与摘要留空', () => {
    const source = sourceHandoffOf(
      view({ tasks: new Map([['t-1', task()]]), runs: new Map() }),
      handoffTask(),
    )
    expect(source).toMatchObject({ taskId: 't-1', stageName: '实现', workflowName: '研发' })
    expect(source?.runId).toBeNull()
    expect(source?.runStatus).toBeNull()
    expect(source?.summary).toBe('')
  })

  it('显式 run 优先于「最后一轮终态」', () => {
    const source = sourceHandoffOf(
      view({
        tasks: new Map([['t-1', task()]]),
        runs: new Map([
          ['run-new', run({ id: 'run-new', endedAt: LATER, output: '新的' })],
          ['run-pick', run({ id: 'run-pick', endedAt: CREATED, output: '指定的' })],
        ]),
      }),
      handoffTask({ handoffFromRunId: 'run-pick' }),
    )
    expect(source?.runId).toBe('run-pick')
    expect(source?.summary).toBe('指定的')
  })
})
