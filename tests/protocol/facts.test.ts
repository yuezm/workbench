import { describe, expect, it } from 'vitest'
import type {
  Card,
  Conversation,
  Message,
  RunRow,
  Runtime,
  Task,
} from '../../src/protocol/entities'
import {
  FACT_TYPES,
  type CardAnsweredPayload,
  type CardOpenedPayload,
  type CardUpdatedPayload,
  type EventDroppedPayload,
  type EventReceivedPayload,
  type FactPayloads,
  type FactType,
  type SnapshotImportedPayload,
  type TaskMovedPayload,
  type RunFramesPayload,
  type RunSettledPayload,
  type MessageAppendedPayload,
  type FactPayload,
} from '../../src/protocol/facts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/** payload 映射的键必须恰好覆盖 FACT_TYPES。 */
const payloadKeysCover: Assert<Equal<keyof FactPayloads, FactType>> = true
/** 泛型取出的 payload 类型与具名类型一致。 */
const payloadIndexing: Assert<Equal<FactPayload<'task.moved'>, TaskMovedPayload>> = true
/** M10：任务行整行更新（动归属不动阶段），与 `conversation.updated` 同一口径。 */
const taskUpdatedPayload: Assert<Equal<FactPayload<'task.updated'>, { task: Task }>> = true
/** runtime 事实一律携带完整行（含 lastProbe），`project` 不做特判。 */
const runtimePayloads: [
  Assert<Equal<FactPayload<'runtime.created'>, { runtime: Runtime }>>,
  Assert<Equal<FactPayload<'runtime.updated'>, { runtime: Runtime }>>,
  Assert<Equal<FactPayload<'runtime.removed'>, { runtime: Runtime }>>,
  Assert<Equal<FactPayload<'runtime.probed'>, { runtime: Runtime }>>,
] = [true, true, true, true]

/** 终态三兄弟共用一个 payload：投影归一逻辑因此只有一份。 */
const settledPayloads: [
  Assert<Equal<FactPayload<'run.succeeded'>, RunSettledPayload>>,
  Assert<Equal<FactPayload<'run.failed'>, RunSettledPayload>>,
  Assert<Equal<FactPayload<'run.cancelled'>, RunSettledPayload>>,
] = [true, true, true]

/** 帧批量事实与消息事实的 payload 形状（D6 / D8）。 */
const runChatPayloads: [
  Assert<Equal<FactPayload<'run.frames'>, RunFramesPayload>>,
  Assert<Equal<FactPayload<'message.appended'>, MessageAppendedPayload>>,
] = [true, true]

/** M4：每条 `card.*` 事实都携带完整 `Card` 行（整行口径，project 只做搬运）。 */
const cardPayloads: [
  Assert<Equal<FactPayload<'card.opened'>, CardOpenedPayload>>,
  Assert<Equal<FactPayload<'card.updated'>, CardUpdatedPayload>>,
  Assert<Equal<FactPayload<'card.delivered'>, { card: Card; ref: string }>>,
  Assert<Equal<FactPayload<'card.delivery_failed'>, { card: Card; error: string }>>,
  Assert<Equal<FactPayload<'card.answered'>, CardAnsweredPayload>>,
  Assert<
    Equal<FactPayload<'card.resolved'>, { card: Card; reason: 'agent' | 'manual' | 'cancelled' }>
  >,
] = [true, true, true, true, true, true]

/** 派生事件只入账、无投影（D8）。 */
const eventPayloads: [
  Assert<Equal<FactPayload<'event.received'>, EventReceivedPayload>>,
  Assert<Equal<FactPayload<'event.dropped'>, EventDroppedPayload>>,
] = [true, true]

const expected = [
  'workflow.created',
  'workflow.updated',
  'workflow.removed',
  'stage.created',
  'stage.updated',
  'stage.deleted',
  'agent.created',
  'agent.updated',
  'agent.removed',
  'runtime.created',
  'runtime.updated',
  'runtime.removed',
  'runtime.probed',
  'project.created',
  'project.updated',
  'project.removed',
  'task.created',
  'task.updated',
  'task.moved',
  'task.completed',
  'task.removed',
  'task.comment_added',
  'task.children_settled',
  'run.queued',
  'run.claimed',
  'run.lease_extended',
  'run.waiting',
  'run.frames',
  'run.abandoned',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.usage',
  'run.cancel_requested',
  'run.receipt_rejected',
  'run.removed',
  'card.opened',
  'card.updated',
  'card.delivered',
  'card.delivery_failed',
  'card.answered',
  'card.resolved',
  'event.received',
  'event.dropped',
  'event.merged',
  'thread.opened',
  'thread.event_attached',
  'thread.task_attached',
  'thread.note_appended',
  'thread.closed',
  'thread.reopened',
  'thread.bound',
  'thread.removed',
  'rules.replaced',
  'rule.fired',
  'plugins.replaced',
  'review.reported',
  'review.addressed',
  'conversation.created',
  'conversation.updated',
  'conversation.removed',
  'message.appended',
  'snapshot.imported',
]

describe('protocol/facts', () => {
  it('FACT_TYPES 覆盖 M1 + M2 + M4 + M7 事实目录且顺序稳定', () => {
    expect([...FACT_TYPES]).toEqual(expected)
  })

  it('事实名唯一，均为小写点分，且只属于已登记的前缀', () => {
    expect(new Set(FACT_TYPES).size).toBe(FACT_TYPES.length)
    const prefixes = new Set([
      'workflow',
      'stage',
      'agent',
      'runtime',
      'project',
      'task',
      'run',
      'card',
      'event',
      'thread',
      'rules',
      'rule',
      'plugins',
      'review',
      'conversation',
      'message',
      'snapshot',
    ])
    for (const type of FACT_TYPES) {
      expect(type).toMatch(/^[a-z]+\.[a-z_]+$/)
      expect(prefixes.has(type.split('.')[0])).toBe(true)
    }
  })

  it('事实名到 payload 的映射完整（类型级断言）', () => {
    expect(payloadKeysCover).toBe(true)
    expect(payloadIndexing).toBe(true)
    expect(taskUpdatedPayload).toBe(true)
    expect(runtimePayloads).toEqual([true, true, true, true])
    expect(settledPayloads).toEqual([true, true, true])
    expect(runChatPayloads).toEqual([true, true])
    expect(cardPayloads).toEqual([true, true, true, true, true, true])
    expect(eventPayloads).toEqual([true, true])
  })

  it('snapshot.imported 用 table 判别行类型，实体五表 + 运行/对话四表都能导入', () => {
    const payloads: SnapshotImportedPayload[] = [
      { table: 'tasks', rows: [], importedFrom: 'v2' },
      { table: 'workflows', rows: [], importedFrom: 'v2' },
      { table: 'workflow_stages', rows: [], importedFrom: 'v2' },
      { table: 'agents', rows: [], importedFrom: 'v2' },
      { table: 'runtimes', rows: [], importedFrom: 'v2' },
      { table: 'runs', rows: [] as RunRow[], importedFrom: 'v2' },
      { table: 'run_events', rows: [], importedFrom: 'v2' },
      { table: 'conversations', rows: [] as Conversation[], importedFrom: 'v2' },
      { table: 'messages', rows: [] as Message[], importedFrom: 'v2' },
    ]

    expect(payloads.map((payload) => payload.table)).toEqual([
      'tasks',
      'workflows',
      'workflow_stages',
      'agents',
      'runtimes',
      'runs',
      'run_events',
      'conversations',
      'messages',
    ])
    for (const payload of payloads) {
      expect(payload.rows).toEqual([])
      expect(payload.importedFrom).toBe('v2')
    }
  })

  it('run.frames 的帧是带 runId 的投影行，run.removed 只带 runId', () => {
    const frames: RunFramesPayload = {
      runId: 'run-1',
      turn: 1,
      frames: [{ runId: 'run-1', seq: 1, type: 'text', text: 'hi' }],
    }
    expect(frames.frames.map((frame) => [frame.runId, frame.seq, frame.type])).toEqual([
      ['run-1', 1, 'text'],
    ])
    expect(FACT_TYPES).toContain('run.removed')
  })

  it('message.appended 带 conversationId / messageId / role / content，runId 与 error 可选', () => {
    const payload: MessageAppendedPayload = {
      conversationId: 'cv-1',
      messageId: 'm-1',
      role: 'assistant',
      content: '答',
    }
    expect(payload.runId).toBeUndefined()
    expect(payload.error).toBeUndefined()
    expect({ ...payload, runId: 'run-1', error: null }.runId).toBe('run-1')
  })

  it('card.payload 是完整 Card 行；审计字段与行内状态一致', () => {
    const card: Card = {
      id: 'card-1',
      runId: 'run-1',
      taskId: 't-1',
      conversationId: null,
      title: '选一个',
      text: '做哪个？',
      kind: 'ask',
      options: ['甲', '乙'],
      key: 'pick',
      version: 1,
      status: 'answered',
      delivery: 'delivered',
      deliveryRef: 'in-app',
      optionIndex: 1,
      answeredBy: 'channel',
      answeredAt: '2026-11-05T12:00:00.000Z',
      createdAt: '2026-11-05T11:59:00.000Z',
      updatedAt: '2026-11-05T12:00:00.000Z',
    }
    const answered: CardAnsweredPayload = { card, by: 'channel' }
    expect(answered.by).toBe(answered.card.answeredBy)
    expect(answered.card.options[answered.card.optionIndex as number]).toBe('乙')
  })

  it('event.received 保留 hops / originRunId / dedupeKey；event.dropped 只带熔断审计字段', () => {
    const received: EventReceivedPayload = {
      eventId: 'ev-1',
      source: 'agent',
      type: 'issues.opened',
      subject: 'issue-1',
      summary: '新 issue',
      detailRef: 'artifacts/ev-1.md',
      link: null,
      hops: 5,
      originRunId: 'run-1',
      dedupeKey: 'issue-1',
    }
    const dropped: EventDroppedPayload = { eventId: 'ev-2', hops: 9, reason: 'max_hops' }
    expect(received.hops).toBe(5)
    expect(Object.keys(dropped).sort()).toEqual(['eventId', 'hops', 'reason'])
  })
})
