// @vitest-environment node
/**
 * 评审（`scopes/review.ts`）：补轮次数的锚点与导出文档里的空证据。
 *
 * 锚点取 `max(报告创建时刻, 任务最后改动时刻)`——报告比任务新时按报告算，反之按任务算
 * （人把任务拖回阶段会推后锚点、预算重新计）。
 */
import { describe, expect, it } from 'vitest'
import type { RunRow, Task } from '@workbench/protocol/entities'
import type { ReviewFinding, ReviewReport } from '@workbench/protocol/review'
import { repairRounds, reviewMarkdown } from '@workbench/kernel/scopes/review'
import { emptyView } from '../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'
const ANCHOR = '2026-11-24T09:00:00.000Z'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-fix',
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

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-fix',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'succeeded',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: CREATED,
  endedAt: ANCHOR,
  createdAt: ANCHOR,
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

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'rev-1#R1',
  key: 'R1',
  severity: 'blocker',
  location: null,
  claim: '断言',
  evidence: null,
  requiredAction: '验收',
  status: 'open',
  note: null,
  addressedByRunId: null,
  updatedAt: CREATED,
  ...over,
})

const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  id: 'rev-1',
  taskId: 't-1',
  stageId: 'st-fix',
  runId: 'run-1',
  threadId: null,
  rev: 1,
  verdict: 'fail',
  checks: [],
  findings: [finding()],
  artifact: null,
  createdAt: ANCHOR,
  updatedAt: ANCHOR,
  ...over,
})

describe('repairRounds：锚点与计数', () => {
  it('报告比任务新：锚点取报告时刻，只数锚点之后的同阶段轮次', () => {
    const view = emptyView({
      runs: new Map([
        ['run-before', run({ id: 'run-before', createdAt: '2026-11-21T09:00:00.000Z' })],
        ['run-after', run({ id: 'run-after', createdAt: '2026-11-25T09:00:00.000Z' })],
        ['run-chat', run({ id: 'run-chat', purpose: 'chat', createdAt: ANCHOR })],
        ['run-other-stage', run({ id: 'run-other-stage', stageId: 'st-2', createdAt: ANCHOR })],
      ]),
    })
    expect(repairRounds(view, task(), 'st-fix', report())).toBe(1)
  })

  it('任务比报告新（人拖回阶段）：锚点取任务最后改动，锚点之前的轮次不算', () => {
    const view = emptyView({
      runs: new Map([
        ['run-after', run({ id: 'run-after', createdAt: '2026-11-25T09:00:00.000Z' })],
      ]),
    })
    expect(
      repairRounds(view, task({ updatedAt: '2026-11-26T09:00:00.000Z' }), 'st-fix', report()),
    ).toBe(0)
  })
})

describe('reviewMarkdown：没有证据的条目', () => {
  it('evidence 为空：不写「证据」行，其余行照常', () => {
    const text = reviewMarkdown('任务', report())
    expect(text).toContain('### R1 [blocker] — open')
    expect(text).toContain('- 断言：断言')
    expect(text).not.toContain('- 证据：')
    expect(text).toContain('- 验收：验收')
  })

  it('有证据与处置说明：都写出来', () => {
    const text = reviewMarkdown(
      '任务',
      report({
        findings: [
          finding({ evidence: 'pnpm test 退出码 1', note: '已修', addressedByRunId: 'run-2' }),
        ],
      }),
    )
    expect(text).toContain('- 证据：pnpm test 退出码 1')
    expect(text).toContain('- 处置说明：已修')
    expect(text).toContain('- 处置轮次：run-2')
  })
})
