// @vitest-environment node
/**
 * 阶段走不动的收口（M55，`scopes/stall.ts`）的边缘臂。
 *
 * 这里只钉「提前返回 / 不重复开卡 / 不吃自己产的事实」这些分支：命中之后的正常产物
 * 已由 `scopes/stall.test.ts` 覆盖，重复写一遍只会让断言变脆。
 */
import { describe, expect, it } from 'vitest'
import type { Card, RunRow, Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import type { ReviewFinding, ReviewReport } from '@workbench/protocol/review'
import {
  addressRepairFacts,
  blockedTransition,
  parkNoticesOnEnter,
  stageErroredFacts,
} from '@workbench/kernel/scopes/stall'
import type { Decision, Environment, FactDraft, Limits, View } from '@workbench/kernel/core/types'
import { testLimits } from '../../support/kernel-view'

const CREATED = '2026-11-24T09:00:00.000Z'
const NOW = '2026-11-24T09:30:00.000Z'

/** 限制取内核契约默认值（与生产同口径；不在这里抄数字，抄的那份会漂）。 */
const limits = (): Limits => testLimits()

const env = (): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: limits(),
  nextId: (kind) => `${kind}-next`,
})

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

const blockedStage = (): WorkflowStage =>
  stage({ id: 'st-blocked', name: '已阻塞', position: 3, entryMode: 'user', builtin: 'blocked' })

const doneStage = (): WorkflowStage =>
  stage({ id: 'st-done', name: '已完成', position: 4, entryMode: 'none', builtin: 'done' })

/** 人肉阶段 + 喊人开关：进入时该开停机卡。 */
const notifyStage = (): WorkflowStage =>
  stage({
    id: 'st-park',
    name: '人工验收',
    position: 1,
    entryMode: 'user',
    agentId: null,
    notifyOnPark: true,
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
  endedAt: NOW,
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

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'rev-1#R1',
  key: 'R1',
  severity: 'blocker',
  location: 'src/a.ts:1',
  claim: '断言',
  evidence: null,
  requiredAction: '验收',
  status: 'open',
  note: null,
  addressedByRunId: null,
  updatedAt: CREATED,
  ...over,
})

const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  id: 'rev-1',
  taskId: 't-1',
  stageId: 'st-fix',
  runId: 'run-1',
  threadId: null,
  rev: 2,
  verdict: 'fail',
  checks: [],
  findings: [finding()],
  artifact: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 10,
  workflows: new Map([[workflow().id, workflow()]]),
  stages: new Map(
    [stage(), blockedStage(), doneStage(), notifyStage()].map((item) => [item.id, item]),
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

const movedFact = (row: Task): FactDraft =>
  ({
    type: 'task.moved',
    actor: { kind: 'kernel' },
    at: NOW,
    payload: { task: row, from: 'st-fix', to: row.currentStageId },
  }) as unknown as FactDraft

const openedFact = (row: Card): FactDraft =>
  ({
    type: 'card.opened',
    actor: { kind: 'host', via: 'scheduler' },
    at: NOW,
    payload: { card: row },
  }) as unknown as FactDraft

describe('addressRepairFacts：缺任务 / 缺阶段时零事实', () => {
  it('没有报告 → 零事实（闸门自己的「没给结论」走另一条路）', () => {
    expect(addressRepairFacts(view(), run(), { facts: [], blocked: false }, NOW, env())).toEqual([])
  })

  it('run 没挂任务 / 挂的任务不在视图里 → 零事实', () => {
    const review = { facts: [], blocked: false, report: report() }
    expect(addressRepairFacts(view(), run({ taskId: null }), review, NOW, env())).toEqual([])
    expect(addressRepairFacts(view(), run({ taskId: 't-9' }), review, NOW, env())).toEqual([])
  })

  it('run 没挂阶段 → 零事实', () => {
    const review = { facts: [], blocked: false, report: report() }
    expect(addressRepairFacts(view(), run({ stageId: null }), review, NOW, env())).toEqual([])
  })
})

describe('blockedTransition：定位不到就不收口', () => {
  it('run 没挂任务 / 没挂阶段 → 零事实（不猜）', () => {
    const review = { facts: [], blocked: false }
    expect(blockedTransition(view(), run({ taskId: null }), review, NOW, env())).toEqual({
      facts: [],
    })
    expect(blockedTransition(view(), run({ stageId: null }), review, NOW, env())).toEqual({
      facts: [],
    })
  })
})

describe('stageErroredFacts：不该收口的情形', () => {
  it('任务 / 阶段不在视图里 → 零事实', () => {
    const review = { facts: [], blocked: true }
    expect(
      stageErroredFacts(
        view(),
        { taskId: 't-9', stageId: 'st-fix', runId: 'run-1' },
        review,
        NOW,
        env(),
      ),
    ).toEqual([])
    expect(
      stageErroredFacts(
        view(),
        { taskId: 't-1', stageId: 'st-9', runId: 'run-1' },
        review,
        NOW,
        env(),
      ),
    ).toEqual([])
  })

  it('任务已经停在终态阶段 → 零事实（完成之后迟到的报告不再把人叫回来）', () => {
    expect(
      stageErroredFacts(
        view({
          stages: new Map([stage(), blockedStage(), doneStage()].map((item) => [item.id, item])),
          tasks: new Map([['t-1', task({ currentStageId: 'st-done' })]]),
        }),
        { taskId: 't-1', stageId: 'st-fix', runId: 'run-1' },
        { facts: [], blocked: true },
        NOW,
        env(),
      ),
    ).toEqual([])
  })
})

describe('stageErroredFacts：文案与去向', () => {
  it('报告带阻断项：原因 review_unaddressed，评论带上报告 rev', () => {
    const facts = stageErroredFacts(
      view(),
      { taskId: 't-1', stageId: 'st-fix', runId: 'run-1' },
      { facts: [], blocked: true, report: report() },
      NOW,
      env(),
    )
    const errored = facts.find((fact) => fact.type === 'stage.errored')
    expect(errored?.payload).toMatchObject({
      reason: 'review_unaddressed',
      findings: ['rev-1#R1'],
      reportId: 'rev-1',
    })
    const comment = facts.find((fact) => fact.type === 'task.comment_added')
    expect((comment?.payload as { comment: { text: string } }).comment.text).toContain('rev 2')
  })

  it('报告没有阻断项：文案说「已跑满补回执轮次」，不列 id', () => {
    const facts = stageErroredFacts(
      view(),
      { taskId: 't-1', stageId: 'st-fix', runId: 'run-1' },
      { facts: [], blocked: true, report: report({ findings: [] }) },
      NOW,
      env(),
    )
    const errored = facts.find((fact) => fact.type === 'stage.errored')
    expect(errored?.payload).toMatchObject({ reason: 'budget_exhausted', findings: [] })
    const comment = facts.find((fact) => fact.type === 'task.comment_added')
    expect((comment?.payload as { comment: { text: string } }).comment.text).toContain(
      '已跑满 3 轮补回执',
    )
  })

  it('阻断项超过 5 条：文案带 id 列表只列前 5 条并补「等 N 条」', () => {
    const many = Array.from({ length: 6 }, (_unused, index) =>
      finding({ id: `rev-1#R${index + 1}`, key: `R${index + 1}` }),
    )
    const facts = stageErroredFacts(
      view(),
      { taskId: 't-1', stageId: 'st-fix', runId: 'run-1' },
      { facts: [], blocked: true, report: report({ findings: many }) },
      NOW,
      env(),
    )
    const comment = facts.find((fact) => fact.type === 'task.comment_added')
    const text = (comment?.payload as { comment: { text: string } }).comment.text
    expect(text).toContain('rev-1#R1、rev-1#R2、rev-1#R3、rev-1#R4、rev-1#R5 等 6 条')
  })

  it('任务没有当前阶段：仍按「未开始」收口（移动到「已阻塞」）', () => {
    const facts = stageErroredFacts(
      view({ tasks: new Map([['t-1', task({ currentStageId: null })]]) }),
      { taskId: 't-1', stageId: 'st-fix', runId: 'run-1' },
      { facts: [], blocked: true },
      NOW,
      env(),
    )
    const moved = facts.find((fact) => fact.type === 'task.moved')
    expect((moved?.payload as { to: string }).to).toBe('st-blocked')
  })

  it('任务已经停在「已阻塞」：只留阶段错误，不再产 task.moved', () => {
    const facts = stageErroredFacts(
      view({ tasks: new Map([['t-1', task({ currentStageId: 'st-blocked' })]]) }),
      { taskId: 't-1', stageId: 'st-fix', runId: 'run-1' },
      { facts: [], blocked: true },
      NOW,
      env(),
    )
    expect(facts.some((fact) => fact.type === 'task.moved')).toBe(false)
    expect(facts.some((fact) => fact.type === 'stage.errored')).toBe(true)
  })
})

describe('parkNoticesOnEnter：不重复喊人', () => {
  const decisionOf = (...facts: FactDraft[]): Decision => ({ facts })

  it('视图里已有开着的停机卡：同任务不再开（别的卡 / 无主卡不影响）', () => {
    const covered = parkNoticesOnEnter(
      view({
        cards: new Map([
          ['card-stall', card({ id: 'card-stall', kind: 'stall' })],
          ['card-orphan', card({ id: 'card-orphan', taskId: null, kind: 'stall' })],
        ]),
      }),
      decisionOf(movedFact(task({ currentStageId: 'st-park' }))),
      NOW,
      env(),
    )
    expect(
      covered.facts.some((fact) => fact.type === 'card.opened' || fact.type === 'card.updated'),
    ).toBe(false)
  })

  it('本批已为该任务开过停机卡：同批不再开第二张；别的任务照常开', () => {
    const decision = parkNoticesOnEnter(
      view({
        tasks: new Map([
          ['t-1', task()],
          ['t-2', task({ id: 't-2' })],
        ]),
      }),
      decisionOf(
        openedFact(card({ id: 'card-new', taskId: 't-1', kind: 'stall' })),
        movedFact(task({ currentStageId: 'st-park' })),
        movedFact(task({ id: 't-2', currentStageId: 'st-park' })),
      ),
      NOW,
      env(),
    )
    const opened = decision.facts.filter((fact) => fact.type === 'card.opened')
    expect(opened).toHaveLength(2)
    const titles = opened.map(
      (fact) => (fact.payload as { card: { taskId: string | null; title: string } }).card,
    )
    expect(titles.map((row) => row.taskId)).toEqual(['t-1', 't-2'])
  })

  it('moved 的事实里任务没有当前阶段：跳过（阶段查不到就不猜要不要喊人）', () => {
    const decision = parkNoticesOnEnter(
      view(),
      decisionOf(movedFact(task({ currentStageId: null }))),
      NOW,
      env(),
    )
    expect(decision.facts).toHaveLength(1)
  })
})
