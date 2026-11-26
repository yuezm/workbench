// @vitest-environment node
/**
 * 规则（`scopes/rules.ts`）：手动触发时的授权、预演缺摘要、补跑只应用本条规则、
 * 定时规则的下一次触发。
 *
 * 补跑的两条硬口径：只重放被跳过的那条规则（其余规则的事件早已处理过，不能重复建任务），
 * 以及按 `skippedAt` 升序——排序方向错了会让「同入口连续事件」建出两个同名线程。
 */
import { describe, expect, it } from 'vitest'
import type { Task, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import type { Authority } from '@workbench/protocol/authority'
import type { AutomationRule } from '@workbench/protocol/rules'
import type { Input } from '@workbench/protocol/inputs'
import {
  manualTriggerFacts,
  nextRuleFires,
  previewEvent,
  replayRule,
} from '@workbench/kernel/scopes/rules'
import type { EventRow, RuleSkip } from '@workbench/kernel/core/types'
import { TEST_AT, emptyView, testEnv } from '../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const workflow = (): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-todo',
  workflowId: 'wf-1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
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

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: 'rule-1',
  name: '接 Issue',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1', stageId: 'st-todo' },
  enabled: true,
  ...over,
})

const authority = (): Authority => ({
  mode: 'auto',
  sources: [],
  assessorAgentId: null,
  assessBatch: 8,
  assessWindowMs: 5_000,
})

const event = (id: string, receivedAt: string): EventRow => ({
  id,
  source: 'github',
  type: 'issues.opened',
  subject: 'repo#1',
  summary: '',
  detailRef: null,
  link: null,
  hops: 0,
  originRunId: null,
  dedupeKey: null,
  receivedAt,
})

const baseView = () =>
  emptyView({
    workflows: new Map([['wf-1', workflow()]]),
    stages: new Map([['st-todo', stage()]]),
    rules: [rule()],
    rulesVersion: 2,
  })

describe('manualTriggerFacts：有准入配置时顺带授予', () => {
  it('规则集带 authority：同批产 mandate.granted', () => {
    const decision = manualTriggerFacts(
      emptyView({ ...baseView(), authority: authority() }),
      'rule-1',
      TEST_AT,
      testEnv(),
    )
    expect(decision.facts.some((fact) => fact.type === 'mandate.granted')).toBe(true)
  })

  it('兼容模式（没有 authority）：不补授权事实（存量任务一律 legacy）', () => {
    const decision = manualTriggerFacts(baseView(), 'rule-1', TEST_AT, testEnv())
    expect(decision.facts.some((fact) => fact.type === 'mandate.granted')).toBe(false)
    expect(decision.facts.some((fact) => fact.type === 'task.created')).toBe(true)
  })
})

describe('previewEvent：事件没带摘要', () => {
  it('标题取对象（不把空摘要当标题），线程键同口径', () => {
    const preview = previewEvent(baseView(), {
      source: 'github',
      type: 'issues.opened',
      subject: 'repo#1',
    })
    expect(preview.matches).toHaveLength(1)
    expect(preview.matches[0]).toMatchObject({ ruleId: 'rule-1', title: 'repo#1' })
    expect(preview.wouldCreate).toBe(true)
  })
})

describe('nextRuleFires：只给定时规则算下一次', () => {
  it('停用 / 事件型 / 非法 cron 都给 null，合法 cron 给出时刻', () => {
    const rows = nextRuleFires(
      emptyView({
        rules: [
          rule({ id: 'rule-off', enabled: false }),
          rule({ id: 'rule-event' }),
          rule({ id: 'rule-bad', when: { cron: '不是 cron' } }),
          rule({ id: 'rule-cron', when: { cron: '0 9 * * *' } }),
        ],
      }),
      TEST_AT,
      'Asia/Shanghai',
    )
    expect(rows.map((row) => [row.ruleId, row.nextAt === null])).toEqual([
      ['rule-off', true],
      ['rule-event', true],
      ['rule-bad', true],
      ['rule-cron', false],
    ])
    expect(rows[0]?.enabled).toBe(false)
  })
})

describe('replayRule：只重放本规则，按跳过时刻升序', () => {
  const skip = (eventId: string, skippedAt: string): RuleSkip => ({
    ruleId: 'rule-b',
    eventId,
    version: 1,
    skippedAt,
  })

  const replayView = (skips: RuleSkip[]) =>
    emptyView({
      workflows: new Map([['wf-1', workflow()]]),
      stages: new Map([['st-todo', stage()]]),
      rules: [rule({ id: 'rule-a' }), rule({ id: 'rule-b', name: '规则 B' })],
      rulesVersion: 3,
      events: new Map([
        ['evt-early', event('evt-early', CREATED)],
        ['evt-late', event('evt-late', TEST_AT)],
      ]),
      ruleSkips: skips,
    })

  const replay = (skips: RuleSkip[]) =>
    replayRule(
      replayView(skips),
      { type: 'rule.replay', commandId: 'c-1', ruleId: 'rule-b' } as unknown as Extract<
        Input,
        { type: 'rule.replay' }
      >,
      TEST_AT,
      testEnv(),
    )

  it('跳过记录是「后 → 先」：排序为升序，且只应用 rule-b（rule-a 不重复建任务）', () => {
    const decision = replay([skip('evt-late', TEST_AT), skip('evt-early', CREATED)])
    const replayed = decision.facts
      .filter((fact) => fact.type === 'rule.replayed')
      .map((fact) => (fact.payload as { eventId: string }).eventId)
    expect(replayed).toEqual(['evt-early', 'evt-late'])
    const tasks = decision.facts
      .filter((fact) => fact.type === 'task.created')
      .map((fact) => (fact.payload as { task: Task }).task)
    expect(tasks.every((task) => task.ruleId === 'rule-b')).toBe(true)
  })

  it('跳过记录已经是「先 → 后」：顺序保持不变', () => {
    const decision = replay([skip('evt-early', CREATED), skip('evt-late', TEST_AT)])
    const replayed = decision.facts
      .filter((fact) => fact.type === 'rule.replayed')
      .map((fact) => (fact.payload as { eventId: string }).eventId)
    expect(replayed).toEqual(['evt-early', 'evt-late'])
  })
})
