/**
 * M4-T3 卡片闭环黄金用例：回执 → 卡片事实（建卡 / 同 key 更新 / 信息卡 / 关闭）、
 * 回答校验与续接（全部阻塞卡答完才 `run.queued`）、`card.resolve`、`later` 复查、
 * 派生事件入账与跳数熔断，以及 decide 仍是纯函数。
 *
 * 夹具只装内核判定需要的切片（runs / runs 的 taskId / cards），其余投影表留空。
 */
import { describe, expect, it } from 'vitest'
import type { Card, Conversation, RunRow } from '../../src/protocol/entities'
import type {
  CardAnsweredPayload,
  CardDeliveredPayload,
  CardDeliveryFailedPayload,
  CardOpenedPayload,
  CardResolvedPayload,
  CardUpdatedPayload,
  EventReceivedPayload,
  RunQueuedPayload,
  RunWaitingPayload,
} from '../../src/protocol/facts'
import type { Receipt } from '../../src/protocol/inputs'
import { decide } from '../../src/kernel/decide'
import { nextWakeAt } from '../../src/kernel/next-wake'
import { answerPrompt, laterPrompt } from '../../src/kernel/prompt'
import type { Environment, Id, IdKind, Limits, View } from '../../src/kernel/types'

const NOW = '2026-11-04T12:00:00.000Z'
const LATER = '2026-11-04T13:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'

const limits = (over: Partial<Limits> = {}): Limits => ({
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
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'queued',
  prompt: 'prompt',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: null,
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
  queueSeq: 0,
  leaseId: null,
  attempt: 0,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  ...over,
})

/** 已领取的 run（默认 leaseId='run-1:1' / turn=1）。 */
const running = (over: Partial<RunRow> = {}): RunRow =>
  run({
    status: 'running',
    attempt: 1,
    leaseId: 'run-1:1',
    leaseUntil: '2026-11-04T12:02:00.000Z',
    deadlineAt: '2026-11-04T12:30:00.000Z',
    startedAt: NOW,
    ...over,
  })

/** 挂起等回答的 run：租约 / 超时已释放。 */
const waiting = (over: Partial<RunRow> = {}): RunRow =>
  run({
    status: 'waiting',
    sessionId: 'sess-1',
    leaseId: null,
    leaseUntil: null,
    deadlineAt: null,
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
  options: ['好', '不好'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'cv-1',
  title: '对话',
  agentId: 'ag-1',
  projectId: null,
  sessionId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

interface Seed {
  runs?: RunRow[]
  cards?: Card[]
  conversations?: Conversation[]
}

const view = (seed: Seed = {}): View => ({
  seq: 7,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map((seed.conversations ?? []).map((row) => [row.id, row])),
  messages: new Map(),
  cards: new Map((seed.cards ?? []).map((row) => [row.id, row])),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

/** 确定性 id 生成器：卡片 / 事件都按类型计数。 */
const env = (over: Partial<Limits> = {}): Environment => {
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: limits(over),
    nextId: (kind: IdKind): Id => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: 'run-1:1',
  turn: 1,
  ...over,
})

const receive = (
  target: View,
  payload: Receipt = receipt(),
  environment = env(),
): ReturnType<typeof decide> =>
  decide(target, { type: 'run.receipt', runId: 'run-1', receipt: payload }, NOW, environment)

const answer = (
  target: View,
  cardId = 'card-1',
  optionIndex = 0,
  via?: 'ui' | 'channel',
  environment = env(),
): ReturnType<typeof decide> =>
  decide(
    target,
    { type: 'card.answer', commandId: 'cmd-1', cardId, optionIndex, via },
    NOW,
    environment,
  )

const resolve = (target: View, cardId = 'card-1'): ReturnType<typeof decide> =>
  decide(target, { type: 'card.resolve', commandId: 'cmd-1', cardId }, NOW, env())

const types = (decision: ReturnType<typeof decide>): string[] =>
  decision.facts.map((fact) => fact.type)

const opened = (decision: ReturnType<typeof decide>, index = 0): Card =>
  (decision.facts[index]?.payload as CardOpenedPayload).card

const waitingPayload = (decision: ReturnType<typeof decide>): RunWaitingPayload =>
  decision.facts.find((fact) => fact.type === 'run.waiting')?.payload as RunWaitingPayload

const queuedRun = (decision: ReturnType<typeof decide>): RunRow =>
  (decision.facts.find((fact) => fact.type === 'run.queued')?.payload as RunQueuedPayload).run

describe('kernel/decide 回执建卡（ask / notices / resolves）', () => {
  it('ask：每条产 card.opened（version=1、delivery=pending），run.waiting.cardIds 等于本次卡', () => {
    const active = running({ sessionId: 'sess-1' })
    const decision = receive(
      view({ runs: [active] }),
      receipt({
        ask: [{ title: '确认部署', text: '要点', options: ['好', '不好'], key: 'deploy' }],
        sessionId: 'sess-2',
      }),
    )

    expect(types(decision)).toEqual(['card.opened', 'run.waiting'])
    expect(opened(decision)).toEqual({
      id: 'card-new-1',
      runId: 'run-1',
      taskId: 't-1',
      conversationId: null,
      title: '确认部署',
      text: '要点',
      kind: 'ask',
      options: ['好', '不好'],
      key: 'deploy',
      version: 1,
      status: 'open',
      delivery: 'pending',
      deliveryRef: null,
      optionIndex: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const waiting = waitingPayload(decision)
    expect(waiting.cardIds).toEqual(['card-new-1'])
    expect(waiting.run).toMatchObject({ status: 'waiting', sessionId: 'sess-2', leaseId: null })
  })

  it('多条 ask：每张一卡，cardIds 按生成顺序', () => {
    const decision = receive(
      view({ runs: [running()] }),
      receipt({
        ask: [
          { title: '一', options: ['A'] },
          { title: '二', options: ['B'] },
        ],
      }),
    )

    expect(types(decision)).toEqual(['card.opened', 'card.opened', 'run.waiting'])
    expect(waitingPayload(decision).cardIds).toEqual(['card-new-1', 'card-new-2'])
  })

  it('同 run 同 key 的 open 卡再出现：card.updated（version+1、投递重置 pending）', () => {
    const active = running()
    const existing = card({
      id: 'card-old',
      title: '旧标题',
      key: 'deploy',
      version: 2,
      delivery: 'delivered',
      deliveryRef: 'in-app',
    })
    const decision = receive(
      view({ runs: [active], cards: [existing] }),
      receipt({ ask: [{ title: '新标题', options: ['A', 'B'], key: 'deploy' }] }),
    )

    expect(types(decision)).toEqual(['card.updated', 'run.waiting'])
    const updated = (decision.facts[0]?.payload as CardUpdatedPayload).card
    expect(updated).toEqual({
      ...existing,
      title: '新标题',
      text: '',
      options: ['A', 'B'],
      version: 3,
      delivery: 'pending',
      deliveryRef: null,
      updatedAt: NOW,
    })
    expect((decision.facts[0]?.payload as CardUpdatedPayload).changes).toEqual([
      'title',
      'text',
      'options',
      'version',
      'delivery',
    ])
    expect(waitingPayload(decision).cardIds).toEqual(['card-old'])
  })

  it('同 key 但没有 open 卡（已关闭 / 已回答）：重新建卡，不复用旧行', () => {
    const active = running()
    const resolvedCard = card({ id: 'card-old', key: 'deploy', status: 'resolved', version: 3 })
    const decision = receive(
      view({ runs: [active], cards: [resolvedCard] }),
      receipt({ ask: [{ title: '再确认', options: ['A'], key: 'deploy' }] }),
    )

    expect(types(decision)).toEqual(['card.opened', 'run.waiting'])
    expect(opened(decision)).toMatchObject({ id: 'card-new-1', key: 'deploy', version: 1 })
  })

  it('notices：每条产 kind=notice 的信息卡，不挂起、不改变 run 终态', () => {
    const active = running()
    const decision = receive(view({ runs: [active] }), receipt({ notices: ['已刷新依赖'] }))

    expect(types(decision)).toEqual(['card.opened', 'run.succeeded'])
    expect(opened(decision)).toMatchObject({
      id: 'card-new-1',
      title: '已刷新依赖',
      text: '',
      kind: 'notice',
      options: [],
      key: null,
      version: 1,
      status: 'open',
      delivery: 'pending',
    })
    expect(decision.facts.some((fact) => fact.type === 'run.waiting')).toBe(false)
  })

  it('resolves：只关同一 run 的 open 卡（reason=agent），未知 / 已关闭 / 别的 run 的 id 忽略', () => {
    const active = running()
    const first = card({ id: 'card-a', key: 'a' })
    const second = card({ id: 'card-b', key: 'b', createdAt: '2026-01-01T00:00:01.000Z' })
    const closed = card({ id: 'card-c', status: 'resolved' })
    const foreign = card({ id: 'card-x', runId: 'run-2' })
    const decision = receive(
      view({ runs: [active], cards: [first, second, closed, foreign] }),
      receipt({ resolves: ['card-a', 'card-a', 'card-b', 'card-c', 'card-404', 'card-x'] }),
    )

    expect(types(decision)).toEqual(['card.resolved', 'card.resolved', 'run.succeeded'])
    const reasons = decision.facts
      .filter((fact) => fact.type === 'card.resolved')
      .map((fact) => (fact.payload as CardResolvedPayload).reason)
    expect(reasons).toEqual(['agent', 'agent'])
    expect((decision.facts[0]?.payload as CardResolvedPayload).card).toEqual({
      ...first,
      status: 'resolved',
      updatedAt: NOW,
    })
    expect((decision.facts[1]?.payload as CardResolvedPayload).card.id).toBe('card-b')
  })

  it('聊天 run：卡片挂 conversationId、taskId 为 null', () => {
    const chatRun = running({
      id: 'run-1',
      purpose: 'chat',
      taskId: null,
      conversationId: 'cv-1',
      stageId: null,
    })
    const decision = receive(
      view({ runs: [chatRun], conversations: [conversation()] }),
      receipt({ ask: [{ title: '确认', options: ['A'] }] }),
    )

    expect(opened(decision)).toMatchObject({ conversationId: 'cv-1', taskId: null })
  })
})

describe('kernel/decide card.answer 回答与续接', () => {
  it('单卡回答：card.answered + run.queued（turn+1、续接上一轮会话、notBefore=null、清租约）', () => {
    const active = waiting({ sessionId: 'sess-1' })
    const open = card({ id: 'card-1', options: ['好', '不好'], createdAt: CREATED })
    const decision = answer(view({ runs: [active], cards: [open] }), 'card-1', 1)

    expect(types(decision)).toEqual(['card.answered', 'run.queued'])
    const answered = (decision.facts[0]?.payload as CardAnsweredPayload).card
    expect(answered).toEqual({
      ...open,
      status: 'answered',
      optionIndex: 1,
      answeredBy: 'ui',
      answeredAt: NOW,
      updatedAt: NOW,
    })
    expect((decision.facts[0]?.payload as CardAnsweredPayload).by).toBe('ui')
    expect(decision.facts[0]?.actor).toEqual({ kind: 'owner', via: 'ui' })

    expect(queuedRun(decision)).toEqual({
      ...active,
      status: 'queued',
      turn: 2,
      resumeSessionId: 'sess-1',
      notBefore: null,
      leaseId: null,
      leaseUntil: null,
      deadlineAt: null,
      cancelRequested: false,
      prompt: answerPrompt([answered]),
    })
    expect(queuedRun(decision).prompt).toBe(
      '# 卡片确认结果\n请基于以下人为你选定的答案继续本轮任务：\n- 确认：不好',
    )
  })

  it('via=channel：answeredBy / by / actor 都记 channel', () => {
    const decision = answer(view({ runs: [waiting()], cards: [card()] }), 'card-1', 0, 'channel')

    expect((decision.facts[0]?.payload as CardAnsweredPayload).card.answeredBy).toBe('channel')
    expect((decision.facts[0]?.payload as CardAnsweredPayload).by).toBe('channel')
    expect(decision.facts[0]?.actor).toEqual({ kind: 'owner', via: 'channel' })
    expect(types(decision)).toEqual(['card.answered', 'run.queued'])
  })

  it('多卡：未答完只产 card.answered，run 保持 waiting；最后一张答完才续接并带全部问答对', () => {
    const active = waiting()
    const first = card({
      id: 'card-a',
      title: '第一张',
      options: ['甲', '乙'],
      createdAt: '2026-01-01T00:00:01.000Z',
    })
    const second = card({
      id: 'card-b',
      title: '第二张',
      options: ['A', 'B'],
      createdAt: '2026-01-01T00:00:02.000Z',
    })

    const partial = answer(view({ runs: [active], cards: [first, second] }), 'card-a', 1)
    expect(types(partial)).toEqual(['card.answered'])
    expect(partial.facts.some((fact) => fact.type === 'run.queued')).toBe(false)

    const answeredFirst: Card = {
      ...first,
      status: 'answered',
      optionIndex: 1,
      answeredBy: 'ui',
      answeredAt: NOW,
      updatedAt: NOW,
    }
    const done = answer(view({ runs: [active], cards: [answeredFirst, second] }), 'card-b', 0)
    expect(types(done)).toEqual(['card.answered', 'run.queued'])
    expect(queuedRun(done).prompt).toBe(
      '# 卡片确认结果\n请基于以下人为你选定的答案继续本轮任务：\n- 第一张：乙\n- 第二张：A',
    )
  })

  it('信息卡（kind=notice）不阻塞续接，也不进问答对', () => {
    const info = card({ id: 'card-info', kind: 'notice', options: [], title: '仅通知' })
    const ask = card({ id: 'card-ask', title: '确认', options: ['A'] })
    const decision = answer(view({ runs: [waiting()], cards: [info, ask] }), 'card-ask', 0)

    expect(types(decision)).toEqual(['card.answered', 'run.queued'])
    expect(queuedRun(decision).prompt).toBe(
      '# 卡片确认结果\n请基于以下人为你选定的答案继续本轮任务：\n- 确认：A',
    )
  })

  it('信息卡本身没有可选项：回答即 invalid_input', () => {
    const decision = answer(
      view({ runs: [waiting()], cards: [card({ kind: 'notice', options: [] })] }),
      'card-1',
      0,
    )
    expect(decision).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '选项下标越界: 0' },
    })
  })

  it('选项越界 / 非法下标：invalid_input，零事实', () => {
    for (const index of [-1, 2, 0.5]) {
      const decision = answer(view({ runs: [waiting()], cards: [card()] }), 'card-1', index)
      expect(decision).toEqual({
        facts: [],
        reject: { code: 'invalid_input', message: '选项下标越界: ' + String(index) },
      })
    }
  })

  it('重复回答 / 已关闭卡：conflict，零事实', () => {
    for (const status of ['answered', 'resolved'] as const) {
      const decision = answer(
        view({ runs: [waiting()], cards: [card({ status, optionIndex: 0 })] }),
        'card-1',
        1,
      )
      expect(decision).toEqual({
        facts: [],
        reject: { code: 'conflict', message: '卡片已回答或已关闭: card-1' },
      })
    }
  })

  it('卡片不存在：not_found；run 不存在或非 waiting：conflict', () => {
    expect(answer(view(), 'card-404', 0)).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '卡片不存在: card-404' },
    })

    for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
      const decision = answer(view({ runs: [run({ status })], cards: [card()] }), 'card-1', 0)
      expect(decision).toEqual({
        facts: [],
        reject: { code: 'conflict', message: '运行不存在或不在等待状态: run-1' },
      })
    }
    const missingRun = answer(view({ cards: [card()] }), 'card-1', 0)
    expect(missingRun.reject?.code).toBe('conflict')
  })

  it('续接时清掉 cancelRequested（等待期间收到过取消请求）', () => {
    const decision = answer(
      view({ runs: [waiting({ cancelRequested: true })], cards: [card()] }),
      'card-1',
      0,
    )
    expect(queuedRun(decision).cancelRequested).toBe(false)
  })
})

describe('kernel/decide card.resolve 手动关闭', () => {
  it('open 卡 → card.resolved（reason=manual），不产 run 事实', () => {
    const open = card()
    const decision = resolve(view({ runs: [waiting()], cards: [open] }), 'card-1')

    expect(types(decision)).toEqual(['card.resolved'])
    expect(decision.facts[0]?.actor).toEqual({ kind: 'owner', via: 'ui' })
    expect(decision.facts[0]?.payload as CardResolvedPayload).toEqual({
      card: { ...open, status: 'resolved', updatedAt: NOW },
      reason: 'manual',
    })
  })

  it('已回答 / 已关闭 / 不存在的卡：幂等零事实', () => {
    for (const seed of [
      view({ cards: [card({ status: 'answered' })] }),
      view({ cards: [card({ status: 'resolved' })] }),
      view(),
    ]) {
      expect(resolve(seed, 'card-1')).toEqual({ facts: [] })
    }
  })
})

describe('kernel/decide run.receipt later 约时间复查', () => {
  it('只有 later：run 回 queued（notBefore=later、turn+1、resumeSessionId、prompt=laterPrompt）', () => {
    const active = running({ sessionId: 'sess-1' })
    const decision = receive(view({ runs: [active] }), receipt({ later: LATER }))

    expect(types(decision)).toEqual(['run.queued'])
    expect(queuedRun(decision)).toEqual({
      ...active,
      status: 'queued',
      turn: 2,
      resumeSessionId: 'sess-1',
      notBefore: LATER,
      leaseId: null,
      leaseUntil: null,
      deadlineAt: null,
      cancelRequested: false,
      prompt: laterPrompt(),
    })
    expect(decision.facts.some((fact) => fact.type === 'run.succeeded')).toBe(false)
    // 到点复查走既有 queued.notBefore 通路：nextWakeAt 返回 later，clock.tick 当前零事实
    const queuedView = view({ runs: [queuedRun(decision)] })
    expect(nextWakeAt(queuedView, NOW, env())).toBe(LATER)
    expect(decide(queuedView, { type: 'clock.tick' }, NOW, env())).toEqual({ facts: [] })
  })

  it('会话 id 取 run.sessionId，为空时回退 resumeSessionId', () => {
    const fromResume = receive(
      view({ runs: [running({ sessionId: null, resumeSessionId: 'sess-old' })] }),
      receipt({ later: LATER }),
    )
    expect(queuedRun(fromResume).resumeSessionId).toBe('sess-old')
  })

  it('ask 优先于 later：挂起等回答，不产续接 run.queued', () => {
    const decision = receive(
      view({ runs: [running()] }),
      receipt({ later: LATER, ask: [{ title: '确认', options: ['A'] }] }),
    )
    expect(types(decision)).toEqual(['card.opened', 'run.waiting'])
    expect(decision.facts.some((fact) => fact.type === 'run.queued')).toBe(false)
  })

  it('带 notices 时 later 不生效：按正常终态收口（信息卡照常入账）', () => {
    const decision = receive(
      view({ runs: [running()] }),
      receipt({ later: LATER, notices: ['顺便说一句'] }),
    )
    expect(types(decision)).toEqual(['card.opened', 'run.succeeded'])
  })
})

describe('kernel/decide run.receipt events 派生事件', () => {
  it('每条事件一个 event.received：hops=父+1、originRunId、summary/dedupeKey/link 透传', () => {
    const active = running({ hops: 1 })
    const decision = receive(
      view({ runs: [active] }),
      receipt({
        events: [
          {
            source: 'github',
            type: 'issues.opened',
            subject: 'issue-1',
            summary: '新 issue',
            link: 'https://example.com/issues/1',
            dedupeKey: 'gh:1',
          },
          { source: 'timer', type: 'cron.tick', subject: 'daily' },
        ],
      }),
    )

    expect(types(decision)).toEqual(['event.received', 'event.received', 'run.succeeded'])
    expect(decision.facts[0]?.payload).toEqual({
      eventId: 'event-new-1',
      source: 'github',
      type: 'issues.opened',
      subject: 'issue-1',
      summary: '新 issue',
      detailRef: null,
      link: 'https://example.com/issues/1',
      hops: 2,
      originRunId: 'run-1',
      dedupeKey: 'gh:1',
    })
    expect(decision.facts[1]?.payload).toMatchObject({
      eventId: 'event-new-2',
      summary: '',
      link: null,
      hops: 2,
      dedupeKey: null,
    })
    expect(decision.facts[0]?.actor).toEqual({ kind: 'host', via: 'scheduler' })
  })

  it('summary 按码点截断到 200 字', () => {
    const summary = '😀'.repeat(250)
    const decision = receive(
      view({ runs: [running()] }),
      receipt({ events: [{ source: 's', type: 't', subject: 'x', summary }] }),
    )
    const payload = decision.facts[0]?.payload as EventReceivedPayload
    expect(Array.from(payload.summary)).toHaveLength(200)
    expect(payload.summary).toBe('😀'.repeat(200))
  })

  it('hops 超过 maxHops：只产 event.dropped，不派活', () => {
    const active = running({ hops: 8 })
    const decision = receive(
      view({ runs: [active] }),
      receipt({
        events: [
          { source: 's', type: 't', subject: 'x' },
          { source: 's', type: 't', subject: 'y' },
        ],
      }),
    )

    expect(types(decision)).toEqual(['event.dropped', 'event.dropped', 'run.succeeded'])
    expect(decision.facts[0]?.payload).toEqual({
      eventId: 'event-new-1',
      hops: 9,
      reason: 'max_hops',
    })
    expect(decision.facts[1]?.payload).toMatchObject({
      eventId: 'event-new-2',
      hops: 9,
      reason: 'max_hops',
    })
  })

  it('ask 与 events 同时出现：卡片事实 → 事件事实 → run.waiting', () => {
    const decision = receive(
      view({ runs: [running()] }),
      receipt({
        ask: [{ title: '确认', options: ['A'] }],
        events: [{ source: 's', type: 't', subject: 'x' }],
      }),
    )
    expect(types(decision)).toEqual(['card.opened', 'event.received', 'run.waiting'])
  })
})

describe('kernel/decide 卡片决策的纯函数性质', () => {
  it('同一视图与输入两次决策结果全等，且不修改视图', () => {
    const open = card()
    const target = view({ runs: [waiting()], cards: [open] })
    const before = JSON.stringify([...target.cards.values()])

    const first = answer(target, 'card-1', 1, 'ui', env())
    const second = answer(target, 'card-1', 1, 'ui', env())

    expect(first).toEqual(second)
    expect(JSON.stringify([...target.cards.values()])).toBe(before)
  })

  it('建卡决策同样确定性，且 run.waiting.cardIds 稳定', () => {
    const target = view({ runs: [running()] })
    const input: Receipt = receipt({ ask: [{ title: '确认', options: ['A'], key: 'k' }] })

    const first = receive(target, input, env())
    const second = receive(target, input, env())

    expect(first).toEqual(second)
    expect(waitingPayload(first).cardIds).toEqual(waitingPayload(second).cardIds)
  })
})

const deliver = (
  target: View,
  cardId = 'card-1',
  version = 1,
  ref = 'in-app',
): ReturnType<typeof decide> =>
  decide(target, { type: 'card.delivered', cardId, version, ref }, NOW, env())

const deliveryFail = (
  target: View,
  cardId = 'card-1',
  version = 1,
  error = '通道不可用',
): ReturnType<typeof decide> =>
  decide(target, { type: 'card.delivery_failed', cardId, version, error }, NOW, env())

const deliveredCard = (decision: ReturnType<typeof decide>, index = 0): Card =>
  (decision.facts[index]?.payload as CardDeliveredPayload).card

const failedCard = (decision: ReturnType<typeof decide>, index = 0): Card =>
  (decision.facts[index]?.payload as CardDeliveryFailedPayload).card

describe('kernel/decide 通道投递回写（D9）', () => {
  it('delivered：整行事实只改 delivery / deliveryRef / updatedAt，actor=host via channel', () => {
    const pending = card()
    const decision = deliver(view({ cards: [pending] }), 'card-1', 1, 'desktop')

    expect(types(decision)).toEqual(['card.delivered'])
    expect(decision.facts[0]?.actor).toEqual({ kind: 'host', via: 'channel' })
    expect((decision.facts[0]?.payload as CardDeliveredPayload).ref).toBe('desktop')
    expect(deliveredCard(decision)).toEqual({
      ...pending,
      delivery: 'delivered',
      deliveryRef: 'desktop',
      updatedAt: NOW,
    })
  })

  it('同版本重复 delivered：幂等零事实（不覆盖已有投递）', () => {
    const already = card({ delivery: 'delivered', deliveryRef: 'in-app' })

    expect(deliver(view({ cards: [already] }), 'card-1', 1, 'desktop').facts).toEqual([])
  })

  it('failed：置 delivery=failed / deliveryRef=null；同版本可被后续 delivered 覆盖', () => {
    const pending = card()
    const failed = deliveryFail(view({ cards: [pending] }))

    expect(types(failed)).toEqual(['card.delivery_failed'])
    expect(failedCard(failed)).toEqual({
      ...pending,
      delivery: 'failed',
      deliveryRef: null,
      updatedAt: NOW,
    })
    expect((failed.facts[0]?.payload as CardDeliveryFailedPayload).error).toBe('通道不可用')

    // failed → delivered：允许（通道重试成功），事实照常落
    const failedRow = failedCard(failed)
    const retried = deliver(view({ cards: [failedRow] }))
    expect(types(retried)).toEqual(['card.delivered'])
    expect(deliveredCard(retried)).toMatchObject({
      delivery: 'delivered',
      deliveryRef: 'in-app',
    })
  })

  it('版本不匹配（迟到投递）/ 卡片不存在：零事实，不新造卡片行', () => {
    const newer = card({ version: 2 })

    expect(deliver(view({ cards: [newer] }), 'card-1', 1).facts).toEqual([])
    expect(deliveryFail(view({ cards: [newer] }), 'card-1', 1).facts).toEqual([])
    expect(deliver(view({ cards: [] })).facts).toEqual([])
    expect(deliveryFail(view({ cards: [] })).facts).toEqual([])
  })

  it('已 delivered 的版本不再降级为 failed；同版本重复 failed 也幂等', () => {
    const delivered = card({ delivery: 'delivered', deliveryRef: 'in-app' })
    expect(deliveryFail(view({ cards: [delivered] })).facts).toEqual([])

    const failed = card({ delivery: 'failed' })
    expect(deliveryFail(view({ cards: [failed] })).facts).toEqual([])
  })
})
