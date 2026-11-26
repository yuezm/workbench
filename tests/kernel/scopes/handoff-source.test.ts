// @vitest-environment node
/**
 * 来源工单解析（M31）：派单产物的提示词要能看到「从哪来、上一轮结论是什么」。
 *
 * 只构造 `View` 假数据，不起 DB；排版在 `tests/kernel/prompt.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { RunRow, Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import type { View } from '@workbench/kernel/core/types'
import { sourceHandoffOf } from '@workbench/kernel/scopes/handoff-source'

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

// —— 性质测试（fast-check）：来源结论的选取 ————————————————————————————————
//
// 「上一轮结论」只有一个正确语义：来源任务在来源阶段上**at 最大的一条终态 run**
// （`at = endedAt ?? createdAt`）。活跃轮（queued / running / waiting）不算、别的任务与
// 别的阶段的 run 不算、显式给了 runId 就以它为准。
//
// 这些正是提示词里「来源工单」段的内容来源：选错一轮，修复阶段就会照着别人的结论干活。
// 生成器保证每轮的 at 互不相同，于是预言机只需「取最大」，不必约定同刻的先后。
//
// 固定种子：同一份输入永远给出同一条反例；`FC_SEED` 可覆盖。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261126)
const PROPERTY_RUNS = 200

/** 每轮一个互不相同的时刻（endedAt 与 createdAt 是两次不同的排列，顺便打乱「按哪个算」）。 */
const RUN_TIMES = [
  '2026-11-01T00:00:00.000Z',
  '2026-11-01T01:00:00.000Z',
  '2026-11-01T02:00:00.000Z',
  '2026-11-01T03:00:00.000Z',
] as const

const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const

const runBatchArb: fc.Arbitrary<RunRow[]> = fc
  .array(
    fc.record({
      status: fc.constantFrom(...RUN_STATUSES),
      withEndedAt: fc.boolean(),
      output: fc.string({ maxLength: 6 }),
    }),
    { maxLength: 4 },
  )
  .map((shapes) =>
    shapes.map((shape, index) =>
      run({
        id: `run-p${index}`,
        taskId: 't-src',
        stageId: 'st-review',
        status: shape.status,
        output: shape.output,
        createdAt: RUN_TIMES[index] as string,
        endedAt: shape.withEndedAt ? (RUN_TIMES[3 - index] as string) : null,
      }),
    ),
  )

/** 独立预言机：来源任务 + 来源阶段 + 终态，取 at 最大的一条。 */
const latestSettledOf = (runs: RunRow[]): RunRow | undefined => {
  const settled = runs.filter(
    (row) =>
      row.taskId === 't-src' &&
      row.stageId === 'st-review' &&
      row.status !== 'queued' &&
      row.status !== 'running' &&
      row.status !== 'waiting',
  )
  if (settled.length === 0) return undefined
  return settled.reduce((best, row) =>
    (row.endedAt ?? row.createdAt) > (best.endedAt ?? best.createdAt) ? row : best,
  )
}

describe('sourceHandoffOf 的性质（fast-check 随机生成）', () => {
  it('人工派出：取 at 最大的终态 run，活跃轮与别的任务 / 阶段都不算', () => {
    fc.assert(
      fc.property(runBatchArb, (runs) => {
        const target = handed()
        const source = sourceHandoffOf(view({ tasks: [task(), target], runs }), target)
        const expected = latestSettledOf(runs)
        const label = JSON.stringify(runs.map((row) => [row.id, row.status, row.endedAt]))
        expect(source?.runId ?? null, label).toBe(expected?.id ?? null)
        expect(source?.runStatus, label).toBe(expected?.status ?? null)
        expect(source?.summary, label).toBe(expected?.output ?? '')
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('显式 handoffFromRunId：就是那一轮，与它是不是最新无关', () => {
    fc.assert(
      fc.property(runBatchArb, fc.nat({ max: 3 }), (runs, pick) => {
        if (runs.length === 0) return
        const chosen = runs[pick % runs.length] as RunRow
        const target = handed({ handoffFromRunId: chosen.id })
        const source = sourceHandoffOf(view({ tasks: [task(), target], runs }), target)
        expect(source?.runId).toBe(chosen.id)
        expect(source?.runStatus).toBe(chosen.status)
        expect(source?.summary).toBe(chosen.output)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('纯函数：同一份视图两次解析逐字相同；任务名 / 阶段名 / 结论都只来自视图', () => {
    fc.assert(
      fc.property(runBatchArb, (runs) => {
        const target = handed()
        const seeded = view({ tasks: [task(), target], runs })
        const first = sourceHandoffOf(seeded, target)
        const second = sourceHandoffOf(seeded, target)
        expect(first).toEqual(second)
        expect(first?.taskId).toBe('t-src')
        expect(first?.taskTitle).toBe('实现登录')
        expect(first?.workflowName).toBe('研发')
        expect(first?.stageName).toBe('评审')
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})

describe('sourceHandoffOf 同刻并列', () => {
  it('两轮同一时刻结束：取视图里先出现的那条（重建与增量同序，结果可复现）', () => {
    const seeded = view({
      tasks: [task(), handed()],
      runs: [
        run({ id: 'run-first', output: '先', endedAt: '2026-11-01T03:00:00.000Z' }),
        run({ id: 'run-second', output: '后', endedAt: '2026-11-01T03:00:00.000Z' }),
      ],
    })

    expect(sourceHandoffOf(seeded, handed())?.runId).toBe('run-first')
  })
})
