// @vitest-environment node
/**
 * 回答卡片（`scopes/cards.ts#answerFacts`）的两条通道：停机卡与普通问答卡。
 *
 * 停机卡没有等在等的 run，回答只表示「知道了」；回答人（`via` / `byRef`）与附言（`note`）
 * 缺省时不能凭空造出字段——通道回写靠这三列还原「谁在哪里答的」。
 */
import { describe, expect, it } from 'vitest'
import type { Card, RunRow } from '@workbench/protocol/entities'
import type { Input } from '@workbench/protocol/inputs'
import { answerFacts } from '@workbench/kernel/scopes/cards'
import { TEST_AT, emptyView, testEnv } from '../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '确认',
  text: '',
  kind: 'ask',
  options: ['好', '不好'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'delivered',
  deliveryRef: 'ref-1',
  deliveryRefs: {},
  deliveryAttempts: 1,
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

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'waiting',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: CREATED,
  endedAt: null,
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

type AnswerInput = Extract<Input, { type: 'card.answer' }>

const answer = (over: Record<string, unknown> = {}): AnswerInput =>
  ({
    type: 'card.answer',
    commandId: 'c-1',
    cardId: 'card-1',
    optionIndex: 0,
    ...over,
  }) as unknown as AnswerInput

const payloadOf = (facts: ReturnType<typeof answerFacts>['facts']): Record<string, unknown> =>
  facts[0]!.payload as unknown as Record<string, unknown>

describe('answerFacts：停机卡', () => {
  it('不带通道 / 回答人 / 附言：按界面口语义落空值，不编造字段', () => {
    const decision = answerFacts(
      emptyView({ cards: new Map([['card-1', card({ kind: 'stall' })]]) }),
      answer(),
      TEST_AT,
      testEnv(),
    )
    const payload = payloadOf(decision.facts)
    expect(payload['by']).toBe('ui')
    expect((payload['card'] as Card).answeredByRef).toBeNull()
    expect('byRef' in payload).toBe(false)
    expect('note' in payload).toBe(false)
    expect(decision.facts.map((fact) => fact.type)).toEqual(['card.answered', 'card.resolved'])
  })

  it('带回答人引用与附言：都进事实（去首尾空白）', () => {
    const decision = answerFacts(
      emptyView({ cards: new Map([['card-1', card({ kind: 'stall' })]]) }),
      answer({ via: 'channel', byRef: ' feishu:u-1 ', note: ' 收到，我接手 ' }),
      TEST_AT,
      testEnv(),
    )
    const payload = payloadOf(decision.facts)
    expect((payload['card'] as Card).answeredByRef).toBe('feishu:u-1')
    expect(payload['byRef']).toBe('feishu:u-1')
    expect(payload['note']).toBe('收到，我接手')
  })
})

describe('answerFacts：问答卡', () => {
  it('带回答人引用：落进 card.answered 并续接一轮', () => {
    const decision = answerFacts(
      emptyView({
        cards: new Map([['card-1', card()]]),
        runs: new Map([['run-1', run()]]),
      }),
      answer({ via: 'channel', byRef: 'feishu:u-2' }),
      TEST_AT,
      testEnv(),
    )
    const payload = payloadOf(decision.facts)
    expect((payload['card'] as Card).answeredByRef).toBe('feishu:u-2')
    expect(payload['byRef']).toBe('feishu:u-2')
    expect(decision.facts.some((fact) => fact.type === 'run.queued')).toBe(true)
  })
})
