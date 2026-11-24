// @vitest-environment node
/**
 * 静默哨兵（M55）：`clock.tick` 扫「没人管的任务」→ 阶段错误 → 进「已阻塞」→ 停机卡。
 *
 * 判据全在 `core/stall.ts`（没有活跃 run / 没有开着的卡 / 会派活的阶段 / 静默 ≥10 分钟），
 * 这里只验「命中之后做什么」「不该命中的别误报」「下一次唤醒算得到」。
 */
import { describe, expect, it } from 'vitest'
import type { Card, RunRow, Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import type { StageErroredPayload } from '@workbench/protocol/facts'
import { STALL_SILENCE_MS, stallDueAt, stallWatchList } from '@workbench/kernel/core/stall'
import { nextWakeAt } from '@workbench/kernel/core/next-wake'
import { decide } from '@workbench/kernel/decide'
import { stallSweepFacts } from '@workbench/kernel/scopes/stall'
import type { Decision, Environment, Limits, View } from '@workbench/kernel/core/types'

const CREATED = '2026-11-24T09:00:00.000Z'
const ENDED = '2026-11-24T09:10:00.000Z'
const DUE = new Date(Date.parse(ENDED) + STALL_SILENCE_MS).toISOString()

const limits = (): Limits => ({
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
})

const env = (): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: limits(),
  nextId: (kind) => `${kind}-next`,
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

const blockedStage = (): WorkflowStage =>
  stage({
    id: 'st-blocked',
    name: '已阻塞',
    position: 2,
    entryMode: 'user',
    agentId: null,
    builtin: 'blocked',
  })

const workflow = (): Workflow => ({ id: 'wf-1', name: '研发', description: '', createdAt: CREATED })

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

/** 已终态的一轮（静默从这里开始算）。 */
const settled = (over: Partial<RunRow> = {}): RunRow => ({
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
  stages: new Map([
    [stage().id, stage()],
    [blockedStage().id, blockedStage()],
  ]),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map([[task().id, task()]]),
  runs: new Map([[settled().id, settled()]]),
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

describe('M55 静默哨兵', () => {
  it('盯上：会派活的阶段 + 已终态 run + 没有活跃 run / 开着的卡', () => {
    const watches = stallWatchList(view())
    expect(watches.map((watch) => watch.task.id)).toEqual(['t-1'])
    expect(stallDueAt(watches[0]!)).toBe(DUE)
  })

  it('有活跃 run / 有开着的卡 / 内置阶段 / 归档任务：都不盯', () => {
    expect(stallWatchList(view({ activeTaskIds: new Set(['t-1']) }))).toEqual([])
    expect(stallWatchList(view({ cards: new Map([['card-1', card()]]) }))).toEqual([])
    expect(
      stallWatchList(
        view({
          tasks: new Map([['t-1', task({ currentStageId: 'st-blocked' })]]),
        }),
      ),
    ).toEqual([])
    expect(
      stallWatchList(view({ tasks: new Map([['t-1', task({ archivedAt: CREATED })]]) })),
    ).toEqual([])
  })

  it('到点才收：阶段错误 + 进「已阻塞」+ 停机卡 + 评论；没到点零事实', () => {
    expect(stallSweepFacts(view(), ENDED, env())).toEqual([])
    const facts = stallSweepFacts(view(), DUE, env())
    const errored = facts.find((fact) => fact.type === 'stage.errored')
    expect((errored?.payload as StageErroredPayload).reason).toBe('stalled')
    expect((errored?.payload as StageErroredPayload).stageName).toBe('修复')
    const moved = facts.find((fact) => fact.type === 'task.moved')
    expect((moved?.payload as { to: string }).to).toBe('st-blocked')
    const opened = facts.find((fact) => fact.type === 'card.opened')
    expect((opened?.payload as { card: Card }).card.kind).toBe('stall')
    expect(facts.some((fact) => fact.type === 'task.comment_added')).toBe(true)
  })

  it('下一次唤醒算得到静默判定（否则定时器睡过去）', () => {
    expect(nextWakeAt(view(), ENDED, env())).toBe(DUE)
    // 已停住的（有活跃 run）不算唤醒依据
    expect(nextWakeAt(view({ activeTaskIds: new Set(['t-1']) }), ENDED, env())).toBeNull()
  })
})

describe('M55 进入「会喊人」的阶段', () => {
  /** 人肉阶段（entryMode='user'）打开喊人开关 */
  const parkStage = (over: Partial<WorkflowStage> = {}): WorkflowStage =>
    stage({
      id: 'st-park',
      name: '人工验收',
      position: 1,
      entryMode: 'user',
      agentId: null,
      notifyOnPark: true,
      ...over,
    })

  const moveInto = (stages: WorkflowStage[], targetStageId: string): Decision =>
    decide(
      view({ stages: new Map(stages.map((item) => [item.id, item])) }),
      { type: 'task.move', commandId: 'c-1', id: 't-1', stageId: targetStageId },
      DUE,
      env(),
    )

  it('移进打开开关的人肉阶段：开一张「轮到你」的停机卡', () => {
    const decision = moveInto([stage(), parkStage(), blockedStage()], 'st-park')
    const opened = decision.facts.find((fact) => fact.type === 'card.opened')
    const row = (opened?.payload as { card: Card }).card
    expect(row.kind).toBe('stall')
    expect(row.title).toBe('轮到你：人工验收')
  })

  it('开关关着 / 内置阶段 / 会派活的阶段：都不喊', () => {
    const off = moveInto([stage(), parkStage({ notifyOnPark: false }), blockedStage()], 'st-park')
    expect(off.facts.some((fact) => fact.type === 'card.opened')).toBe(false)
    const blockedMove = moveInto([stage(), blockedStage()], 'st-blocked')
    expect(blockedMove.facts.some((fact) => fact.type === 'card.opened')).toBe(false)
    const agentMove = moveInto(
      [
        stage(),
        parkStage({ id: 'st-agent', name: '再跑一轮', entryMode: 'agent', agentId: 'ag-1' }),
      ],
      'st-agent',
    )
    expect(agentMove.facts.some((fact) => fact.type === 'card.opened')).toBe(false)
  })
})
