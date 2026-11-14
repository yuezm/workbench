// @vitest-environment node
/**
 * `app.event`（M5）：app 插件事件只入账、不派活。
 *
 * 断言：`event.received` 的形状与回执派生事件一致（`source='app'`、`hops=1`、
 * `originRunId=null`），摘要按码点截断 200 字，缺省字段落 null；命令本身不读投影。
 */
import { describe, expect, it } from 'vitest'
import { decide } from '../../src/kernel/decide'
import type { EventReceivedPayload } from '../../src/protocol/facts'
import type { Environment, Id, IdKind, Limits, View } from '../../src/kernel/core/types'

const NOW = '2026-11-05T12:00:00.000Z'
const OWNER = { kind: 'owner', via: 'ui' } as const

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

const env = (): Environment => {
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: limits(),
    nextId: (kind: IdKind): Id => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

/** app 事件不读投影：空视图即可决策。 */
const view = (): View => ({
  seq: 1,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
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
})

const command = (over: Record<string, unknown> = {}): Parameters<typeof decide>[1] =>
  ({
    commandId: 'cmd-1',
    type: 'app.event',
    appId: 'pomodoro',
    eventType: 'pomodoro.completed',
    subject: '番茄结束',
    ...over,
  }) as Parameters<typeof decide>[1]

describe('kernel/decide app.event', () => {
  it('产一条 event.received：source=app、hops=1、originRunId=null', () => {
    const decision = decide(view(), command(), NOW, env())
    expect(decision.reject).toBeUndefined()
    expect(decision.facts).toEqual([
      {
        type: 'event.received',
        actor: OWNER,
        at: NOW,
        payload: {
          eventId: 'event-new-1',
          source: 'app',
          type: 'pomodoro.completed',
          subject: '番茄结束',
          summary: '',
          detailRef: null,
          link: null,
          hops: 1,
          originRunId: null,
          dedupeKey: null,
        },
      },
    ])
  })

  it('摘要按码点截断到 200 字，链接与去重键原样保留', () => {
    const long = '🍅'.repeat(205)
    const decision = decide(
      view(),
      command({ summary: long, link: 'https://example.com/pomodoro', dedupeKey: 'k-1' }),
      NOW,
      env(),
    )
    const payload = decision.facts[0]?.payload as EventReceivedPayload
    expect(Array.from(payload.summary)).toHaveLength(200)
    expect(payload.link).toBe('https://example.com/pomodoro')
    expect(payload.dedupeKey).toBe('k-1')
  })

  it('事件只入账：零 run、零任务、零卡片事实', () => {
    const decision = decide(view(), command({ summary: '摘要' }), NOW, env())
    expect(new Set(decision.facts.map((fact) => fact.type))).toEqual(new Set(['event.received']))
  })
})

describe('kernel/decide runtime.probe（M5 编排命令的防御分支）', () => {
  it('直连 decide 明确拒绝：探测由宿主编排，内核不碰副作用', () => {
    const decision = decide(
      view(),
      { commandId: 'c-probe', type: 'runtime.probe', id: 'rt-1' },
      NOW,
      env(),
    )
    expect(decision).toEqual({
      facts: [],
      reject: {
        code: 'unsupported',
        message: 'runtime.probe 由宿主编排（探测后落 runtime.probed）',
      },
    })
  })
})
