import { describe, expect, it } from 'vitest'
import type { Conversation, Message, RunRow, Runtime } from '../../src/protocol/entities'
import {
  FACT_TYPES,
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
  'task.created',
  'task.moved',
  'task.completed',
  'task.removed',
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
  'conversation.created',
  'conversation.updated',
  'conversation.removed',
  'message.appended',
  'snapshot.imported',
]

describe('protocol/facts', () => {
  it('FACT_TYPES 覆盖 M1 + M2 事实目录且顺序稳定', () => {
    expect([...FACT_TYPES]).toEqual(expected)
  })

  it('事实名唯一，均为小写点分，且只属于已登记的前缀', () => {
    expect(new Set(FACT_TYPES).size).toBe(FACT_TYPES.length)
    const prefixes = new Set([
      'workflow',
      'stage',
      'agent',
      'runtime',
      'task',
      'run',
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
    expect(runtimePayloads).toEqual([true, true, true, true])
    expect(settledPayloads).toEqual([true, true, true])
    expect(runChatPayloads).toEqual([true, true])
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
})
