// @vitest-environment node
/**
 * 授权（A2，`scopes/mandate.ts`）：换版后重校验的每种依据，以及建任务时授予的范围折算。
 *
 * 重校验口径（SPEC-authority §授权生命周期）：来源还在不在配置里、名单还认不认这个身份、
 * 准入表今天还愿不愿意给这个强度。建任务时只填已知项——阶段 / 智能体缺了就留 null，
 * 权限按「闸门恒 full，否则看 permissionMode」折算。
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Task, WorkflowStage } from '@workbench/protocol/entities'
import type { Authority, Mandate, MandateBy, SourcePolicy } from '@workbench/protocol/authority'
import { grantFacts, revalidateMandate } from '@workbench/kernel/scopes/mandate'
import { TEST_AT, emptyView, testEnv } from '../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const policy = (over: Partial<SourcePolicy> = {}): SourcePolicy => ({
  id: 'github',
  allowed: ['alice'],
  bots: ['bot-1'],
  receiveAll: false,
  admission: {
    listedAddressed: 'explicit',
    listedUnaddressed: 'inferred',
    unlistedAddressed: 'ignore',
    unlistedUnaddressed: 'ignore',
    botAddressed: 'inferred',
  },
  ...over,
})

const authority = (over: Partial<Authority> = {}): Authority => ({
  mode: 'auto',
  sources: [policy()],
  assessorAgentId: null,
  assessBatch: 8,
  assessWindowMs: 5_000,
  ...over,
})

const by = (over: Record<string, unknown> = {}): MandateBy =>
  ({
    kind: 'identity',
    source: 'github',
    identity: { kind: 'human', id: 'alice', addressed: true },
    ...over,
  }) as unknown as MandateBy

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  id: 'mandate-1',
  taskId: 't-1',
  scope: {
    workflowId: 'wf-1',
    stageId: 'st-1',
    projectId: null,
    access: 'edit',
    maxRuns: null,
    maxTokens: null,
    expiresAt: null,
  },
  strength: 'explicit',
  basis: 'table',
  policyVersion: 1,
  ruleIds: ['rule-1'],
  by: by(),
  grantedAt: CREATED,
  revokedAt: null,
  revokedReason: null,
  legacy: false,
  ...over,
})

describe('revalidateMandate：来源与依据', () => {
  it('来源已不在准入配置里：说清楚是哪个来源', () => {
    expect(revalidateMandate(mandate({ by: by({ source: 'feishu' }) }), authority())).toEqual({
      ok: false,
      reason: '来源「feishu」已不在准入配置里',
    })
  })

  it('依据是 manual（人授的）：恒过（只有人能撤）', () => {
    expect(revalidateMandate(mandate({ basis: 'manual' }), authority())).toEqual({
      ok: true,
      reason: null,
    })
  })

  it('followup 且身份还在名单：恒过；不在名单就按格判', () => {
    expect(revalidateMandate(mandate({ basis: 'followup' }), authority())).toEqual({
      ok: true,
      reason: null,
    })
  })

  it('table 且今天的准入表给到同样强度：通过', () => {
    expect(revalidateMandate(mandate({ strength: 'inferred' }), authority())).toEqual({
      ok: true,
      reason: null,
    })
  })

  it('table 且身份不在允许范围：给出「身份已不在允许范围」', () => {
    expect(
      revalidateMandate(
        mandate({ by: by({ identity: { kind: 'human', id: 'eve', addressed: true } }) }),
        authority(),
      ),
    ).toEqual({ ok: false, reason: '身份已不在允许范围' })
  })

  it('table 且机器人已移出名单：给出「机器人已移出名单」', () => {
    expect(
      revalidateMandate(
        mandate({ by: by({ identity: { kind: 'bot', id: 'bot-9', addressed: true } }) }),
        authority(),
      ),
    ).toEqual({ ok: false, reason: '机器人已移出名单' })
  })
})

describe('grantFacts：建任务时授予的范围', () => {
  const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
    id: 'st-1',
    workflowId: 'wf-1',
    name: '实现',
    position: 0,
    entryMode: 'agent',
    agentId: 'ag-1',
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

  const agent = (over: Partial<Agent> = {}): Agent => ({
    id: 'ag-1',
    name: '实现者',
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

  const task = (over: Partial<Task> = {}): Task => ({
    id: 't-1',
    title: '任务',
    description: '',
    workflowId: 'wf-1',
    projectId: null,
    currentStageId: 'st-1',
    archivedAt: null,
    origin: 'manual',
    ruleId: null,
    externalRef: null,
    labels: [],
    threadId: null,
    parentTaskId: null,
    handoffFromTaskId: null,
    handoffFromStageId: null,
    handoffFromRunId: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  })

  const granted = (
    rows: Task[],
    stages: WorkflowStage[] = [stage()],
    agents: Agent[] = [agent()],
  ): Mandate => {
    const [fact] = grantFacts({
      view: emptyView({
        stages: new Map(stages.map((item) => [item.id, item])),
        agents: new Map(agents.map((item) => [item.id, item])),
      }),
      tasks: rows,
      strength: 'explicit',
      basis: 'manual',
      by: { kind: 'manual', via: 'ui' },
      policyVersion: 3,
      now: TEST_AT,
      env: testEnv(),
    })
    return (fact!.payload as { mandate: Mandate }).mandate
  }

  it('任务没有当前阶段：阶段 / 智能体留 null，权限按 read，规则清单为空', () => {
    const row = granted([task({ currentStageId: null })])
    expect(row.scope).toMatchObject({ stageId: null, access: 'read' })
    expect(row.ruleIds).toEqual([])
    expect(row.policyVersion).toBe(3)
  })

  it('当前阶段不在视图里：范围照记阶段 id，权限按 read（不编造智能体）', () => {
    expect(granted([task({ currentStageId: 'st-9' })]).scope).toMatchObject({
      stageId: 'st-9',
      access: 'read',
    })
  })

  it('阶段绑的智能体已不在：权限按 read，阶段照记', () => {
    expect(granted([task({ ruleId: 'rule-1' })], [stage({ agentId: 'ag-9' })]).scope).toMatchObject(
      { stageId: 'st-1', access: 'read' },
    )
  })

  it('阶段与智能体都在：权限按 permissionMode 折算', () => {
    const row = granted([task()], [stage()], [agent({ permissionMode: 'read-only' })])
    expect(row.scope.access).toBe('read')
    expect(row.ruleIds).toEqual([])
  })

  it('闸门阶段：权限恒 full（要跑门禁）', () => {
    const row = granted(
      [task()],
      [stage({ judge: { maxFails: 2 } })],
      [agent({ permissionMode: 'workspace-write' })],
    )
    expect(row.scope.access).toBe('full')
  })
})
