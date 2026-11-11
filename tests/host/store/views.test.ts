// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  Conversation,
  Runtime,
  RuntimeStatus,
  WorkflowWithStages,
} from '../../../src/protocol/entities'
import type { AutomationRule } from '../../../src/protocol/rules'
import type { ViewId } from '../../../src/protocol/views'
import type { Change } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import { StoreError } from '../../../src/host/store/errors'
import { createProjectionWriter } from '../../../src/host/store/projection-apply'
import { loadView, queryView } from '../../../src/host/store/views'
import { SAMPLE_AT, captureError, createMemoryDb, sample, sampleProbe } from './test-support'

const OLDER_AT = '2025-12-01T00:00:00.000Z'

const runtimeNew = sample.runtime({
  id: 'rt-1',
  name: '较新运行时',
  createdAt: SAMPLE_AT,
  lastProbe: sampleProbe,
})
const runtimeOld = sample.runtime({
  id: 'rt-2',
  name: '较早运行时',
  createdAt: OLDER_AT,
  lastProbe: null,
})
const agent = sample.agent({ createdAt: OLDER_AT })
const workflowOld = sample.workflow({ id: 'wf-2', name: '流程二', createdAt: OLDER_AT })
const workflowNew = sample.workflow({ id: 'wf-1', name: '流程一', createdAt: SAMPLE_AT })
const stageFirst = sample.stage({ id: 'st-1', workflowId: 'wf-1', name: '第一步', position: 0 })
const stageSecond = sample.stage({ id: 'st-2', workflowId: 'wf-1', name: '第二步', position: 1 })
const taskOld = sample.task({
  id: 'tk-1',
  title: '任务一',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  createdAt: OLDER_AT,
})
const taskNew = sample.task({
  id: 'tk-2',
  title: '任务二',
  workflowId: 'wf-1',
  currentStageId: 'st-2',
  createdAt: SAMPLE_AT,
})
const taskOther = sample.task({
  id: 'tk-3',
  title: '别的工作流任务',
  workflowId: 'wf-2',
  currentStageId: null,
  createdAt: SAMPLE_AT,
})

// ---------- runs / conversations / messages 样例行 ----------

const runQueued = sample.run({
  id: 'run-queued',
  taskId: 'tk-1',
  stageId: 'st-1',
  queueSeq: 1,
  createdAt: OLDER_AT,
})
const runRunning = sample.run({
  id: 'run-running',
  taskId: 'tk-1',
  stageId: 'st-1',
  status: 'running',
  queueSeq: 2,
  attempt: 1,
  leaseId: 'run-running:1',
  leaseUntil: '2026-01-01T00:02:00.000Z',
  deadlineAt: '2026-01-01T00:30:00.000Z',
  startedAt: SAMPLE_AT,
})
const runWaiting = sample.run({
  id: 'run-waiting',
  taskId: 'tk-2',
  stageId: 'st-2',
  status: 'waiting',
  queueSeq: 3,
  attempt: 1,
  cancelRequested: true,
})
/** 聊天 run 不挂任务；这里故意给它 task_id，验证查询显式按 purpose 过滤（schema 不禁止该组合）。 */
const runChatOnTask = sample.run({
  id: 'run-chat-on-task',
  purpose: 'chat',
  taskId: 'tk-1',
  stageId: null,
  queueSeq: 4,
})
const runChat = sample.run({
  id: 'run-chat',
  purpose: 'chat',
  taskId: null,
  stageId: null,
  conversationId: 'cv-1',
  queueSeq: 5,
})
const runDone = sample.run({
  id: 'run-done',
  taskId: 'tk-2',
  stageId: 'st-2',
  status: 'succeeded',
  queueSeq: 6,
  eventIds: ['ev-1'],
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  endedAt: SAMPLE_AT,
})
const runStaleChat = sample.run({
  id: 'run-stale-chat',
  purpose: 'chat',
  taskId: null,
  stageId: null,
  conversationId: 'cv-1',
  status: 'running',
  leaseId: 'run-stale-chat:1',
  attempt: 1,
  turn: 2,
  queueSeq: 7,
})
/** 没有运行时的 run（手工 run）：负载视图不计入。 */
const runNoRuntime = sample.run({
  id: 'run-no-runtime',
  taskId: null,
  runtimeId: null,
  status: 'running',
  queueSeq: 8,
})
/** 无卡的 waiting run（历史挂起态）：`runs.waiting` 应报 hasOpenCard=false。 */
const runWaitingBare = sample.run({
  id: 'run-waiting-bare',
  taskId: null,
  stageId: null,
  status: 'waiting',
  turn: 2,
  queueSeq: 9,
})
const conversation = sample.conversation({ id: 'cv-1', title: '排查问题' })
const message = sample.message({ id: 'ms-1', conversationId: 'cv-1', content: '你好' })

// ---------- cards 样例行（读路径：按状态 / 按 run 过滤与排序） ----------

const CARD_AT_2 = '2025-12-02T00:00:00.000Z'
const CARD_AT_3 = '2025-12-03T00:00:00.000Z'
const CARD_AT_4 = '2025-12-04T00:00:00.000Z'

const card = sample.card({
  id: 'card-1',
  runId: 'run-queued',
  createdAt: OLDER_AT,
  updatedAt: OLDER_AT,
})
/** 已答卡：不进 `cards.open`，但属于该 run 的历史。 */
const cardAnswered = sample.card({
  id: 'card-answered',
  runId: 'run-queued',
  title: '已答',
  status: 'answered',
  optionIndex: 1,
  answeredBy: 'ui',
  answeredAt: CARD_AT_2,
  createdAt: CARD_AT_2,
  updatedAt: CARD_AT_2,
})
/** 已关闭卡：不进 `cards.open`，按 run 查时仍可见。 */
const cardResolved = sample.card({
  id: 'card-resolved',
  runId: 'run-running',
  title: '已关闭',
  status: 'resolved',
  createdAt: CARD_AT_3,
  updatedAt: CARD_AT_3,
})
const cardWaiting = sample.card({
  id: 'card-waiting',
  runId: 'run-waiting',
  title: '等待回答',
  createdAt: CARD_AT_4,
  updatedAt: CARD_AT_4,
})
const cardOpenRunning = sample.card({
  id: 'card-open-running',
  runId: 'run-running',
  title: '运行中卡',
  createdAt: SAMPLE_AT,
})

let openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

/** 用投影 writer 种数据：与真实写入路径同一套行映射。 */
function seed(db: DatabaseSync): void {
  const writer = createProjectionWriter(db)
  const changes: Change[] = [
    { table: 'runtimes', key: runtimeOld.id, row: runtimeOld },
    { table: 'runtimes', key: runtimeNew.id, row: runtimeNew },
    { table: 'workflows', key: workflowOld.id, row: workflowOld },
    { table: 'workflows', key: workflowNew.id, row: workflowNew },
    { table: 'agents', key: agent.id, row: agent },
    { table: 'workflow_stages', key: stageSecond.id, row: stageSecond },
    { table: 'workflow_stages', key: stageFirst.id, row: stageFirst },
    { table: 'tasks', key: taskNew.id, row: taskNew },
    { table: 'tasks', key: taskOld.id, row: taskOld },
    { table: 'tasks', key: taskOther.id, row: taskOther },
  ]
  for (const change of changes) writer.apply(change, SAMPLE_AT)
}

function seedRuns(db: DatabaseSync): void {
  db.prepare(
    'INSERT INTO runs (id, task_id, stage_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('run-queued', 'tk-1', 'st-1', 'queued', OLDER_AT)
  db.prepare(
    'INSERT INTO runs (id, task_id, stage_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('run-running', 'tk-1', 'st-1', 'running', SAMPLE_AT)
  db.prepare(
    'INSERT INTO runs (id, task_id, stage_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('run-done', 'tk-2', 'st-2', 'succeeded', SAMPLE_AT)
}

/** 走投影 writer 种 run / chat 行：与真实写入路径同一套列映射（JSON 列、布尔列都过一遍）。 */
function seedRunProjection(db: DatabaseSync): void {
  const writer = createProjectionWriter(db)
  const changes: Change[] = [
    { table: 'runs', key: runQueued.id, row: runQueued },
    { table: 'runs', key: runRunning.id, row: runRunning },
    { table: 'runs', key: runWaiting.id, row: runWaiting },
    { table: 'runs', key: runChatOnTask.id, row: runChatOnTask },
    { table: 'runs', key: runChat.id, row: runChat },
    { table: 'runs', key: runDone.id, row: runDone },
    { table: 'runs', key: runStaleChat.id, row: runStaleChat },
    { table: 'runs', key: runNoRuntime.id, row: runNoRuntime },
    { table: 'runs', key: runWaitingBare.id, row: runWaitingBare },
    { table: 'conversations', key: conversation.id, row: conversation },
    { table: 'messages', key: message.id, row: message },
    { table: 'cards', key: card.id, row: card },
    { table: 'cards', key: cardAnswered.id, row: cardAnswered },
    { table: 'cards', key: cardResolved.id, row: cardResolved },
    { table: 'cards', key: cardWaiting.id, row: cardWaiting },
    { table: 'cards', key: cardOpenRunning.id, row: cardOpenRunning },
  ]
  for (const change of changes) writer.apply(change, SAMPLE_AT)
}

describe('loadView：按 viewSpec 装载切片', () => {
  it('只查声明的表，其余为空 Map', () => {
    const db = memory()
    seed(db)

    const view = loadView(db, ['runtimes', 'agents'])

    expect([...view.runtimes.keys()]).toEqual(['rt-2', 'rt-1'])
    expect([...view.agents.keys()]).toEqual(['ag-1'])
    expect(view.workflows.size).toBe(0)
    expect(view.stages.size).toBe(0)
    expect(view.tasks.size).toBe(0)
    expect(view.activeTaskIds.size).toBe(0)
    expect(view.seq).toBe(0)
  })

  it('全量装载：行映射为协议实体，活跃任务集合来自 runs', () => {
    const db = memory()
    seed(db)
    seedRuns(db)

    const view = loadView(db, ['tasks', 'workflows', 'workflow_stages', 'agents', 'runtimes'])

    expect(view.tasks.get('tk-1')).toEqual(taskOld)
    expect(view.tasks.get('tk-2')).toEqual(taskNew)
    expect(view.workflows.get('wf-1')).toEqual(workflowNew)
    expect(view.stages.get('st-1')).toEqual(stageFirst)
    expect(view.agents.get('ag-1')).toEqual(agent)
    expect(view.runtimes.get('rt-1')).toEqual(runtimeNew)
    expect([...view.activeTaskIds]).toEqual(['tk-1'])
  })

  it('view.seq 取事实日志当前最大 seq', () => {
    const db = memory()
    seed(db)
    db.prepare('INSERT INTO facts (type, actor_json, at, payload) VALUES (?, ?, ?, ?)').run(
      'runtime.created',
      JSON.stringify({ kind: 'owner', via: 'ui' }),
      SAMPLE_AT,
      '{}',
    )

    expect(loadView(db, []).seq).toBe(1)
  })

  it('runs 切片：整行映射为 RunRow（JSON 列与布尔列还原）', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const view = loadView(db, ['runs'])

    expect([...view.runs.keys()]).toEqual([
      'run-queued',
      'run-running',
      'run-waiting',
      'run-chat-on-task',
      'run-chat',
      'run-done',
      'run-stale-chat',
      'run-no-runtime',
      'run-waiting-bare',
    ])
    expect(view.runs.get('run-running')).toEqual(runRunning)
    expect(view.runs.get('run-waiting')).toEqual(runWaiting)
    // usage / eventIds / cancelRequested 走 JSON 与 0/1 列，逐字段还原
    expect(view.runs.get('run-done')).toEqual(runDone)
    expect(view.conversations.size).toBe(0)
    expect(view.messages.size).toBe(0)
  })

  it('conversations / messages 切片：行映射为协议实体', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const view = loadView(db, ['conversations', 'messages'])

    expect(view.conversations.get('cv-1')).toEqual(conversation)
    expect(view.messages.get('ms-1')).toEqual(message)
    expect(view.runs.size).toBe(0)
  })

  it('activeTaskIds：queued/running/waiting 且只算 purpose=stage', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    // tk-1: queued + running；tk-2: waiting；聊天 run 与 succeeded 不计
    expect(loadView(db, ['runs']).activeTaskIds).toEqual(new Set(['tk-1', 'tk-2']))
  })

  it('activeTaskIds 不随切片裁剪：未声明 runs 也装载', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const view = loadView(db, [])

    expect(view.runs.size).toBe(0)
    expect(view.activeTaskIds).toEqual(new Set(['tk-1', 'tk-2']))
  })

  it('viewSpec 裁剪：run.claim 装 runs + runtimes + agents + threads，chat.send 装 chat 相关切片', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const claimView = loadView(db, viewSpec({ type: 'run.claim', runtimeId: 'rt-1', capacity: 1 }))
    expect(claimView.runs.size).toBe(9)
    expect(claimView.runtimes.size).toBe(2)
    expect(claimView.tasks.size).toBe(0)
    // M27：领取窗口按智能体算，`pickClaims` 要读 `view.agents`——切片必须带上 agents
    expect(claimView.agents.size).toBe(1)
    expect(claimView.conversations.size).toBe(0)
    expect(claimView.messages.size).toBe(0)

    const chatView = loadView(
      db,
      viewSpec({
        commandId: 'm5-chat',
        type: 'chat.send',
        conversationId: 'cv-1',
        content: '你好',
      }),
    )
    expect(chatView.conversations.size).toBe(1)
    expect(chatView.messages.size).toBe(1)
    expect(chatView.runs.size).toBe(9)
    expect(chatView.agents.size).toBe(1)
    expect(chatView.runtimes.size).toBe(2)
    expect(chatView.tasks.size).toBe(0)
  })

  it('review_reports 切片：JSON 列还原为行（artifact 为 null 时不吃 JSON.parse）；未声明时不装载', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    const task = sample.task()
    writer.apply({ table: 'tasks', key: task.id, row: task }, SAMPLE_AT)
    const otherTask = sample.task({ id: 'tk-other' })
    writer.apply({ table: 'tasks', key: otherTask.id, row: otherTask }, SAMPLE_AT)
    const base = {
      taskId: task.id,
      stageId: 'st-1',
      runId: 'run-1',
      threadId: null,
      rev: 1,
      verdict: 'fail' as const,
      checks: [{ cmd: 'pnpm check', exitCode: 1 }],
      findings: [
        {
          id: 'run-1:1#R1',
          key: 'R1',
          severity: 'high' as const,
          location: null,
          claim: '断言',
          evidence: null,
          requiredAction: '复跑',
          status: 'open' as const,
          note: null,
          addressedByRunId: null,
          updatedAt: SAMPLE_AT,
        },
      ],
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
    }
    const withArtifact = {
      ...base,
      id: 'run-1:1',
      artifact: { path: '/a/report.md', sha256: 'x', bytes: 3 },
    }
    const withoutArtifact = { ...base, id: 'run-2:1', runId: 'run-2', artifact: null }
    writer.apply({ table: 'review_reports', key: withArtifact.id, row: withArtifact }, SAMPLE_AT)
    writer.apply(
      { table: 'review_reports', key: withoutArtifact.id, row: withoutArtifact },
      SAMPLE_AT,
    )

    const view = loadView(db, ['review_reports'])
    expect(view.reviewReports.get('run-1:1')).toEqual(withArtifact)
    expect(view.reviewReports.get('run-2:1')?.artifact).toBeNull()
    expect(view.reviewReports.get('run-2:1')?.findings[0]?.id).toBe('run-1:1#R1')
    expect(loadView(db, []).reviewReports.size).toBe(0)
  })

  it('cards 切片：装载完整 Card 行并还原 options_json；未声明时不装载', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const view = loadView(db, ['cards'])
    expect([...view.cards.keys()]).toEqual([
      'card-1',
      'card-answered',
      'card-resolved',
      'card-waiting',
      'card-open-running',
    ])
    expect(view.cards.get('card-1')).toEqual(card)
    expect(view.cards.get('card-answered')).toEqual(cardAnswered)
    expect(loadView(db, []).cards.size).toBe(0)
  })
})

describe('queryView：各视图', () => {
  it('workflows.all：按创建时间排序，阶段按 position 排序', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'workflows.all')).toEqual([
      { ...workflowOld, stages: [] },
      { ...workflowNew, stages: [stageFirst, stageSecond] },
    ])
  })

  // 回归：`readStages` 的列清单曾漏掉闸门三列，读写不对称 → 闸门存进去、读回来变 null，
  // 编辑器重开就退回「交给智能体」，再保存还会把闸门配置抹掉。
  it('workflows.all：闸门配置经投影写入后能原样读回', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    const gateStage = sample.stage({
      id: 'st-gate',
      workflowId: 'wf-1',
      name: '验收',
      position: 2,
      entryMode: 'agent',
      agentId: agent.id,
      gate: { maxFails: 3, onPassStageId: 'st-1', onFailStageId: 'st-2' },
    })
    writer.apply({ table: 'workflow_stages', key: gateStage.id, row: gateStage }, SAMPLE_AT)

    const stages = (queryView(db, 'workflows.all') as WorkflowWithStages[]).find(
      (item) => item.id === 'wf-1',
    )?.stages
    expect(stages?.find((item) => item.id === 'st-gate')).toEqual(gateStage)
    // 三列全空的阶段仍归一成「不是闸门」
    expect(stages?.find((item) => item.id === 'st-1')?.gate).toBeNull()
  })

  it('agents.all / runtimes.all：按创建时间排序并映射 lastProbe', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'agents.all')).toEqual([agent])
    expect(queryView(db, 'runtimes.all')).toEqual([runtimeOld, runtimeNew])
    const runtimes = queryView(db, 'runtimes.all') as Runtime[]
    expect(runtimes[0]?.lastProbe).toBeNull()
    expect(runtimes[1]?.lastProbe).toEqual(sampleProbe)
  })

  it('tasks.byWorkflow：只取该工作流，按创建时间排序', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-1' })).toEqual([taskOld, taskNew])
    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-2' })).toEqual([taskOther])
    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-missing' })).toEqual([])
  })

  it('tasks.byParent：只取某任务的直接子任务（M8）', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    const child = sample.task({
      id: 'tk-child',
      parentTaskId: 'tk-1',
      spawnKey: 'k1',
      origin: 'spawn',
      workflowId: 'wf-1',
      currentStageId: 'st-1',
    })
    writer.apply({ table: 'tasks', key: child.id, row: child }, SAMPLE_AT)
    expect(queryView(db, 'tasks.byParent', { taskId: 'tk-1' })).toEqual([child])
    expect(queryView(db, 'tasks.byParent', { taskId: 'tk-missing' })).toEqual([])
  })

  it('task.byId：命中返回行，未命中返回 null', () => {
    const db = memory()
    seed(db)

    expect(queryView(db, 'task.byId', { taskId: 'tk-2' })).toEqual(taskNew)
    expect(queryView(db, 'task.byId', { taskId: 'tk-missing' })).toBeNull()
  })

  it('runs.active-by-task：只取 queued / running，按创建时间排序', () => {
    const db = memory()
    seed(db)
    seedRuns(db)

    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-1' })).toEqual([
      { id: 'run-queued', taskId: 'tk-1', stageId: 'st-1', status: 'queued' },
      { id: 'run-running', taskId: 'tk-1', stageId: 'st-1', status: 'running' },
    ])
    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-2' })).toEqual([])
  })

  it('runs.active-by-task：纳入 waiting，并按 purpose 过滤聊天 run', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-1' })).toEqual([
      { id: 'run-queued', taskId: 'tk-1', stageId: 'st-1', status: 'queued' },
      { id: 'run-running', taskId: 'tk-1', stageId: 'st-1', status: 'running' },
    ])
    // tk-2 的 succeeded run 不算活跃；waiting 算
    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-2' })).toEqual([
      { id: 'run-waiting', taskId: 'tk-2', stageId: 'st-2', status: 'waiting' },
    ])
  })

  it('空库：各视图返回空集合 / null', () => {
    const db = memory()

    expect(queryView(db, 'workflows.all')).toEqual([])
    expect(queryView(db, 'agents.all')).toEqual([])
    expect(queryView(db, 'runtimes.all')).toEqual([])
    expect(queryView(db, 'tasks.byWorkflow', { workflowId: 'wf-1' })).toEqual([])
    expect(queryView(db, 'task.byId', { taskId: 'tk-1' })).toBeNull()
    expect(queryView(db, 'runs.active-by-task', { taskId: 'tk-1' })).toEqual([])
  })

  it('未知视图与非法参数：StoreError(invalid_input)', () => {
    const db = memory()
    seed(db)

    const unknownView = captureError(() => queryView(db, 'threads.open' as ViewId))
    expect(unknownView).toBeInstanceOf(StoreError)
    expect((unknownView as StoreError).code).toBe('invalid_input')
    expect((unknownView as StoreError).message).toContain('threads.open')

    for (const params of [
      undefined,
      null,
      42,
      {},
      { workflowId: '' },
      { workflowId: 7 },
      { taskId: '' },
    ]) {
      const error = captureError(() => queryView(db, 'tasks.byWorkflow', params))
      expect((error as StoreError).code).toBe('invalid_input')
    }
    const taskParamError = captureError(() => queryView(db, 'task.byId', { taskId: 1 }))
    expect((taskParamError as StoreError).code).toBe('invalid_input')
  })
})

/** 直接写 run_events（读路径用例只需要行；真实写入经投影 writer 的 run_events 分支）。 */
function seedRunEvents(db: DatabaseSync): void {
  const insert = db.prepare(
    'INSERT INTO run_events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  insert.run('run-running', 1, 'text', JSON.stringify({ text: '先想一下' }), SAMPLE_AT)
  insert.run(
    'run-running',
    2,
    'tool_call',
    JSON.stringify({ tool: 'read', callId: 'c1', input: '{}' }),
    SAMPLE_AT,
  )
  insert.run('run-done', 1, 'text', JSON.stringify({ text: '别的 run' }), SAMPLE_AT)
}

describe('queryView：运行历史与负载（T16 读路径收口）', () => {
  it('runs.byTask：只取该任务的阶段 run，按创建顺序，调度列不外露', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const runs = queryView(db, 'runs.byTask', { taskId: 'tk-1' }) as Array<Record<string, unknown>>
    expect(runs.map((run) => run.id)).toEqual(['run-queued', 'run-running'])
    expect(runs[0]).toMatchObject({
      id: 'run-queued',
      taskId: 'tk-1',
      stageId: 'st-1',
      status: 'queued',
      output: '',
      usage: null,
    })
    // IPC 行字段与 M1 一致：不含 purpose / lease / attempts 等调度列
    for (const key of ['purpose', 'conversationId', 'leaseId', 'attempts', 'queueSeq']) {
      expect(runs[0]).not.toHaveProperty(key)
    }
    // 聊天 run 即便挂着 task_id（旧数据）也不进阶段看板
    expect(queryView(db, 'runs.byTask', { taskId: 'tk-2' })).toHaveLength(2)
    expect(queryView(db, 'runs.byTask', { taskId: 'tk-missing' })).toEqual([])
  })

  it('run.byId：命中返回完整投影行（含调度列），未命中 null', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'run.byId', { runId: 'run-running' })).toEqual(runRunning)
    expect(queryView(db, 'run.byId', { runId: 'run-chat' })).toEqual(runChat)
    expect(queryView(db, 'run.byId', { runId: 'ghost' })).toBeNull()
  })

  it('run.events：按 seq 排序返回事件流；没有事件 / 未知 run 都是空数组', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)
    seedRunEvents(db)

    expect(queryView(db, 'run.events', { runId: 'run-running' })).toEqual([
      { seq: 1, type: 'text', text: '先想一下' },
      { seq: 2, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' },
    ])
    expect(queryView(db, 'run.events', { runId: 'run-done' })).toEqual([
      { seq: 1, type: 'text', text: '别的 run' },
    ])
    expect(queryView(db, 'run.events', { runId: 'run-queued' })).toEqual([])
    expect(queryView(db, 'run.events', { runId: 'ghost' })).toEqual([])
  })

  it('run.last-event-seq：取最大 seq，没有事件时为 0', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)
    seedRunEvents(db)

    expect(queryView(db, 'run.last-event-seq', { runId: 'run-running' })).toBe(2)
    expect(queryView(db, 'run.last-event-seq', { runId: 'run-done' })).toBe(1)
    expect(queryView(db, 'run.last-event-seq', { runId: 'run-queued' })).toBe(0)
    expect(queryView(db, 'run.last-event-seq', { runId: 'ghost' })).toBe(0)
  })

  it('runtimes.workloads：只统计 queued / running，按运行时分组，忽略未绑定运行时的 run', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    // rt-1：running = run-running + run-stale-chat；queued = runQueued / runChatOnTask / runChat；
    // waiting 与 succeeded 不计，run-no-runtime 未绑定运行时（忽略）
    expect(queryView(db, 'runtimes.workloads')).toEqual([
      { runtimeId: 'rt-1', running: 2, queued: 3 },
    ])
  })

  it('runs.stale-chat：只取 running 的聊天 run（带 leaseId / turn）', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'runs.stale-chat')).toEqual([
      { id: 'run-stale-chat', leaseId: 'run-stale-chat:1', turn: 2 },
    ])
  })

  it('runs.waiting：只取 waiting，hasOpenCard 按 cards join，按创建顺序', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'runs.waiting')).toEqual([
      { runId: 'run-waiting', leaseId: null, turn: 1, hasOpenCard: true },
      { runId: 'run-waiting-bare', leaseId: null, turn: 2, hasOpenCard: false },
    ])
  })

  it('runs.waiting：没有 waiting run 时为空数组', () => {
    const db = memory()
    seed(db)
    seedRuns(db)

    expect(queryView(db, 'runs.waiting')).toEqual([])
  })

  it('空库：新视图返回空集合 / null / 0', () => {
    const db = memory()

    expect(queryView(db, 'runs.byTask', { taskId: 'tk-1' })).toEqual([])
    expect(queryView(db, 'run.byId', { runId: 'run-1' })).toBeNull()
    expect(queryView(db, 'run.events', { runId: 'run-1' })).toEqual([])
    expect(queryView(db, 'run.last-event-seq', { runId: 'run-1' })).toBe(0)
    expect(queryView(db, 'runtimes.workloads')).toEqual([])
    expect(queryView(db, 'runs.stale-chat')).toEqual([])
  })

  it('新视图缺参数：StoreError(invalid_input)', () => {
    const db = memory()
    for (const view of ['runs.byTask', 'run.byId', 'run.events', 'run.last-event-seq'] as const) {
      const error = captureError(() => queryView(db, view, {}))
      expect((error as StoreError).code).toBe('invalid_input')
    }
  })
})

describe('queryView：卡片审批（cards.open / cards.byRun，M4）', () => {
  it('cards.open：只含 status=open，按 createdAt 升序；已答 / 已关闭不出现', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'cards.open')).toEqual([card, cardWaiting, cardOpenRunning])
  })

  it('cards.byRun：按 run 过滤（含已答 / 已关闭），按 createdAt 升序', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'cards.byRun', { runId: 'run-queued' })).toEqual([card, cardAnswered])
    expect(queryView(db, 'cards.byRun', { runId: 'run-running' })).toEqual([
      cardResolved,
      cardOpenRunning,
    ])
    expect(queryView(db, 'cards.byRun', { runId: 'run-waiting' })).toEqual([cardWaiting])
    expect(queryView(db, 'cards.byRun', { runId: 'run-missing' })).toEqual([])
  })

  it('空库：两个视图都返回空数组', () => {
    const db = memory()

    expect(queryView(db, 'cards.open')).toEqual([])
    expect(queryView(db, 'cards.byRun', { runId: 'run-1' })).toEqual([])
  })

  it('cards.byRun 缺参数 / 非法参数：StoreError(invalid_input)', () => {
    const db = memory()
    for (const params of [undefined, null, 42, {}, { runId: '' }, { runId: 7 }]) {
      const error = captureError(() => queryView(db, 'cards.byRun', params))
      expect((error as StoreError).code).toBe('invalid_input')
      expect((error as StoreError).message).toContain('runId')
    }
  })
})

describe('queryView：M5 客户端视图（tasks.executing / runtimes.statuses / kernel.seq）', () => {
  it('tasks.executing：只取 stage run 的活跃任务，去重；chat run 与无任务 run 不计', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    const executing = queryView(db, 'tasks.executing') as string[]
    expect([...executing].sort()).toEqual(['tk-1', 'tk-2'])
  })

  it('tasks.executing：无活跃 run 时为空数组', () => {
    const db = memory()

    expect(queryView(db, 'tasks.executing')).toEqual([])
  })

  it('runtimes.statuses：全部运行时 + 负载（running/queued 只数活跃 run，并发上限在智能体上）', () => {
    const db = memory()
    seed(db)
    seedRunProjection(db)

    expect(queryView(db, 'runtimes.statuses')).toEqual([
      { runtimeId: 'rt-2', workload: { running: 0, queued: 0 } },
      { runtimeId: 'rt-1', workload: { running: 2, queued: 3 } },
    ])
    // M27：并发上限属于智能体，不再随运行时负载一起给出
    for (const row of queryView(db, 'runtimes.statuses') as RuntimeStatus[]) {
      expect(Object.keys(row.workload).sort()).toEqual(['queued', 'running'])
    }
  })

  it('runtimes.statuses：空库为空数组', () => {
    const db = memory()

    expect(queryView(db, 'runtimes.statuses')).toEqual([])
  })

  it('kernel.seq：事实日志最大 seq，空日志为 0', () => {
    const db = memory()
    expect(queryView(db, 'kernel.seq')).toBe(0)

    db.prepare(
      "INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES ('x', '{}', ?, NULL, NULL, '{}')",
    ).run(SAMPLE_AT)
    db.prepare(
      "INSERT INTO facts (type, actor_json, at, cause, hops, payload) VALUES ('y', '{}', ?, NULL, NULL, '{}')",
    ).run(SAMPLE_AT)
    expect(queryView(db, 'kernel.seq')).toBe(2)
  })

  it('宿主视图不读投影：executors / detected / models / approvals 走装配根注入，DB 查询明确报错', () => {
    const db = memory()
    for (const view of ['runtimes.executors', 'runtimes.detected', 'runtimes.models'] as const) {
      const error = captureError(() => queryView(db, view, { runtimeId: 'rt-1' }))
      expect((error as StoreError).code).toBe('invalid_input')
      expect((error as StoreError).message).toContain('宿主视图不读投影')
    }
    const approvals = captureError(() => queryView(db, 'run.approvals', { runId: 'run-1' }))
    expect((approvals as StoreError).code).toBe('invalid_input')
    expect((approvals as StoreError).message).toContain('宿主视图不读投影')
    const workdir = captureError(() => queryView(db, 'runtimes.default-workdir'))
    expect((workdir as StoreError).code).toBe('invalid_input')
  })
})

// ---------- M6 规则投影 ----------

const RULE_SET_AT = '2026-05-01T08:00:00.000Z'

const ruleEvent: AutomationRule = {
  id: 'rule-event',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
}

const ruleCron: AutomationRule = {
  id: 'rule-cron',
  name: '每日早报',
  when: { cron: '0 9 * * *' },
  to: { workflowId: 'wf-1' },
  enabled: true,
}

function seedRuleSet(
  db: DatabaseSync,
  version: number,
  replacedAt: string,
  rules: readonly AutomationRule[],
): void {
  db.prepare(
    'INSERT INTO rule_sets (id, version, replaced_at, rules_json) VALUES (?, ?, ?, ?)',
  ).run('current', version, replacedAt, JSON.stringify(rules))
}

function seedRuleFire(
  db: DatabaseSync,
  fire: {
    id: string
    ruleId: string
    version: number
    scheduledFor: string
    firedAt: string
    taskId: string | null
  },
): void {
  db.prepare(
    `INSERT INTO rule_fires (id, rule_id, version, scheduled_for, fired_at, task_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fire.id, fire.ruleId, fire.version, fire.scheduledFor, fire.firedAt, fire.taskId)
}

describe('loadView / queryView：规则投影（M6）', () => {
  it('未声明规则切片：rules 空、版本 0、无替换时刻、无触发基线', () => {
    const db = memory()
    seedRuleSet(db, 3, RULE_SET_AT, [ruleEvent])
    seedRuleFire(db, {
      id: 'fire-1',
      ruleId: 'rule-cron',
      version: 3,
      scheduledFor: RULE_SET_AT,
      firedAt: RULE_SET_AT,
      taskId: null,
    })

    const view = loadView(db, ['tasks'])
    expect(view.rules).toEqual([])
    expect(view.rulesVersion).toBe(0)
    expect(view.ruleSetReplacedAt).toBeNull()
    expect(view.ruleFiredAt.size).toBe(0)
  })

  it('rule_sets 切片：装载当前规则集、版本与替换时刻', () => {
    const db = memory()
    seedRuleSet(db, 3, RULE_SET_AT, [ruleEvent, ruleCron])

    const view = loadView(db, ['rule_sets'])
    expect(view.rules).toEqual([ruleEvent, ruleCron])
    expect(view.rulesVersion).toBe(3)
    expect(view.ruleSetReplacedAt).toBe(RULE_SET_AT)
    // 未声明 rule_fires：不读触发基线
    expect(view.ruleFiredAt.size).toBe(0)
  })

  it('rule_fires 切片：ruleFiredAt 取每条规则最近一次 scheduled_for（不是 fired_at）', () => {
    const db = memory()
    seedRuleFire(db, {
      id: 'fire-1',
      ruleId: 'rule-cron',
      version: 1,
      scheduledFor: '2026-05-01T09:00:00.000Z',
      firedAt: '2026-05-01T09:00:03.000Z',
      taskId: 'tk-1',
    })
    // 更晚的计划时刻 + 更晚的实际触发：基线取 scheduled_for 的最大值
    seedRuleFire(db, {
      id: 'fire-2',
      ruleId: 'rule-cron',
      version: 1,
      scheduledFor: '2026-05-02T09:00:00.000Z',
      firedAt: '2026-05-02T09:00:01.000Z',
      taskId: null,
    })
    // 另一条规则：只补最近一次
    seedRuleFire(db, {
      id: 'fire-3',
      ruleId: 'rule-other',
      version: 2,
      scheduledFor: '2026-05-01T10:00:00.000Z',
      firedAt: '2026-05-01T10:00:00.000Z',
      taskId: null,
    })

    const view = loadView(db, ['rule_fires'])
    expect([...view.ruleFiredAt.entries()]).toEqual([
      ['rule-cron', '2026-05-02T09:00:00.000Z'],
      ['rule-other', '2026-05-01T10:00:00.000Z'],
    ])
    // 未声明 rule_sets：规则清单与版本仍按空集装载
    expect(view.rules).toEqual([])
    expect(view.rulesVersion).toBe(0)
  })

  it('rules.all：无规则集返回 { version: 0, rules: [] }', () => {
    const db = memory()

    expect(queryView(db, 'rules.all')).toEqual({ version: 0, rules: [] })
  })

  it('rules.all：返回当前版本与规则清单（整批替换后的新版本）', () => {
    const db = memory()
    seedRuleSet(db, 4, RULE_SET_AT, [ruleCron])

    expect(queryView(db, 'rules.all')).toEqual({ version: 4, rules: [ruleCron] })
  })
})

// ---------- M6.5 线程 ----------

const THREAD_AT = '2026-06-01T00:00:00.000Z'
const THREAD_AT_2 = '2026-06-02T00:00:00.000Z'
const THREAD_AT_3 = '2026-06-03T00:00:00.000Z'

const threadNote = {
  id: 'tn-1',
  author: 'owner' as const,
  text: '先看日志再动手',
  at: THREAD_AT,
}
const threadEvent = {
  eventId: 'ev-1',
  type: 'issues.opened',
  subject: '#7',
  summary: '新 Issue',
  link: 'https://example.com/7',
  detailRef: null,
  at: THREAD_AT,
}

const threadTaskRoot = sample.task({
  id: 'tk-1',
  title: '任务一',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  threadId: 'th-1',
  createdAt: OLDER_AT,
  updatedAt: OLDER_AT,
})
const threadTaskChild = sample.task({
  id: 'tk-2',
  title: '任务二',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  threadId: 'th-1',
  parentTaskId: 'tk-1',
  createdAt: SAMPLE_AT,
})
/** 有 threadId 但不在 `thread.taskIds` 里：`thread.byId` 只按行的 `taskIds` 取任务。 */
const threadTaskDetached = sample.task({
  id: 'tk-3',
  title: '别的工作流任务',
  workflowId: 'wf-2',
  currentStageId: null,
  threadId: 'th-1',
  createdAt: SAMPLE_AT,
})

const openThread = sample.thread({
  id: 'th-1',
  source: 'github',
  externalRef: 'issue-7',
  title: 'Issue 七',
  status: 'open',
  // taskIds 故意倒序：`thread.byId` 的 tasks 按 created_at 排序，不跟 row 里的顺序
  taskIds: ['tk-2', 'tk-1'],
  rootTaskIds: ['tk-1'],
  notesVersion: 1,
  notes: [threadNote],
  events: [threadEvent],
  lastActivityAt: THREAD_AT_2,
  createdAt: THREAD_AT,
})
const closedThread = sample.thread({
  id: 'th-2',
  source: 'manual',
  externalRef: null,
  title: '隐式线程',
  status: 'closed',
  taskIds: [],
  rootTaskIds: [],
  lastActivityAt: THREAD_AT_3,
  createdAt: THREAD_AT_3,
})

/** 线程内每个 agent 最近一次终态 run 的会话；顺序 / 终态 / 空会话 / 跨线程都在这里钉住。 */
const threadRuns = [
  sample.run({
    id: 'run-th-old',
    taskId: 'tk-1',
    stageId: 'st-1',
    agentId: 'ag-1',
    threadId: 'th-1',
    status: 'succeeded',
    sessionId: 'sess-old',
    createdAt: THREAD_AT,
    endedAt: THREAD_AT,
  }),
  sample.run({
    id: 'run-th-new',
    taskId: 'tk-1',
    stageId: 'st-1',
    agentId: 'ag-1',
    threadId: 'th-1',
    status: 'failed',
    sessionId: 'sess-new',
    createdAt: THREAD_AT_2,
    endedAt: THREAD_AT_2,
  }),
  // 更晚的终态但没会话：按「取最后一条有 session_id 的」回落到 sess-new
  sample.run({
    id: 'run-th-no-session',
    taskId: 'tk-2',
    stageId: 'st-1',
    agentId: 'ag-1',
    threadId: 'th-1',
    status: 'cancelled',
    sessionId: null,
    createdAt: THREAD_AT_3,
    endedAt: THREAD_AT_3,
  }),
  // 非终态：不参与会话续接
  sample.run({
    id: 'run-th-running',
    taskId: 'tk-2',
    stageId: 'st-1',
    agentId: 'ag-1',
    threadId: 'th-1',
    status: 'running',
    sessionId: 'sess-running',
    createdAt: THREAD_AT_3,
  }),
  sample.run({
    id: 'run-th-agent-2',
    taskId: 'tk-2',
    stageId: 'st-1',
    agentId: 'ag-2',
    threadId: 'th-1',
    status: 'succeeded',
    sessionId: 'sess-ag2',
    createdAt: THREAD_AT,
    endedAt: THREAD_AT,
  }),
  // 别的线程：即便同一 agent 也不能串会话（th-3 没有线程行，只为验证按 thread_id 过滤）
  sample.run({
    id: 'run-other-thread',
    taskId: 'tk-1',
    stageId: 'st-1',
    agentId: 'ag-1',
    threadId: 'th-3',
    status: 'succeeded',
    sessionId: 'sess-other-thread',
    createdAt: THREAD_AT_2,
    endedAt: THREAD_AT_2,
  }),
]

/** 种线程读路径的数据：实体五表 + 线程任务 + 线程行 + 线程内 run。 */
function seedThreads(db: DatabaseSync): void {
  seed(db)
  const writer = createProjectionWriter(db)
  const changes: Change[] = [
    // 第二个智能体：验证 sessions 按 agentId 各记各的
    { table: 'agents', key: 'ag-2', row: sample.agent({ id: 'ag-2', name: '审查者' }) },
    { table: 'tasks', key: threadTaskRoot.id, row: threadTaskRoot },
    { table: 'tasks', key: threadTaskChild.id, row: threadTaskChild },
    { table: 'tasks', key: threadTaskDetached.id, row: threadTaskDetached },
    { table: 'threads', key: openThread.id, row: openThread },
    { table: 'threads', key: closedThread.id, row: closedThread },
    ...threadRuns.map((run): Change => ({ table: 'runs', key: run.id, row: run })),
  ]
  for (const change of changes) writer.apply(change, THREAD_AT)
}

describe('loadView / queryView：阶段说明与对话归档（M9）', () => {
  it('阶段 instructions 与对话 archivedAt 经投影列往返（含换行原样保留）', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)

    const staged = sample.stage({
      id: 'st-3',
      workflowId: 'wf-1',
      name: '第三步',
      position: 2,
      instructions: '读需求\n列出改动文件',
    })
    writer.apply({ table: 'workflow_stages', key: staged.id, row: staged }, SAMPLE_AT)
    const workflows = queryView(db, 'workflows.all') as WorkflowWithStages[]
    const workflow = workflows.find((item) => item.id === 'wf-1')
    expect(workflow?.stages.map((item) => item.id)).toEqual(['st-1', 'st-2', 'st-3'])
    expect(workflow?.stages.find((item) => item.id === 'st-3')).toEqual(staged)

    const archived = sample.conversation({ id: 'cv-9', title: '旧对话', archivedAt: SAMPLE_AT })
    writer.apply({ table: 'conversations', key: archived.id, row: archived }, SAMPLE_AT)
    const plain = sample.conversation({ id: 'cv-2', title: '未归档对话' })
    writer.apply({ table: 'conversations', key: plain.id, row: plain }, SAMPLE_AT)
    const list = queryView(db, 'conversations.all') as Conversation[]
    expect(list.find((item) => item.id === 'cv-9')).toEqual(archived)
    // 未归档的老对话按 null 读回（而不是 undefined）
    expect(list.find((item) => item.id === 'cv-2')?.archivedAt).toBeNull()
  })
})

describe('loadView / queryView：线程（M6.5）', () => {
  it('threads 切片：整行映射（JSON 列还原）；未声明时不装载', () => {
    const db = memory()
    seedThreads(db)

    const view = loadView(db, ['threads'])
    expect([...view.threads.keys()]).toEqual(['th-1', 'th-2'])
    expect(view.threads.get('th-1')).toEqual(openThread)
    expect(view.threads.get('th-2')).toEqual(closedThread)
    expect(loadView(db, []).threads.size).toBe(0)
    // 线程切片不影响其它表
    expect(view.tasks.size).toBe(0)
    expect(view.runs.size).toBe(0)
  })

  it('viewSpec：run.claim / event.received 都声明 threads 切片', () => {
    const db = memory()
    seedThreads(db)

    const claimView = loadView(db, viewSpec({ type: 'run.claim', runtimeId: 'rt-1', capacity: 1 }))
    expect(claimView.threads.size).toBe(2)
  })

  it('tasks 切片带 threadId / parentTaskId（task.byId 同口径）', () => {
    const db = memory()
    seedThreads(db)

    const view = loadView(db, ['tasks'])
    expect(view.tasks.get('tk-2')).toEqual(threadTaskChild)
    expect(queryView(db, 'task.byId', { taskId: 'tk-2' })).toEqual(threadTaskChild)
  })

  it('thread.byId：线程不存在返回 null（空库同样）', () => {
    const db = memory()
    seedThreads(db)

    expect(queryView(db, 'thread.byId', { threadId: 'th-missing' })).toBeNull()
    expect(queryView(db, 'thread.byId', { threadId: 'th-1' })).not.toBeNull()
    expect(queryView(memory(), 'thread.byId', { threadId: 'th-1' })).toBeNull()
  })

  it('thread.byId：taskIds 对应的任务按 created_at 排序，未列入的不取（已删任务自然跳过）', () => {
    const db = memory()
    seedThreads(db)

    const detail = queryView(db, 'thread.byId', { threadId: 'th-1' })
    expect(detail).toEqual({
      thread: openThread,
      tasks: [threadTaskRoot, threadTaskChild],
      sessions: { 'ag-1': 'sess-new', 'ag-2': 'sess-ag2' },
    })
  })

  it('thread.byId：sessions 只取线程内终态且带会话的 run，按 ended_at/created_at 取最后一条', () => {
    const db = memory()
    seedThreads(db)

    const detail = queryView(db, 'thread.byId', { threadId: 'th-1' }) as {
      sessions: Record<string, string>
    }
    // ag-1：run-th-new（sess-new）晚于 run-th-old；更晚的 cancelled 没会话、running 非终态都不覆盖
    expect(detail.sessions['ag-1']).toBe('sess-new')
    expect(detail.sessions['ag-1']).not.toBe('sess-running')
    expect(detail.sessions['ag-1']).not.toBe('sess-other-thread')
    expect(detail.sessions['ag-2']).toBe('sess-ag2')
    // th-2 自己没有 run：会话为空对象（不串 th-1 的 run）
    expect(queryView(db, 'thread.byId', { threadId: 'th-2' })).toEqual({
      thread: closedThread,
      tasks: [],
      sessions: {},
    })
  })

  it('thread.byId：缺参数 / 非法参数：StoreError(invalid_input)', () => {
    const db = memory()
    for (const params of [undefined, null, 42, {}, { threadId: '' }, { threadId: 7 }]) {
      const error = captureError(() => queryView(db, 'thread.byId', params))
      expect((error as StoreError).code).toBe('invalid_input')
      expect((error as StoreError).message).toContain('threadId')
    }
  })
})

describe('loadView / queryView：任务上下文 / 反馈（M7.5）', () => {
  const taskA = sample.task({ id: 'tk-a', title: '有反馈', createdAt: '2026-11-01T00:00:00.000Z' })
  const taskB = sample.task({ id: 'tk-b', title: '没反馈', createdAt: '2026-11-02T00:00:00.000Z' })
  const first = {
    id: 'tc-1',
    taskId: 'tk-a',
    author: 'owner' as const,
    text: '先改按钮',
    createdAt: '2026-11-03T01:00:00.000Z',
  }
  const second = {
    id: 'tc-2',
    taskId: 'tk-a',
    author: 'owner' as const,
    text: '再补文案',
    createdAt: '2026-11-03T02:00:00.000Z',
  }
  const other = {
    id: 'tc-3',
    taskId: 'tk-b',
    author: 'agent' as const,
    text: '别的任务的反馈',
    createdAt: '2026-11-03T03:00:00.000Z',
  }

  function seedComments(db: DatabaseSync): void {
    seed(db)
    const writer = createProjectionWriter(db)
    for (const change of [
      { table: 'tasks', key: taskA.id, row: taskA },
      { table: 'tasks', key: taskB.id, row: taskB },
    ] as Change[]) {
      writer.apply(change, SAMPLE_AT)
    }
    for (const row of [second, first, other]) {
      writer.apply({ table: 'task_comments', key: row.id, row }, SAMPLE_AT)
    }
  }

  it('task_comments 切片：整行映射；未声明时不装载', () => {
    const db = memory()
    seedComments(db)

    const view = loadView(db, ['task_comments'])
    expect([...view.taskComments.keys()]).toEqual(['tc-1', 'tc-2', 'tc-3'])
    expect(view.taskComments.get('tc-2')).toEqual(second)
    expect(loadView(db, []).taskComments.size).toBe(0)
    expect(view.tasks.size).toBe(0)
  })

  it('comments.byTask：按 createdAt 升序（同毫秒按 rowid）只取该任务，缺参数报错', () => {
    const db = memory()
    seedComments(db)

    expect(queryView(db, 'comments.byTask', { taskId: 'tk-a' })).toEqual([first, second])
    expect(queryView(db, 'comments.byTask', { taskId: 'tk-b' })).toEqual([other])
    expect(queryView(db, 'comments.byTask', { taskId: 'tk-missing' })).toEqual([])

    for (const params of [undefined, null, 42, {}, { taskId: '' }, { taskId: 7 }]) {
      const error = captureError(() => queryView(db, 'comments.byTask', params))
      expect((error as StoreError).code).toBe('invalid_input')
      expect((error as StoreError).message).toContain('taskId')
    }
  })

  it('viewSpec：task.comment 声明 task_comments 切片', () => {
    const db = memory()
    seedComments(db)

    const view = loadView(
      db,
      viewSpec({ commandId: 'c1', type: 'task.comment', taskId: 'tk-a', text: '改一下' }),
    )
    expect(view.taskComments.size).toBe(3)
    expect(view.tasks.has('tk-a')).toBe(true)
  })
})

describe('项目视图（M10）', () => {
  const seedProjects = (db: DatabaseSync): void => {
    const writer = createProjectionWriter(db)
    const workflow = sample.workflow({ id: 'wf-1' })
    writer.apply({ table: 'workflows', key: workflow.id, row: workflow }, SAMPLE_AT)
    const stage = sample.stage({ id: 'st-1', workflowId: workflow.id })
    writer.apply({ table: 'workflow_stages', key: stage.id, row: stage }, SAMPLE_AT)
    const older = sample.project({
      id: 'pj-2',
      name: '较早项目',
      path: 'D:/older',
      createdAt: OLDER_AT,
      updatedAt: OLDER_AT,
    })
    const newer = sample.project({ id: 'pj-1', name: '较新项目', path: 'D:/newer' })
    writer.apply({ table: 'projects', key: older.id, row: older }, SAMPLE_AT)
    writer.apply({ table: 'projects', key: newer.id, row: newer }, SAMPLE_AT)
    writer.apply(
      {
        table: 'tasks',
        key: 'tk-a',
        row: sample.task({ id: 'tk-a', title: '有项目', projectId: 'pj-1', createdAt: OLDER_AT }),
      },
      SAMPLE_AT,
    )
    writer.apply(
      {
        table: 'tasks',
        key: 'tk-b',
        row: sample.task({ id: 'tk-b', title: '未归属', projectId: null }),
      },
      SAMPLE_AT,
    )
  }

  it('projects.all：按创建时间升序返回整行', () => {
    const db = memory()
    seedProjects(db)

    expect(queryView(db, 'projects.all')).toEqual([
      sample.project({
        id: 'pj-2',
        name: '较早项目',
        path: 'D:/older',
        createdAt: OLDER_AT,
        updatedAt: OLDER_AT,
      }),
      sample.project({ id: 'pj-1', name: '较新项目', path: 'D:/newer' }),
    ])
  })

  it('tasks.byProject / tasks.unassigned：按项目过滤，未归属单列', () => {
    const db = memory()
    seedProjects(db)

    expect(queryView(db, 'tasks.byProject', { projectId: 'pj-1' })).toEqual([
      sample.task({ id: 'tk-a', title: '有项目', projectId: 'pj-1', createdAt: OLDER_AT }),
    ])
    expect(queryView(db, 'tasks.byProject', { projectId: 'pj-missing' })).toEqual([])
    expect(queryView(db, 'tasks.unassigned')).toEqual([
      sample.task({ id: 'tk-b', title: '未归属', projectId: null }),
    ])
    const error = captureError(() => queryView(db, 'tasks.byProject', {}))
    expect((error as StoreError).code).toBe('invalid_input')
  })

  it('loadView：声明 projects 切片才装载，行映射为 Project', () => {
    const db = memory()
    seedProjects(db)

    const view = loadView(db, ['projects'])
    expect([...view.projects.keys()]).toEqual(['pj-2', 'pj-1'])
    expect(view.projects.get('pj-1')?.path).toBe('D:/newer')
    expect(loadView(db, []).projects.size).toBe(0)
  })
})

describe('会话视图（M11：聊天归属项目）', () => {
  const conversationAt = (id: string, projectId: string | null, updatedAt: string): Conversation =>
    sample.conversation({
      id,
      title: id,
      projectId,
      createdAt: updatedAt,
      updatedAt,
    })

  const seedConversations = (db: DatabaseSync): void => {
    seed(db)
    const writer = createProjectionWriter(db)
    for (const row of [
      conversationAt('cv-a', 'pj-1', OLDER_AT),
      conversationAt('cv-b', 'pj-2', SAMPLE_AT),
      conversationAt('cv-c', null, SAMPLE_AT),
    ]) {
      writer.apply({ table: 'conversations', key: row.id, row }, SAMPLE_AT)
    }
  }

  it('conversations.all 仍按最近更新排序，行上带 projectId（NULL → null）', () => {
    const db = memory()
    seedConversations(db)

    expect((queryView(db, 'conversations.all') as Conversation[]).map((row) => row.id)).toEqual([
      'cv-b',
      'cv-c',
      'cv-a',
    ])
    const all = queryView(db, 'conversations.all') as Conversation[]
    expect(all.find((row) => row.id === 'cv-a')?.projectId).toBe('pj-1')
    expect(all.find((row) => row.id === 'cv-c')?.projectId).toBeNull()
  })

  it('conversations.byProject：只取该项目的会话；未归属单列；缺参数报错', () => {
    const db = memory()
    seedConversations(db)

    expect(queryView(db, 'conversations.byProject', { projectId: 'pj-1' })).toEqual([
      conversationAt('cv-a', 'pj-1', OLDER_AT),
    ])
    expect(queryView(db, 'conversations.byProject', { projectId: 'pj-2' })).toEqual([
      conversationAt('cv-b', 'pj-2', SAMPLE_AT),
    ])
    expect(queryView(db, 'conversations.byProject', { projectId: 'pj-missing' })).toEqual([])
    expect(queryView(db, 'conversations.unassigned')).toEqual([
      conversationAt('cv-c', null, SAMPLE_AT),
    ])

    for (const params of [undefined, null, 42, {}, { projectId: '' }, { projectId: 7 }]) {
      const error = captureError(() => queryView(db, 'conversations.byProject', params))
      expect((error as StoreError).code).toBe('invalid_input')
      expect((error as StoreError).message).toContain('projectId')
    }
  })

  it('loadView：conversations 切片映射 projectId；chat.send 的切片包含 projects', () => {
    const db = memory()
    seedConversations(db)

    const view = loadView(
      db,
      viewSpec({ commandId: 'c1', type: 'chat.send', conversationId: 'cv-a', content: '你好' }),
    )
    expect(view.conversations.get('cv-a')?.projectId).toBe('pj-1')
    expect(view.conversations.get('cv-c')?.projectId).toBeNull()
    expect(view.projects.size).toBe(0)
  })
})

describe('queryView：闸门缺省去向', () => {
  it('workflows.all：闸门只配了次数、没配去向时读回来是 null（缺省 = 按默认下一阶段）', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    const gateStage = sample.stage({
      id: 'st-gate-default',
      workflowId: 'wf-1',
      name: '默认判定',
      position: 2,
      entryMode: 'agent',
      agentId: agent.id,
      gate: { maxFails: 2, onPassStageId: null, onFailStageId: null },
    })
    writer.apply({ table: 'workflow_stages', key: gateStage.id, row: gateStage }, SAMPLE_AT)

    const stages = (queryView(db, 'workflows.all') as WorkflowWithStages[]).find(
      (item) => item.id === 'wf-1',
    )?.stages
    expect(stages?.find((item) => item.id === 'st-gate-default')?.gate).toEqual({
      maxFails: 2,
      onPassStageId: null,
      onFailStageId: null,
    })
  })
})
describe('queryView：reviews.byTask（M14）', () => {
  it('按任务过滤、按 rev 升序返回整行（含 JSON 列还原）；别的任务不混进来', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    const task = sample.task()
    writer.apply({ table: 'tasks', key: task.id, row: task }, SAMPLE_AT)
    const otherTask = sample.task({ id: 'tk-other' })
    writer.apply({ table: 'tasks', key: otherTask.id, row: otherTask }, SAMPLE_AT)
    const base = {
      taskId: task.id,
      stageId: 'st-1',
      runId: 'run-1',
      threadId: null,
      verdict: 'fail' as const,
      checks: [],
      findings: [],
      artifact: null,
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
    }
    writer.apply(
      { table: 'review_reports', key: 'run-2:2', row: { ...base, id: 'run-2:2', rev: 2 } },
      SAMPLE_AT,
    )
    writer.apply(
      { table: 'review_reports', key: 'run-1:1', row: { ...base, id: 'run-1:1', rev: 1 } },
      SAMPLE_AT,
    )
    writer.apply(
      {
        table: 'review_reports',
        key: 'other:1',
        row: { ...base, id: 'other:1', rev: 1, taskId: 'tk-other' },
      },
      SAMPLE_AT,
    )
    expect(
      (queryView(db, 'reviews.byTask', { taskId: task.id }) as Array<{ id: string }>).map(
        (row) => row.id,
      ),
    ).toEqual(['run-1:1', 'run-2:2'])
    expect(queryView(db, 'reviews.byTask', { taskId: 'tk-none' })).toEqual([])
  })

  it('同一 rev 的两份报告（不同 run）：按 id 升序稳定排序', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    const task = sample.task({ id: 'tk-same-rev' })
    writer.apply({ table: 'tasks', key: task.id, row: task }, SAMPLE_AT)
    const base = {
      taskId: task.id,
      stageId: 'st-1',
      threadId: null,
      verdict: 'pass' as const,
      checks: [],
      findings: [],
      artifact: null,
      rev: 1,
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
    }
    // 倒序写入：rev 相同，排序只能靠 id
    writer.apply(
      { table: 'review_reports', key: 'run-z:1', row: { ...base, id: 'run-z:1', runId: 'run-z' } },
      SAMPLE_AT,
    )
    writer.apply(
      { table: 'review_reports', key: 'run-a:1', row: { ...base, id: 'run-a:1', runId: 'run-a' } },
      SAMPLE_AT,
    )
    expect(
      (queryView(db, 'reviews.byTask', { taskId: task.id }) as Array<{ id: string }>).map(
        (row) => row.id,
      ),
    ).toEqual(['run-a:1', 'run-z:1'])
  })
})

describe('queryView：workflow.stage-metrics（M23）', () => {
  it('按阶段 position 汇总 run 数 / 平均轮数 / 降级 / ask / 人评；没有数据的阶段给 0', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    const stageB = sample.stage({ id: 'st-2', name: '第二步', position: 1 })
    writer.apply({ table: 'workflow_stages', key: stageB.id, row: stageB }, SAMPLE_AT)

    const done = sample.task({ id: 'tk-1', currentStageId: 'st-1' })
    writer.apply({ table: 'tasks', key: done.id, row: done }, SAMPLE_AT)
    // 同一任务在同一阶段跑了两轮：avgRounds 应为 2
    for (const id of ['run-1', 'run-2']) {
      writer.apply(
        { table: 'runs', key: id, row: sample.run({ id, taskId: 'tk-1', stageId: 'st-1' }) },
        SAMPLE_AT,
      )
    }
    writer.apply(
      {
        table: 'runs',
        key: 'run-3',
        row: sample.run({ id: 'run-3', taskId: 'tk-1', stageId: 'st-2' }),
      },
      SAMPLE_AT,
    )
    // 降级标记 + 人评留在 st-1 的任务上
    writer.apply(
      {
        table: 'tasks',
        key: 'tk-degraded',
        row: sample.task({ id: 'tk-degraded', currentStageId: 'st-1', labels: ['gate:degraded'] }),
      },
      SAMPLE_AT,
    )
    writer.apply(
      {
        table: 'task_comments',
        key: 'tc-1',
        row: {
          id: 'tc-1',
          taskId: 'tk-1',
          author: 'owner',
          text: '这里再稳一点',
          createdAt: SAMPLE_AT,
        },
      },
      SAMPLE_AT,
    )
    writer.apply(
      {
        table: 'cards',
        key: 'card-1',
        row: sample.card({ id: 'card-1', runId: 'run-1', taskId: 'tk-1', kind: 'ask' }),
      },
      SAMPLE_AT,
    )

    const metrics = queryView(db, 'workflow.stage-metrics', { workflowId: 'wf-1' }) as {
      workflowId: string
      stages: Array<{
        stageId: string
        stageName: string
        runs: number
        avgRounds: number
        degraded: number
        asks: number
        humanComments: number
        repairExhausted: number
      }>
    }
    expect(metrics.workflowId).toBe('wf-1')
    const first = metrics.stages.find((stage) => stage.stageId === 'st-1')
    expect(first).toMatchObject({
      stageName: '第一步',
      runs: 2,
      avgRounds: 2,
      degraded: 1,
      asks: 1,
      humanComments: 1,
      repairExhausted: 0,
    })
    const second = metrics.stages.find((stage) => stage.stageId === 'st-2')
    expect(second).toMatchObject({ runs: 1, avgRounds: 1, degraded: 0, asks: 0 })
    // 按 position 排：st-1 在 st-2 之前
    expect(metrics.stages.map((stage) => stage.stageId)).toEqual(['st-1', 'st-2'])

    expect(queryView(db, 'workflow.stage-metrics', { workflowId: 'wf-missing' })).toEqual({
      workflowId: 'wf-missing',
      stages: [],
    })
    const error = captureError(() => queryView(db, 'workflow.stage-metrics', {}))
    expect((error as StoreError).code).toBe('invalid_input')
  })

  it('有阶段但一轮都没跑：run 数与平均轮数都给 0（不是空对象）', () => {
    const db = memory()
    seed(db)
    const writer = createProjectionWriter(db)
    writer.apply(
      {
        table: 'workflow_stages',
        key: 'st-idle',
        row: sample.stage({ id: 'st-idle', name: '闲置阶段', position: 3 }),
      },
      SAMPLE_AT,
    )
    const metrics = queryView(db, 'workflow.stage-metrics', { workflowId: 'wf-1' }) as {
      stages: Array<Record<string, unknown>>
    }
    expect(metrics.stages.find((stage) => stage.stageId === 'st-idle')).toMatchObject({
      stageName: '闲置阶段',
      runs: 0,
      avgRounds: 0,
      repairExhausted: 0,
      degraded: 0,
      asks: 0,
      humanComments: 0,
    })
  })
})

describe('queryView：阶段验收列的空串归一（M20 老行）', () => {
  it('acceptance_json 是空串（M20 补列前的老行）：按「未声明」归成空数组', () => {
    const db = memory()
    seed(db)
    // 直写一行老数据：补列后默认值是 '[]'，但手工迁移 / 老快照可能留下空串
    db.prepare(
      `INSERT INTO workflow_stages (id, workflow_id, name, position, entry_mode, acceptance_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('st-legacy', 'wf-1', '老阶段', 9, 'none', '', SAMPLE_AT)

    const stages = (queryView(db, 'workflows.all') as WorkflowWithStages[]).find(
      (item) => item.id === 'wf-1',
    )?.stages
    expect(stages?.find((item) => item.id === 'st-legacy')?.acceptance).toEqual([])
  })
})
