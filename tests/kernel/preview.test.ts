// @vitest-environment node
/**
 * 规则预演（M36-F）：给一条事件样本，回答「会建哪个任务、进哪个阶段、命中哪几条规则」。
 *
 * 纯函数、零事实：只读当前规则集与目标工作流/阶段，不写线程、不建任务。
 * 停用规则也要列出来（标 `enabled:false`）——用户要能看见「这条规则本来会接，只是关着」。
 */
import { describe, expect, it } from 'vitest'
import type { Workflow, WorkflowStage } from '../../src/protocol/entities'
import type { AutomationRule } from '../../src/protocol/rules'
import { previewEvent } from '../../src/kernel/scopes/rules'
import type { View } from '../../src/kernel/core/types'

const CREATED = '2026-11-13T00:00:00.000Z'

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
  ...over,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '实现',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  exits: {},
  judge: null,
  handoffs: [],
  ...over,
})

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: 'rule-1',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
  ...over,
})

const view = (
  seed: { rules?: AutomationRule[]; workflows?: Workflow[]; stages?: WorkflowStage[] } = {},
): View => ({
  seq: 1,
  workflows: new Map((seed.workflows ?? [workflow()]).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? [stage()]).map((row) => [row.id, row])),
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
  rules: seed.rules ?? [rule()],
  rulesVersion: 1,
  ruleSetReplacedAt: CREATED,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const event = {
  source: 'github',
  type: 'issues.opened',
  subject: '#42 登录页报错',
  summary: '外部摘要',
}

describe('previewEvent：事件会落到哪里', () => {
  it('启用规则命中：给出工作流 / 阶段 / 标题（titleFrom=subject）', () => {
    const preview = previewEvent(view(), event)
    expect(preview.matches).toEqual([
      {
        ruleId: 'rule-1',
        ruleName: 'Issue 进研发',
        enabled: true,
        workflowId: 'wf-1',
        stageId: 'st-1',
        title: '#42 登录页报错',
        threadKey: '#42 登录页报错',
      },
    ])
    expect(preview.wouldCreate).toBe(true)
  })

  it('停用规则也列出来，但 wouldCreate=false', () => {
    const preview = previewEvent(view({ rules: [rule({ enabled: false })] }), event)
    expect(preview.matches).toHaveLength(1)
    expect(preview.matches[0]?.enabled).toBe(false)
    expect(preview.wouldCreate).toBe(false)
  })

  it('目标工作流 / 阶段已删：列出来但标「落点失效」', () => {
    const preview = previewEvent(view({ rules: [rule({ to: { workflowId: 'wf-gone' } })] }), event)
    expect(preview.matches[0]).toMatchObject({ workflowId: null, stageId: null, enabled: true })
    expect(preview.wouldCreate).toBe(false)
  })

  it('titleFrom=summary 取摘要；summary 空时退回 subject', () => {
    const to = { workflowId: 'wf-1', task: { titleFrom: 'summary' as const } }
    expect(previewEvent(view({ rules: [rule({ to })] }), event).matches[0]?.title).toBe('外部摘要')
    expect(
      previewEvent(view({ rules: [rule({ to })] }), { ...event, summary: '' }).matches[0]?.title,
    ).toBe('#42 登录页报错')
  })

  it('没有规则命中 / 定时规则不参与事件预演', () => {
    expect(previewEvent(view({ rules: [] }), event)).toEqual({ matches: [], wouldCreate: false })
    const cron = rule({ when: { cron: '0 9 * * *' } })
    expect(previewEvent(view({ rules: [cron] }), event).matches).toEqual([])
  })

  it('多条规则命中：按规则数组顺序全部列出', () => {
    const preview = previewEvent(
      view({
        rules: [rule({ id: 'a', name: 'A' }), rule({ id: 'b', name: 'B', enabled: false })],
      }),
      event,
    )
    expect(preview.matches.map((match) => match.ruleId)).toEqual(['a', 'b'])
    expect(preview.wouldCreate).toBe(true)
  })
})
