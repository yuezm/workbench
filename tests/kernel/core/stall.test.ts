// @vitest-environment node
/**
 * 停机判据（M55，`core/stall.ts`）：盯谁、跳谁、下一次什么时候醒。
 *
 * 这里只喂**视图切片**，不碰 decide：判据是纯函数，分支全在「哪些 run / 卡 / 阶段算数」上，
 * 所以逐条构造边缘行（别的任务的 run、非终态 run、没有 endedAt 的终态、没有 run 的任务、
 * 停在等人阶段的任务、非开放卡）比跑整条流水线更能钉住口径。
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Card, RunRow, Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import {
  STALL_SILENCE_MS,
  nextStallAt,
  stallDueAt,
  stallWatchList,
} from '@workbench/kernel/core/stall'
import type { View } from '@workbench/kernel/core/types'

const CREATED = '2026-11-24T09:00:00.000Z'
const ENDED = '2026-11-24T09:10:00.000Z'
const LATER = '2026-11-24T09:20:00.000Z'
const DUE = new Date(Date.parse(ENDED) + STALL_SILENCE_MS).toISOString()
const DUE_LATER = new Date(Date.parse(LATER) + STALL_SILENCE_MS).toISOString()

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

/** 人肉阶段（`entryMode='user'`，不是内置阶段）：不派活，不该被盯。 */
const parkStage = (): WorkflowStage =>
  stage({ id: 'st-park', name: '人工验收', position: 1, entryMode: 'user', agentId: null })

/** 脚本阶段（`entryMode='script'`）：会派活，该被盯。 */
const scriptStage = (): WorkflowStage =>
  stage({ id: 'st-script', name: '跑门禁', position: 2, entryMode: 'script', agentId: null })

const blockedStage = (): WorkflowStage =>
  stage({ id: 'st-blocked', name: '已阻塞', position: 3, entryMode: 'user', builtin: 'blocked' })

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

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-fix',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'succeeded',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: CREATED,
  endedAt: ENDED,
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

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '确认',
  text: '',
  kind: 'ask',
  options: ['好'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  deliveryRefs: {},
  deliveryAttempts: 0,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredByRef: null,
  answeredAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 10,
  workflows: new Map([[workflow().id, workflow()]]),
  stages: new Map(
    [stage(), parkStage(), scriptStage(), blockedStage()].map((item) => [item.id, item]),
  ),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map([[task().id, task()]]),
  runs: new Map([[run().id, run()]]),
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

describe('core/stall 盯谁', () => {
  it('同一任务多条终态 run：取 endedAt 最大的一条；任务按 id 排序', () => {
    const watches = stallWatchList(
      view({
        tasks: new Map([
          ['t-2', task({ id: 't-2' })],
          ['t-1', task({ id: 't-1' })],
        ]),
        runs: new Map([
          ['run-ok', run({ id: 'run-ok', status: 'succeeded', endedAt: ENDED })],
          ['run-bad', run({ id: 'run-bad', status: 'failed', endedAt: LATER })],
          ['run-cancel', run({ id: 'run-cancel', status: 'cancelled', endedAt: CREATED })],
          ['run-t2', run({ id: 'run-t2', taskId: 't-2', status: 'succeeded', endedAt: ENDED })],
        ]),
      }),
    )
    expect(watches.map((watch) => watch.task.id)).toEqual(['t-1', 't-2'])
    expect(watches.map((watch) => watch.runId)).toEqual(['run-bad', 'run-t2'])
    expect(watches[0]?.endedAt).toBe(LATER)
    expect(stallDueAt(watches[0]!)).toBe(DUE_LATER)
    expect(stallDueAt(watches[1]!)).toBe(DUE)
  })

  it('脚本阶段也会派活：同样盯上', () => {
    const watches = stallWatchList(
      view({
        tasks: new Map([['t-1', task({ currentStageId: 'st-script' })]]),
        runs: new Map([['run-1', run({ stageId: 'st-script' })]]),
      }),
    )
    expect(watches.map((watch) => watch.stageId)).toEqual(['st-script'])
  })

  it('别的任务的 run / 非终态 run / 没有 endedAt 的终态：都不算「最近一轮」', () => {
    expect(
      stallWatchList(
        view({
          runs: new Map([
            ['run-other', run({ id: 'run-other', taskId: 't-9' })],
            ['run-running', run({ id: 'run-running', taskId: 't-1', status: 'running' })],
            ['run-null-end', run({ id: 'run-null-end', taskId: 't-1', endedAt: null })],
          ]),
        }),
      ),
    ).toEqual([])
  })

  it('没有当前阶段 / 停在等人阶段：不盯', () => {
    const noStage = stallWatchList(
      view({ tasks: new Map([['t-1', task({ currentStageId: null })]]) }),
    )
    expect(noStage).toEqual([])
    const parked = stallWatchList(
      view({
        tasks: new Map([['t-1', task({ currentStageId: 'st-park' })]]),
        runs: new Map([['run-1', run({ stageId: 'st-park' })]]),
      }),
    )
    expect(parked).toEqual([])
  })

  it('开着的是别人的卡 / 已答的卡：不影响判定；同任务有开放卡才放弃', () => {
    const otherTask = stallWatchList(
      view({ cards: new Map([['card-1', card({ taskId: 't-9' })]]) }),
    )
    expect(otherTask.map((watch) => watch.task.id)).toEqual(['t-1'])
    const answered = stallWatchList(
      view({ cards: new Map([['card-1', card({ status: 'answered' })]]) }),
    )
    expect(answered.map((watch) => watch.task.id)).toEqual(['t-1'])
    const open = stallWatchList(view({ cards: new Map([['card-1', card()]]) }))
    expect(open).toEqual([])
  })
})

describe('core/stall 下一次唤醒', () => {
  it('多个待判任务取最早；已经更晚的到点时刻不改写结果', () => {
    const shared = {
      tasks: new Map([
        ['t-1', task({ id: 't-1' })],
        ['t-2', task({ id: 't-2' })],
      ]),
    }
    // t-1 先到点：t-2 的到点时刻不比它早，保留 t-1
    expect(
      nextStallAt(
        view({
          ...shared,
          runs: new Map([
            ['run-1', run({ id: 'run-1', endedAt: ENDED })],
            ['run-2', run({ id: 'run-2', taskId: 't-2', endedAt: LATER })],
          ]),
        }),
      ),
    ).toBe(DUE)
    // 反过来：t-1 更晚，t-2 把最早时刻改写掉
    expect(
      nextStallAt(
        view({
          ...shared,
          runs: new Map([
            ['run-1', run({ id: 'run-1', endedAt: LATER })],
            ['run-2', run({ id: 'run-2', taskId: 't-2', endedAt: ENDED })],
          ]),
        }),
      ),
    ).toBe(DUE)
  })

  it('没有待判任务时给 null', () => {
    expect(nextStallAt(view({ activeTaskIds: new Set(['t-1']) }))).toBeNull()
  })
})

// —— 性质测试（fast-check）：判据的完备性 ————————————————————————————————
//
// 「谁该被盯」是六条判据的合取（代码注释里逐条列了）：没归档、阶段存在且不是内置、
// 阶段会派活、没有活跃 run、没有开着的卡、最近一轮已终态并带 endedAt。少算一条就误报，
// 多算一条就漏报——两者都直接变成假停机卡或永久静默。
//
// 预言机把六条判据摊成一次独立的过滤 + 取最大，不复用被测实现的循环；
// 生成器让每个任务的 endedAt 互不相同，于是「取最大」不必约定同刻先后。
//
// 固定种子：同一份输入永远给出同一条反例；`FC_SEED` 可覆盖。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261126)
const PROPERTY_RUNS = 200

const WATCH_TIMES = [
  '2026-11-24T09:00:00.000Z',
  '2026-11-24T09:10:00.000Z',
  '2026-11-24T09:20:00.000Z',
  '2026-11-24T09:30:00.000Z',
] as const

const TASK_IDS = ['t-1', 't-2', 't-3'] as const
const STAGE_CHOICES = [
  'st-1',
  'st-script',
  'st-park',
  'st-blocked',
  'st-builtin-agent',
  'st-gone',
  null,
] as const
const RUN_STATUSES = ['succeeded', 'failed', 'cancelled', 'running', 'queued', 'waiting'] as const

const taskRowsArb: fc.Arbitrary<Task[]> = fc
  .array(
    fc.record({
      currentStageId: fc.constantFrom(...STAGE_CHOICES),
      archived: fc.boolean(),
    }),
    { maxLength: 3 },
  )
  .map((shapes) =>
    shapes.map((shape, index) =>
      task({
        id: TASK_IDS[index] as string,
        currentStageId: shape.currentStageId,
        archivedAt: shape.archived ? WATCH_TIMES[0] : null,
      }),
    ),
  )

const runRowsArb: fc.Arbitrary<RunRow[]> = fc
  .array(
    fc.record({
      taskId: fc.constantFrom(...TASK_IDS, 't-other'),
      status: fc.constantFrom(...RUN_STATUSES),
      withEndedAt: fc.boolean(),
    }),
    { maxLength: 4 },
  )
  .map((shapes) =>
    shapes.map((shape, index) =>
      run({
        id: `run-w${index}`,
        taskId: shape.taskId,
        status: shape.status,
        endedAt: shape.withEndedAt ? (WATCH_TIMES[index] as string) : null,
      }),
    ),
  )

const cardRowsArb: fc.Arbitrary<Card[]> = fc
  .array(
    fc.record({
      taskId: fc.constantFrom(...TASK_IDS, 't-other'),
      status: fc.constantFrom<Card['status']>('open', 'answered', 'resolved'),
    }),
    { maxLength: 2 },
  )
  .map((shapes) => shapes.map((shape, index) => card({ id: `card-w${index}`, ...shape })))

const activeIdsArb = fc.uniqueArray(fc.constantFrom(...TASK_IDS), { maxLength: 2 })

/**
 * 内置阶段被配成「会派活」（脏配置，uiltin 与 ntryMode 冲突）：
 * 判据里必须由 uiltin !== null 拦下，不能靠入口模式顺带挡掉。
 */
const builtinAgentStage = stage({
  id: 'st-builtin-agent',
  name: '已阻塞',
  position: 4,
  entryMode: 'agent',
  builtin: 'blocked',
})

const STAGES = [stage(), parkStage(), scriptStage(), blockedStage(), builtinAgentStage]
const propertyStages = new Map(STAGES.map((item) => [item.id, item]))

interface WatchOracleInput {
  tasks: Task[]
  runs: RunRow[]
  cards: Card[]
  active: string[]
}

/** 独立预言机：六条判据一次过滤 + 取 endedAt 最大的那一轮。 */
const watchOracle = ({ tasks, runs, cards, active }: WatchOracleInput) => {
  const watched: { taskId: string; stageId: string; runId: string; endedAt: string }[] = []
  for (const row of [...tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    if (row.archivedAt !== null) continue
    const stage = STAGES.find((item) => item.id === row.currentStageId)
    if (stage === undefined || stage.builtin !== null) continue
    if (stage.entryMode !== 'agent' && stage.entryMode !== 'script') continue
    if (active.includes(row.id)) continue
    if (cards.some((item) => item.taskId === row.id && item.status === 'open')) continue
    const settled = runs.filter(
      (item) =>
        item.taskId === row.id &&
        (item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled') &&
        item.endedAt !== null,
    )
    if (settled.length === 0) continue
    const latest = settled.reduce((best, item) =>
      (item.endedAt as string) > (best.endedAt as string) ? item : best,
    )
    watched.push({
      taskId: row.id,
      stageId: stage.id,
      runId: latest.id,
      endedAt: latest.endedAt as string,
    })
  }
  return watched
}

describe('core/stall 性质（fast-check 随机生成）', () => {
  it('盯的就是六条判据同时成立的任务，按 id 稳定排序，取最近一轮终态', () => {
    fc.assert(
      fc.property(
        taskRowsArb,
        runRowsArb,
        cardRowsArb,
        activeIdsArb,
        (tasks, runs, cards, active) => {
          const target = view({
            stages: propertyStages,
            tasks: new Map(tasks.map((item) => [item.id, item])),
            runs: new Map(runs.map((item) => [item.id, item])),
            cards: new Map(cards.map((item) => [item.id, item])),
            activeTaskIds: new Set(active),
          })
          const actual = stallWatchList(target).map((watch) => ({
            taskId: watch.task.id,
            stageId: watch.stageId,
            runId: watch.runId,
            endedAt: watch.endedAt,
          }))
          expect(actual).toEqual(watchOracle({ tasks, runs, cards, active }))
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('到点时刻恰是「最近一轮结束 + 静默阈值」；下一次唤醒就是其中最早的那个', () => {
    fc.assert(
      fc.property(
        taskRowsArb,
        runRowsArb,
        cardRowsArb,
        activeIdsArb,
        (tasks, runs, cards, active) => {
          const target = view({
            stages: propertyStages,
            tasks: new Map(tasks.map((item) => [item.id, item])),
            runs: new Map(runs.map((item) => [item.id, item])),
            cards: new Map(cards.map((item) => [item.id, item])),
            activeTaskIds: new Set(active),
          })
          const watches = stallWatchList(target)
          for (const watch of watches) {
            expect(stallDueAt(watch)).toBe(
              new Date(Date.parse(watch.endedAt) + STALL_SILENCE_MS).toISOString(),
            )
          }
          const due = watches.map((watch) => stallDueAt(watch)).sort()
          expect(nextStallAt(target)).toBe(due.length === 0 ? null : (due[0] as string))
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})

describe('core/stall 同刻并列', () => {
  it('两轮同一时刻结束：取视图里先出现的那条（重建与增量同序，结果可复现）', () => {
    const watches = stallWatchList(
      view({
        runs: new Map([
          ['run-first', run({ id: 'run-first', endedAt: LATER })],
          ['run-second', run({ id: 'run-second', endedAt: LATER })],
        ]),
      }),
    )

    expect(watches.map((watch) => watch.runId)).toEqual(['run-first'])
  })
})
