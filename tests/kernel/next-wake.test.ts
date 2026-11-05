/**
 * `nextWakeAt` 的黄金用例（T7）：租约 / 超时 / 退避三类到期的最早未来时刻。
 * 夹具只装 runs 切片；内核不读时钟，`now` 由测试注入。
 */
import { describe, expect, it } from 'vitest'
import type { RunRow } from '../../src/protocol/entities'
import type { AutomationRule } from '../../src/protocol/rules'
import { nextWakeAt } from '../../src/kernel/next-wake'
import type { Environment, IdKind, Limits, View } from '../../src/kernel/types'

const NOW = '2026-11-04T12:00:00.000Z'
const FUTURE = '2026-11-04T13:00:00.000Z'
const PAST = '2026-11-04T11:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'

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

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-1',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'running',
  prompt: 'prompt',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: NOW,
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
  leaseId: 'run-1:1',
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  ...over,
})

const view = (runs: RunRow[], rules: AutomationRule[] = []): View => ({
  seq: 0,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  tasks: new Map(),
  runs: new Map(runs.map((row) => [row.id, row])),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  rules,
  rulesVersion: rules.length === 0 ? 0 : 1,
  ruleSetReplacedAt: rules.length === 0 ? null : CREATED,
  ruleFiredAt: new Map(),
})

const env = (): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: limits(),
  nextId: (kind: IdKind) => `${kind}-1`,
})

describe('kernel/next-wake', () => {
  it('无 run / 终态 run：返回 null', () => {
    expect(nextWakeAt(view([]), NOW, env())).toBeNull()
    expect(
      nextWakeAt(
        view([run({ status: 'succeeded', leaseUntil: FUTURE, deadlineAt: FUTURE })]),
        NOW,
        env(),
      ),
    ).toBeNull()
  })

  it('running：取 leaseUntil 与 deadlineAt 的最早者', () => {
    const target = view([
      run({
        id: 'run-1',
        leaseUntil: '2026-11-04T12:02:00.000Z',
        deadlineAt: '2026-11-04T12:30:00.000Z',
      }),
      run({
        id: 'run-2',
        leaseUntil: '2026-11-04T12:05:00.000Z',
        deadlineAt: '2026-11-04T12:10:00.000Z',
      }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBe('2026-11-04T12:02:00.000Z')
  })

  it('queued：notBefore 参与最早时刻比较', () => {
    const target = view([
      run({
        id: 'run-1',
        leaseUntil: '2026-11-04T12:10:00.000Z',
        deadlineAt: FUTURE,
      }),
      run({
        id: 'run-2',
        status: 'queued',
        leaseUntil: null,
        notBefore: '2026-11-04T12:05:00.000Z',
      }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBe('2026-11-04T12:05:00.000Z')
  })

  it('已过去（≤ now）的时刻不算下一次唤醒', () => {
    const target = view([
      run({ id: 'run-1', leaseUntil: PAST, deadlineAt: PAST }),
      run({ id: 'run-2', status: 'queued', notBefore: PAST }),
      run({
        id: 'run-3',
        leaseUntil: '2026-11-04T12:20:00.000Z',
        deadlineAt: FUTURE,
      }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBe('2026-11-04T12:20:00.000Z')
  })

  it('waiting 与终态不参与；无到期返回 null', () => {
    const target = view([
      run({ id: 'run-1', status: 'waiting', leaseUntil: FUTURE, deadlineAt: FUTURE }),
      run({ id: 'run-2', status: 'cancelled', leaseUntil: FUTURE, deadlineAt: FUTURE }),
      run({ id: 'run-3', status: 'queued', notBefore: null }),
    ])

    expect(nextWakeAt(target, NOW, env())).toBeNull()
  })

  it('cron 规则参与最早时刻（Asia/Shanghai 09:00 = 01:00Z）', () => {
    const cronRule: AutomationRule = {
      id: 'rule-1',
      name: '每日早报',
      when: { cron: '0 9 * * *' },
      to: { workflowId: 'wf-1' },
      enabled: true,
    }
    // NOW = 2026-11-04T20:00 Shanghai；下一次 2026-11-05 09:00 本地 = 01:00Z
    expect(nextWakeAt(view([], [cronRule]), NOW, env())).toBe('2026-11-05T01:00:00.000Z')
  })

  it('停用 / 非法 cron 不参与；cron 与 run 到期取更早者', () => {
    const disabled: AutomationRule = {
      id: 'rule-1',
      name: '停用',
      when: { cron: '0 9 * * *' },
      to: { workflowId: 'wf-1' },
      enabled: false,
    }
    const invalid: AutomationRule = {
      id: 'rule-2',
      name: '非法',
      when: { cron: 'bad' },
      to: { workflowId: 'wf-1' },
      enabled: true,
    }
    expect(nextWakeAt(view([], [disabled, invalid]), NOW, env())).toBeNull()

    const early = run({ leaseUntil: '2026-11-04T12:05:00.000Z' })
    const cronRule: AutomationRule = {
      id: 'rule-1',
      name: '每日早报',
      when: { cron: '0 9 * * *' },
      to: { workflowId: 'wf-1' },
      enabled: true,
    }
    expect(nextWakeAt(view([early], [cronRule]), NOW, env())).toBe('2026-11-04T12:05:00.000Z')
  })
})
