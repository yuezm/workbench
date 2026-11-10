// @vitest-environment node
/**
 * `cards` 投影专项（M4 T5）：真实 SQLite 临时库 + 真实内核上的写路径与重建等价。
 *
 * 覆盖：
 * 1. 回执 `ask` → 建卡 / `run.waiting` → `card.answer` → 续接：实时投影与 `rebuild()` 逐表全等；
 * 2. 卡片全生命周期事实（opened / updated / delivered / delivery_failed / answered / resolved）；
 * 3. `cards.open` / `cards.byRun` 的状态过滤与 createdAt 排序；
 * 4. `run.removed` 联删卡片（重建事务关外键时不能只靠 `ON DELETE CASCADE`）。
 *
 * 全部用 `openDatabase` 打开的真实 SQLite 文件库（不是内存库、不是假 project），
 * 内核也是真实的 `decide` / `project` / `viewSpec`——验证的是「事实 → 投影 → 重建」真实链路。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import type { FactDraft, Iso, KernelPort } from '../../src/kernel/types'
import { viewSpec } from '../../src/kernel/view-spec'
import type { Card } from '../../src/protocol/entities'
import type { Receipt } from '../../src/protocol/inputs'
import { openDatabase } from '../../src/host/db'
import { withTx } from '../../src/host/schema'
import { appendFacts, lastSeq } from '../../src/host/store/facts'
import { createStore, type Store } from '../../src/host/store/index'
import { createProjectionWriter } from '../../src/host/store/projection-apply'
import { currentProjectionFormat, writeProjectionMeta } from '../../src/host/store/projection'
import { dumpProjection, sample } from './store/test-support'

const AT = '2026-04-01T00:00:00.000Z'
const AT_2 = '2026-04-01T00:01:00.000Z'
const AT_3 = '2026-04-01T00:02:00.000Z'
const AT_4 = '2026-04-01T00:03:00.000Z'
const AT_5 = '2026-04-01T00:04:00.000Z'
const AT_6 = '2026-04-01T00:05:00.000Z'

const HOST = { kind: 'host', via: 'scheduler' } as const
const OWNER = { kind: 'owner', via: 'ui' } as const

const kernel: KernelPort = { decide, project, viewSpec }

let openDbs: DatabaseSync[] = []
let roots: string[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

interface World {
  db: DatabaseSync
  store: Store
}

/** 每个用例一个真实 SQLite 临时文件库（走 `openDatabase` 的完整建库/升级路径）。 */
function world(options: { now?: () => Iso } = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwf-cards-'))
  roots.push(root)
  const db = openDatabase(path.join(root, 'ai-workflow.db'))
  openDbs.push(db)
  const store = createStore({ db, kernel, ...(options.now ? { now: options.now } : {}) })
  store.ensureProjection()
  return { db, store }
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`缺少${label}`)
  return value
}

interface ClaimedRun {
  runId: string
  taskId: string
  runtimeId: string
  leaseId: string
  turn: number
}

/** 建运行时 / 智能体 / agent 单阶段工作流 / 任务，并领取它的 run（running + 租约）。 */
function seedClaimedRun(store: Store, label: string): ClaimedRun {
  store.dispatch({
    type: 'runtime.create',
    commandId: `s-rt-${label}`,
    input: { name: `运行时 ${label}`, executorKey: 'dsh', command: 'dsh' },
  })
  const runtime = must(
    store.query('runtimes.all').find((item) => item.name === `运行时 ${label}`),
    `运行时 ${label}`,
  )
  store.dispatch({
    type: 'agent.create',
    commandId: `s-ag-${label}`,
    input: { name: `智能体 ${label}`, runtimeId: runtime.id },
  })
  const agent = must(
    store.query('agents.all').find((item) => item.name === `智能体 ${label}`),
    `智能体 ${label}`,
  )
  store.dispatch({
    type: 'workflow.create',
    commandId: `s-wf-${label}`,
    input: {
      name: `流程 ${label}`,
      stages: [{ name: '执行', entryMode: 'agent', agentId: agent.id }],
    },
  })
  const workflow = must(
    store.query('workflows.all').find((item) => item.name === `流程 ${label}`),
    `流程 ${label}`,
  )
  // M10：任务必须挂在项目下
  store.dispatch({
    type: 'project.create',
    commandId: `s-pj-${label}`,
    input: { name: `项目 ${label}`, path: `D:/work/${label}` },
  })
  const project = must(
    store.query('projects.all').find((item) => item.name === `项目 ${label}`),
    `项目 ${label}`,
  )
  // M18：新任务默认落内置「待办」（不派活）；要起 run 必须显式落到自己添加的阶段
  const stageId = must(
    workflow.stages.find((stage) => (stage.builtin ?? null) === null),
    `流程 ${label} 的 agent 阶段`,
  ).id
  store.dispatch({
    type: 'task.create',
    commandId: `s-tk-${label}`,
    input: {
      title: `任务 ${label}`,
      workflowId: workflow.id,
      projectId: project.id,
      stageId,
    },
  })
  const task = must(
    store
      .query('tasks.byWorkflow', { workflowId: workflow.id })
      .find((item) => item.title === `任务 ${label}`),
    `任务 ${label}`,
  )
  const run = must(store.query('runs.byTask', { taskId: task.id })[0], `任务 ${label} 的 run`)
  store.dispatch({ type: 'run.claim', runtimeId: runtime.id, capacity: 1 })
  const claimed = must(store.query('run.byId', { runId: run.id }), `领取后的 run ${label}`)
  return {
    runId: claimed.id,
    taskId: task.id,
    runtimeId: runtime.id,
    leaseId: must(claimed.leaseId, `run ${label} 的租约`),
    turn: claimed.turn,
  }
}

/** 回执壳：ask 之外的字段按「本轮成功返回但需要拍板」的形态给。 */
const askReceipt = (
  run: ClaimedRun,
  ask: Array<{ title: string; text?: string; options: string[]; key?: string }>,
  sessionId?: string,
): Receipt => ({
  status: 'succeeded',
  leaseId: run.leaseId,
  turn: run.turn,
  output: '需要拍板',
  ...(sessionId === undefined ? {} : { sessionId }),
  ask,
})

/** 直接追加事实并增量应用投影（模拟通道回写投递状态等「非 dispatch 入口」的事实）。 */
function commitFacts(db: DatabaseSync, drafts: readonly FactDraft[]): void {
  withTx(db, () => {
    const facts = appendFacts(db, drafts)
    const writer = createProjectionWriter(db)
    const writes = facts.flatMap((fact) => project(fact).map((change) => ({ change, at: fact.at })))
    writer.applyAll(writes)
    writeProjectionMeta(db, currentProjectionFormat(), lastSeq(db))
  })
}

describe('cards 投影：实时写入与重建等价（真实 SQLite 临时库 + 真实内核）', () => {
  it('回执 ask → open 卡 → 回答 → 续接：实时投影与 rebuild 逐行全等', () => {
    let now = AT
    const { db, store } = world({ now: () => now })
    const run = seedClaimedRun(store, 'A')

    store.dispatch({
      type: 'run.receipt',
      runId: run.runId,
      receipt: askReceipt(
        run,
        [{ key: 'approve', title: '要不要继续', text: '选一个', options: ['继续', '停止'] }],
        'sess-a',
      ),
    })

    const waiting = store.query('run.byId', { runId: run.runId })
    expect(waiting).toMatchObject({ status: 'waiting', sessionId: 'sess-a' })
    const opened = store.query('cards.open')
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      runId: run.runId,
      taskId: run.taskId,
      title: '要不要继续',
      text: '选一个',
      options: ['继续', '停止'],
      key: 'approve',
      version: 1,
      status: 'open',
      delivery: 'pending',
      createdAt: AT,
      updatedAt: AT,
    })

    now = AT_2
    store.dispatch({
      type: 'card.answer',
      commandId: 'answer-a',
      cardId: must(opened[0], 'open 卡').id,
      optionIndex: 1,
    })

    expect(store.query('cards.open')).toEqual([])
    expect(store.query('cards.byRun', { runId: run.runId })).toEqual([
      expect.objectContaining({
        status: 'answered',
        optionIndex: 1,
        answeredBy: 'ui',
        answeredAt: AT_2,
        updatedAt: AT_2,
      }),
    ])
    expect(store.query('run.byId', { runId: run.runId })).toMatchObject({
      status: 'queued',
      turn: run.turn + 1,
      resumeSessionId: 'sess-a',
      notBefore: null,
      leaseId: null,
    })

    const incremental = dumpProjection(db)
    expect(incremental.cards).toHaveLength(1)
    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
    expect(store.query('cards.byRun', { runId: run.runId })[0]?.status).toBe('answered')
  })

  it('同一回执同 key 的两条 ask：合并成一张卡并升 version，重建后一致', () => {
    const now = AT
    const { db, store } = world({ now: () => now })
    const run = seedClaimedRun(store, 'F')

    store.dispatch({
      type: 'run.receipt',
      runId: run.runId,
      receipt: askReceipt(
        run,
        [
          { key: 'approve', title: '第一版', options: ['甲', '乙'] },
          { key: 'approve', title: '第二版（合并）', options: ['甲', '乙', '丙'] },
        ],
        'sess-f',
      ),
    })

    const cards = store.query('cards.byRun', { runId: run.runId })
    expect(cards.map((card) => [card.status, card.version, card.title])).toEqual([
      ['open', 2, '第二版（合并）'],
    ])
    expect(cards[0]).toMatchObject({ delivery: 'pending', options: ['甲', '乙', '丙'] })

    const incremental = dumpProjection(db)
    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
  })

  it('卡片全生命周期事实：增量 fold 与 rebuild 逐行全等', () => {
    const { db, store } = world({ now: () => AT })
    const run = seedClaimedRun(store, 'B')

    const opened: Card = sample.card({
      id: 'card-life',
      runId: run.runId,
      taskId: run.taskId,
      conversationId: null,
      title: '生命周期',
      options: ['甲', '乙'],
      createdAt: AT,
      updatedAt: AT,
    })
    const delivered: Card = {
      ...opened,
      delivery: 'delivered',
      deliveryRef: 'in-app',
      updatedAt: AT_2,
    }
    const updated: Card = {
      ...delivered,
      title: '生命周期（改）',
      version: 2,
      delivery: 'pending',
      deliveryRef: null,
      updatedAt: AT_3,
    }
    const failed: Card = { ...updated, delivery: 'failed', updatedAt: AT_4 }
    const answered: Card = {
      ...failed,
      status: 'answered',
      optionIndex: 0,
      answeredBy: 'channel',
      answeredAt: AT_5,
      updatedAt: AT_5,
    }
    const resolved: Card = { ...answered, status: 'resolved', updatedAt: AT_6 }

    commitFacts(db, [
      { type: 'card.opened', actor: HOST, at: AT, payload: { card: opened } },
      {
        type: 'card.delivered',
        actor: HOST,
        at: AT_2,
        payload: { card: delivered, ref: 'in-app' },
      },
      {
        type: 'card.updated',
        actor: HOST,
        at: AT_3,
        payload: { card: updated, changes: ['title', 'version', 'delivery'] },
      },
      {
        type: 'card.delivery_failed',
        actor: HOST,
        at: AT_4,
        payload: { card: failed, error: '通道暂不可用' },
      },
      {
        type: 'card.answered',
        actor: { kind: 'owner', via: 'channel' },
        at: AT_5,
        payload: { card: answered, by: 'channel' },
      },
      {
        type: 'card.resolved',
        actor: OWNER,
        at: AT_6,
        payload: { card: resolved, reason: 'manual' },
      },
    ])

    const incremental = dumpProjection(db)
    expect(incremental.cards).toEqual([
      {
        id: 'card-life',
        run_id: run.runId,
        task_id: run.taskId,
        conversation_id: null,
        title: '生命周期（改）',
        text: opened.text,
        options_json: JSON.stringify(['甲', '乙']),
        key: null,
        version: 2,
        status: 'resolved',
        delivery: 'failed',
        delivery_ref: null,
        option_index: 0,
        answered_by: 'channel',
        answered_at: AT_5,
        created_at: AT,
        updated_at: AT_6,
      },
    ])

    store.rebuild()
    expect(dumpProjection(db)).toEqual(incremental)
  })
})

describe('cards 读路径：cards.open / cards.byRun 的过滤与排序', () => {
  it('cards.open 只含 open 且按 createdAt 升序；cards.byRun 按 run 过滤（含历史）', () => {
    let now = AT
    const { store } = world({ now: () => now })
    const first = seedClaimedRun(store, 'C')
    store.dispatch({
      type: 'run.receipt',
      runId: first.runId,
      receipt: askReceipt(first, [
        { title: '甲卡', options: ['1', '2'] },
        { key: 'second', title: '乙卡', options: ['1', '2'] },
      ]),
    })
    const firstRunCards = store.query('cards.byRun', { runId: first.runId })
    expect(firstRunCards.map((card) => card.title)).toEqual(['甲卡', '乙卡'])

    now = AT_2
    const second = seedClaimedRun(store, 'D')
    store.dispatch({
      type: 'run.receipt',
      runId: second.runId,
      receipt: askReceipt(second, [{ title: '丙卡', options: ['1'] }]),
    })

    // 跨 run 按 createdAt：甲 / 乙（同一时刻按写入顺序）→ 丙
    expect(store.query('cards.open').map((card) => card.title)).toEqual(['甲卡', '乙卡', '丙卡'])

    // 答掉甲卡：该 run 还有乙卡未答 → 仍 waiting；open 列表少一张
    store.dispatch({
      type: 'card.answer',
      commandId: 'answer-c1',
      cardId: must(firstRunCards[0], '甲卡').id,
      optionIndex: 0,
    })
    expect(store.query('cards.open').map((card) => card.title)).toEqual(['乙卡', '丙卡'])
    expect(store.query('run.byId', { runId: first.runId })?.status).toBe('waiting')
    expect(
      store.query('cards.byRun', { runId: first.runId }).map((card) => [card.title, card.status]),
    ).toEqual([
      ['甲卡', 'answered'],
      ['乙卡', 'open'],
    ])

    // 关闭乙卡：只改卡片状态，run 状态不动
    store.dispatch({
      type: 'card.resolve',
      commandId: 'resolve-c2',
      cardId: must(firstRunCards[1], '乙卡').id,
    })
    expect(store.query('cards.open').map((card) => card.title)).toEqual(['丙卡'])
    expect(store.query('cards.byRun', { runId: first.runId })[1]?.status).toBe('resolved')
  })
})

describe('run.removed：卡片随 run 显式联删（重建不被外键差异影响）', () => {
  it('删除任务：run.removed 删 run 与卡片，rebuild 后不复活', () => {
    const { db, store } = world({ now: () => AT })
    const run = seedClaimedRun(store, 'E')
    store.dispatch({
      type: 'run.receipt',
      runId: run.runId,
      receipt: askReceipt(
        run,
        [{ key: 'confirm', title: '确认', options: ['是', '否'] }],
        'sess-e',
      ),
    })
    expect(dumpProjection(db).cards).toHaveLength(1)
    expect(dumpProjection(db).runs).toHaveLength(1)

    store.dispatch({ type: 'task.remove', commandId: 'remove-e', id: run.taskId })

    expect(store.factsSince(0).map((fact) => fact.type)).toContain('run.removed')
    // 增量：外键开着时 SQL 级联也会删卡片，但这里显式删，保证与重建同口径
    expect(dumpProjection(db).cards).toEqual([])
    expect(dumpProjection(db).runs).toEqual([])

    const afterRemove = dumpProjection(db)
    store.rebuild()
    expect(dumpProjection(db)).toEqual(afterRemove)
    expect(dumpProjection(db).cards).toEqual([])
    expect(store.query('cards.byRun', { runId: run.runId })).toEqual([])
  })
})
