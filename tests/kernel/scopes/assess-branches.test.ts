// @vitest-environment node
/**
 * 研判（A3，`scopes/assess.ts`）的提示词与建轮边缘臂。
 *
 * 覆盖面：提示词里「规则没写 prompt / 事件没正文 / 没有链接 / 一条启用规则都没有」这几支，
 * 以及建轮时缺智能体、缺运行时、运行时停用、智能体没配工作目录。
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Runtime } from '@workbench/protocol/entities'
import type { Authority } from '@workbench/protocol/authority'
import type { AutomationRule } from '@workbench/protocol/rules'
import { assessPrompt, assessRunFacts } from '@workbench/kernel/scopes/assess'
import type { Environment, EventRow, Limits, View } from '@workbench/kernel/core/types'
import { testLimits } from '../../support/kernel-view'

const NOW = '2026-11-24T09:00:00.000Z'
const CREATED = '2026-11-20T09:00:00.000Z'

/** 限制取内核契约默认值（与生产同口径；不在这里抄数字，抄的那份会漂）。 */
const limits = (): Limits => testLimits()

const env = (): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: limits(),
  nextId: (kind) => `${kind}-next`,
})

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  id: 'rule-1',
  name: '接 Issue',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'wf-1' },
  enabled: true,
  ...over,
})

const event = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'evt-1',
  source: 'github',
  type: 'issues.opened',
  subject: 'repo#1',
  summary: '摘要',
  detailRef: null,
  link: null,
  hops: 0,
  originRunId: null,
  dedupeKey: null,
  receivedAt: CREATED,
  ...over,
})

const authority = (over: Partial<Authority> = {}): Authority => ({
  mode: 'auto',
  sources: [],
  assessorAgentId: 'ag-assessor',
  assessBatch: 8,
  assessWindowMs: 5_000,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-assessor',
  name: '研判者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
  ...over,
})

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'default',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 3,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map([[agent().id, agent()]]),
  runtimes: new Map([[runtime().id, runtime()]]),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  rules: [rule()],
  rulesVersion: 2,
  ruleSetReplacedAt: CREATED,
  authority: authority(),
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
  activeTaskIds: new Set(),
  ...over,
})

describe('assessPrompt：只放已校验字段', () => {
  it('规则写了 prompt 就带上；没写就只留 id 与名字', () => {
    const text = assessPrompt({
      rules: [rule(), rule({ id: 'rule-2', name: '接 PR', prompt: '只看 P0' })],
      events: [event()],
      artifactsRoot: '/root/',
    })
    expect(text).toContain('- rule-1（接 Issue）')
    expect(text).toContain('- rule-2（接 PR）：只看 P0')
  })

  it('停用规则不进清单；一条都没有时明说', () => {
    const text = assessPrompt({
      rules: [rule({ enabled: false })],
      events: [event()],
      artifactsRoot: '',
    })
    expect(text).toContain('（当前没有启用的规则）')
    expect(text).not.toContain('rule-1')
  })

  it('没有正文资料 / 没有链接：各自给占位说明', () => {
    const text = assessPrompt({ rules: [rule()], events: [event()], artifactsRoot: '/root' })
    expect(text).toContain('资料：（没有正文资料）')
    expect(text).toContain('链接：（无链接）')
  })

  it('有正文资料与链接：拼成资料路径（重复斜杠归一），链接原样', () => {
    const text = assessPrompt({
      rules: [rule()],
      events: [event({ detailRef: 'events/1.md', link: 'https://example.test/1' })],
      artifactsRoot: '/root//',
    })
    expect(text).toContain('资料：/root/events/1.md')
    expect(text).toContain('链接：https://example.test/1')
  })
})

describe('assessRunFacts：建不出一轮的情形', () => {
  const input = (over: Partial<Parameters<typeof assessRunFacts>[0]> = {}) => ({
    view: view(),
    events: [event()],
    now: NOW,
    env: env(),
    ...over,
  })

  it('没有准入配置 / 没有候选事件 / 没配研判智能体 → 零事实', () => {
    expect(assessRunFacts(input({ view: view({ authority: null }) }))).toEqual([])
    expect(assessRunFacts(input({ events: [] }))).toEqual([])
    expect(
      assessRunFacts(input({ view: view({ authority: authority({ assessorAgentId: null }) }) })),
    ).toEqual([])
  })

  it('研判智能体 / 运行时不在，或运行时停用 → 零事实', () => {
    expect(assessRunFacts(input({ view: view({ agents: new Map() }) }))).toEqual([])
    expect(assessRunFacts(input({ view: view({ runtimes: new Map() }) }))).toEqual([])
    expect(
      assessRunFacts(
        input({ view: view({ runtimes: new Map([['rt-1', runtime({ enabled: false })]]) }) }),
      ),
    ).toEqual([])
  })
})

describe('assessRunFacts：建轮口径', () => {
  it('智能体没配工作目录：cwd 落空串（不编造目录）；批内按到达时间升序并截断', () => {
    const facts = assessRunFacts({
      view: view(),
      events: [
        event({ id: 'evt-2', receivedAt: NOW }),
        event({ id: 'evt-1', receivedAt: CREATED }),
      ],
      now: NOW,
      env: env(),
    })
    expect(facts).toHaveLength(1)
    const run = (facts[0]!.payload as { run: { cwd: string; eventIds: string[]; purpose: string } })
      .run
    expect(run.cwd).toBe('')
    expect(run.purpose).toBe('assess')
    expect(run.eventIds).toEqual(['evt-1', 'evt-2'])
  })
})
