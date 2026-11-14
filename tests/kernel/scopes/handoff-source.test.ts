// @vitest-environment node
/**
 * 来源工单解析（M31）：派单产物的提示词要能看到「从哪来、上一轮结论是什么」。
 *
 * 只构造 `View` 假数据，不起 DB；排版在 `tests/kernel/prompt.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import type { RunRow, Task, Workflow, WorkflowStage } from '../../../src/protocol/entities'
import type { View } from '../../../src/kernel/core/types'
import { sourceHandoffOf } from '../../../src/kernel/scopes/handoff-source'

const AT = '2026-11-01T00:00:00.000Z'

const workflow = (id: string, name: string): Workflow => ({
  id,
  name,
  description: '',
  createdAt: AT,
})

const stage = (id: string, workflowId: string, name: string): WorkflowStage => ({
  id,
  workflowId,
  name,
  position: 0,
  entryMode: 'none',
  agentId: null,
  exits: {},
  judge: null,
  handoffs: [],
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-src',
  title: '实现登录',
  description: '',
  workflowId: 'wf-dev',
  projectId: null,
  currentStageId: 'st-review',
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
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-src',
  conversationId: null,
  stageId: 'st-review',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: '',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  status: 'succeeded',
  prompt: '',
  output: '评审结论：改动范围过大，退回重做。',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: null,
  leaseId: null,
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  startedAt: AT,
  endedAt: '2026-11-01T01:00:00.000Z',
  createdAt: AT,
  ...over,
})

const view = (seed: { tasks?: Task[]; runs?: RunRow[] } = {}): View =>
  ({
    seq: 1,
    workflows: new Map([
      ['wf-dev', workflow('wf-dev', '研发')],
      ['wf-qa', workflow('wf-qa', '测试')],
    ]),
    stages: new Map([
      ['st-review', stage('st-review', 'wf-dev', '评审')],
      ['st-fix', stage('st-fix', 'wf-dev', '修复')],
      ['st-qa', stage('st-qa', 'wf-qa', '待办')],
    ]),
    agents: new Map(),
    runtimes: new Map(),
    projects: new Map(),
    tasks: new Map((seed.tasks ?? [task()]).map((item) => [item.id, item])),
    runs: new Map((seed.runs ?? []).map((item) => [item.id, item])),
    cards: new Map(),
    conversations: new Map(),
    messages: new Map(),
    threads: new Map(),
    taskComments: new Map(),
    reviewReports: new Map(),
    events: new Map(),
    ruleSkips: [],
    activeTaskIds: new Set(),
    rules: [],
    rulesVersion: 0,
    ruleSetReplacedAt: null,
    ruleFiredAt: new Map(),
    pluginSettings: [],
    pluginSettingsVersion: 0,
  }) as unknown as View

/** 一张派单产物：来自 t-src 的 st-review 阶段。 */
const handed = (over: Partial<Task> = {}): Task =>
  task({
    id: 't-new',
    title: '修一遍登录',
    workflowId: 'wf-qa',
    currentStageId: 'st-qa',
    origin: 'handoff',
    handoffFromTaskId: 't-src',
    handoffFromStageId: 'st-review',
    ...over,
  })

describe('sourceHandoffOf 来源解析', () => {
  it('不是派单产物 → null', () => {
    expect(sourceHandoffOf(view(), task())).toBeNull()
  })

  it('来源任务或来源阶段已不在视图里 → null（脏投影不编造来源）', () => {
    expect(sourceHandoffOf(view({ tasks: [handed()] }), handed())).toBeNull()
    const onlySource = view({ tasks: [task(), handed({ handoffFromStageId: 'st-gone' })] })

    expect(sourceHandoffOf(onlySource, handed({ handoffFromStageId: 'st-gone' }))).toBeNull()
  })

  it('有 handoffFromRunId：直接取那一轮的结论', () => {
    const seeded = view({
      tasks: [task(), handed({ handoffFromRunId: 'run-1' })],
      runs: [
        run({ output: '第一轮结论' }),
        run({ id: 'run-2', output: '第二轮结论', endedAt: '2026-11-01T02:00:00.000Z' }),
      ],
    })

    const source = sourceHandoffOf(seeded, handed({ handoffFromRunId: 'run-1' }))

    expect(source).toMatchObject({
      workflowName: '研发',
      stageName: '评审',
      taskTitle: '实现登录',
      taskId: 't-src',
      runId: 'run-1',
      runStatus: 'succeeded',
      summary: '第一轮结论',
    })
  })

  it('人工派出（无 runId）：退回来源任务在来源阶段上最后一条终态 run', () => {
    const seeded = view({
      tasks: [task(), handed()],
      runs: [
        run({ id: 'run-old', output: '旧结论', endedAt: '2026-11-01T01:00:00.000Z' }),
        run({ id: 'run-new', output: '新结论', endedAt: '2026-11-01T03:00:00.000Z' }),
        // 还在跑的 run 不算「上一轮结论」
        run({ id: 'run-live', status: 'running', output: '半截', endedAt: null }),
      ],
    })

    const source = sourceHandoffOf(seeded, handed())

    expect(source?.runId).toBe('run-new')
    expect(source?.summary).toBe('新结论')
  })

  it('一条终态 run 都没有：只给任务与阶段，不编造结论', () => {
    const source = sourceHandoffOf(
      view({ tasks: [task(), handed()], runs: [run({ status: 'running', endedAt: null })] }),
      handed(),
    )

    expect(source).toMatchObject({ runId: null, runStatus: null, summary: '', stageName: '评审' })
  })
})
