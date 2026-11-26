// @vitest-environment node
/**
 * 停机判据（M55，`core/stall.ts`）：盯谁、跳谁、下一次什么时候醒。
 *
 * 这里只喂**视图切片**，不碰 decide：判据是纯函数，分支全在「哪些 run / 卡 / 阶段算数」上，
 * 所以逐条构造边缘行（别的任务的 run、非终态 run、没有 endedAt 的终态、没有 run 的任务、
 * 停在等人阶段的任务、非开放卡）比跑整条流水线更能钉住口径。
 */
import { describe, expect, it } from 'vitest'
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
