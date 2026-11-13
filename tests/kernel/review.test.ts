// @vitest-environment node
import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { GateCheck, RunRow, Task, WorkflowStage } from '../../src/protocol/entities'
import type { Receipt } from '../../src/protocol/inputs'
import {
  REVIEW_LIMITS,
  type FindingAddress,
  type ReviewFinding,
  type ReviewReport,
} from '../../src/protocol/review'
import { exportReview } from '../../src/kernel/commands/review'
import { findReportForExport, reviewDocFileName, reviewMarkdown } from '../../src/kernel/review'
import type { ThreadRow } from '../../src/protocol/thread'
import type { View } from '../../src/kernel/types'
import {
  applyAddresses,
  blockedCommentText,
  buildReport,
  latestRev,
  locateReport,
  openFindings,
  reportForThread,
  reportTargetsStage,
  reviewFactsOf,
} from '../../src/kernel/review'

const CREATED = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-05T09:00:00.000Z'

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-review',
  workflowId: 'wf-1',
  name: '评审',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  exits: {},
  judge: null,
  handoffs: [],
  instructions: '',
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '实现导出',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-fix',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: 'th-1',
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-fix',
  purpose: 'stage',
  taskId: 'task-1',
  conversationId: null,
  stageId: 'st-fix',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: 'th-1',
  cwd: '',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  status: 'succeeded',
  prompt: '',
  output: '修完了',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: 1,
  leaseId: null,
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  startedAt: CREATED,
  endedAt: NOW,
  createdAt: CREATED,
  ...over,
})

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'report-1#R1',
  key: 'R1',
  severity: 'high',
  location: 'src/a.ts:64',
  claim: 'BOM 文件被判非法 JSON',
  evidence: 'python verify.py',
  requiredAction: '改成 utf-8-sig 后复跑',
  status: 'open',
  note: null,
  addressedByRunId: null,
  updatedAt: CREATED,
  ...over,
})

const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  id: 'report-1',
  taskId: 'task-1',
  stageId: 'st-review',
  runId: 'run-review',
  threadId: 'th-1',
  rev: 1,
  verdict: 'fail',
  checks: [{ cmd: 'pnpm check', exitCode: 1 }],
  findings: [finding()],
  artifact: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'th-1',
  source: 'manual',
  externalRef: null,
  title: '导出 JSON 加 HASH',
  status: 'open',
  taskIds: ['task-1'],
  rootTaskIds: ['task-1'],
  concurrency: 1,
  notesVersion: 0,
  notes: [],
  events: [],
  lastActivityAt: NOW,
  createdAt: CREATED,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 1,
  workflows: new Map(),
  stages: new Map([
    ['st-review', stage({ exits: { errored: { do: 'goto', stageId: 'st-fix' } } })],
    ['st-fix', stage({ id: 'st-fix', name: '修复' })],
  ]),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map([['task-1', task()]]),
  runs: new Map([['run-fix', run()]]),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map([['th-1', thread()]]),
  taskComments: new Map(),
  reviewReports: new Map([['report-1', report()]]),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
  ...over,
})

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: 'lease-1',
  turn: 1,
  output: '修完了',
  ...over,
})

const checks = (...codes: number[]): GateCheck[] =>
  codes.map((exitCode, index) => ({ cmd: `cmd-${index}`, exitCode }))

describe('kernel/review 定位（按阶段图，不按时间序）', () => {
  it('报告所属阶段把任务打回当前阶段 → 命中（gate.onFailStageId）', () => {
    const seeded = view({
      stages: new Map([
        [
          'st-review',
          stage({ judge: { maxFails: 3 }, exits: { failed: { do: 'goto', stageId: 'st-fix' } } }),
        ],
        ['st-fix', stage({ id: 'st-fix', name: '修复' })],
      ]),
    })
    expect(reportTargetsStage(seeded, report(), 'st-fix')).toBe(true)
    expect(locateReport(seeded, task())?.id).toBe('report-1')
  })

  it('onRejectStageId 命中当前阶段同样算「打回我」', () => {
    expect(reportTargetsStage(view(), report(), 'st-fix')).toBe(true)
  })

  it('阶段缺失 / 目标不匹配时不认（不误判成打回）', () => {
    expect(reportTargetsStage(view(), report({ stageId: 'st-gone' }), 'st-fix')).toBe(false)
    expect(reportTargetsStage(view(), report(), 'st-other')).toBe(false)
  })

  it('没有打回关系的报告退回「该任务最新报告」（rev 大者优先）', () => {
    const older = report({ id: 'report-1', rev: 1 })
    const newer = report({ id: 'report-2', rev: 2, createdAt: NOW })
    const seeded = view({
      stages: new Map([
        ['st-review', stage()],
        ['st-fix', stage({ id: 'st-fix' })],
      ]),
      reviewReports: new Map([
        [older.id, older],
        [newer.id, newer],
      ]),
    })
    expect(locateReport(seeded, task())?.id).toBe('report-2')
    expect(latestRev(seeded, 'task-1', 'st-review')).toBe(2)
  })

  it('同 rev 时按 createdAt、再按 id 取最大（确定性）', () => {
    const a = report({ id: 'report-a', rev: 1, createdAt: CREATED })
    const b = report({ id: 'report-b', rev: 1, createdAt: NOW })
    const c = report({ id: 'report-c', rev: 1, createdAt: NOW })
    const seeded = view({
      stages: new Map([
        ['st-review', stage()],
        ['st-fix', stage({ id: 'st-fix' })],
      ]),
      reviewReports: new Map([
        [a.id, a],
        [b.id, b],
        [c.id, c],
      ]),
    })
    expect(locateReport(seeded, task())?.id).toBe('report-c')
  })

  it('本任务没有报告：沿 handoffFromTaskId / parentTaskId 上溯一层', () => {
    const parent = task({ id: 'task-parent', threadId: 'th-2', currentStageId: 'st-review' })
    const child = task({ id: 'task-child', handoffFromTaskId: 'task-parent' })
    const parentReport = report({ id: 'report-parent', taskId: 'task-parent' })
    const seeded = view({
      stages: new Map([
        ['st-review', stage()],
        ['st-fix', stage({ id: 'st-fix' })],
      ]),
      tasks: new Map([
        [parent.id, parent],
        [child.id, child],
      ]),
      reviewReports: new Map([[parentReport.id, parentReport]]),
    })
    expect(locateReport(seeded, child)?.id).toBe('report-parent')

    const viaParent = view({
      ...seeded,
      tasks: new Map([
        [parent.id, parent],
        [
          task({ id: 'task-child', parentTaskId: 'task-parent' }).id,
          task({ id: 'task-child', parentTaskId: 'task-parent' }),
        ],
      ]),
    })
    expect(
      locateReport(viaParent, task({ id: 'task-child', parentTaskId: 'task-parent' }))?.id,
    ).toBe('report-parent')
  })

  it('上溯到不存在的任务 / 链深超限：返回 undefined（不退回文本摘要）', () => {
    const orphan = task({ id: 'task-orphan', handoffFromTaskId: 'missing' })
    const seeded = view({
      tasks: new Map([[orphan.id, orphan]]),
      reviewReports: new Map(),
    })
    expect(locateReport(seeded, orphan)).toBeUndefined()

    // 10 层链、报告只在最顶层：链深上限 8 命中不到
    const tasks = new Map<string, Task>()
    for (let i = 0; i < 10; i += 1) {
      tasks.set(
        `t${i}`,
        task({ id: `t${i}`, parentTaskId: i === 9 ? null : `t${i + 1}`, threadId: `th-${i}` }),
      )
    }
    const deep = view({
      tasks,
      reviewReports: new Map([['report-top', report({ id: 'report-top', taskId: 't9' })]]),
    })
    expect(locateReport(deep, tasks.get('t0') as Task)).toBeUndefined()
  })

  it('线程要呈现的报告：同任务取最新，跨任务优先还有 open 条目的那份', () => {
    const clean = report({
      id: 'report-clean',
      rev: 3,
      createdAt: NOW,
      findings: [finding({ id: 'report-clean#R1', status: 'addressed' })],
    })
    const pending = report({ id: 'report-pending', rev: 1, createdAt: CREATED })
    // 同一任务两份报告：定位按 rev 取最新（clean）
    expect(
      reportForThread(
        view({
          reviewReports: new Map([
            [clean.id, clean],
            [pending.id, pending],
          ]),
        }),
        thread(),
      )?.id,
    ).toBe('report-clean')

    // 两个任务：task-2 还有 open 条目 → 优先它，即便 task-1 的报告更新
    const second = task({ id: 'task-2', threadId: 'th-1' })
    const pendingSecond = report({ id: 'report-2', taskId: 'task-2', rev: 1, createdAt: CREATED })
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        [second.id, second],
      ]),
      threads: new Map([['th-1', thread({ taskIds: ['task-1', 'task-2'] })]]),
      reviewReports: new Map([
        [clean.id, clean],
        [pendingSecond.id, pendingSecond],
      ]),
    })
    expect(reportForThread(seeded, thread({ taskIds: ['task-1', 'task-2'] }))?.id).toBe('report-2')

    // 两个任务的报告都已处置干净：同档按最新取（走 newerReport 的比较分支）
    const cleanA = report({
      id: 'report-a',
      taskId: 'task-1',
      createdAt: CREATED,
      findings: [finding({ id: 'report-a#R1', status: 'addressed' })],
    })
    const cleanB = report({
      id: 'report-b',
      taskId: 'task-2',
      createdAt: NOW,
      findings: [finding({ id: 'report-b#R1', status: 'addressed' })],
    })
    expect(
      reportForThread(
        view({
          tasks: new Map([
            ['task-1', task()],
            [second.id, second],
          ]),
          threads: new Map([['th-1', thread({ taskIds: ['task-1', 'task-2'] })]]),
          reviewReports: new Map([
            [cleanA.id, cleanA],
            [cleanB.id, cleanB],
          ]),
        }),
        thread({ taskIds: ['task-1', 'task-2'] }),
      )?.id,
    ).toBe('report-b')

    // 线程任务不在视图里 / 没有报告 → undefined
    expect(
      reportForThread(view({ tasks: new Map(), reviewReports: new Map() }), thread()),
    ).toBeUndefined()
  })
})

describe('kernel/review 建行与逐条处置', () => {
  it('rev 按 (taskId, stageId) 递增，finding id 由内核拼，空位置 / 证据落 null', () => {
    const built = buildReport(
      view(),
      run(),
      'task-1',
      'st-review',
      'fail',
      [{ cmd: 'pnpm check', exitCode: 1 }],
      [
        {
          key: 'R1',
          severity: 'blocker',
          claim: '  断言  ',
          requiredAction: '复跑',
        },
      ],
      null,
      NOW,
    )
    expect(built.id).toBe('run-fix:2')
    expect(built.rev).toBe(2)
    expect(built.findings[0]?.id).toBe('run-fix:2#R1')
    expect(built.findings[0]?.claim).toBe('断言')
    expect(built.findings[0]?.location).toBeNull()
    expect(built.findings[0]?.evidence).toBeNull()
    expect(built.checks).toEqual([{ cmd: 'pnpm check', exitCode: 1 }])
  })

  it('清单超出上限时按上限截断（校验层已挡，这里是第二道防线）', () => {
    const many = Array.from({ length: REVIEW_LIMITS.maxFindings + 5 }, (_, index) => ({
      key: `R${index}`,
      severity: 'low' as const,
      claim: 'x',
      requiredAction: 'y',
    }))
    const built = buildReport(view(), run(), 'task-1', 'st-review', undefined, [], many, null, NOW)
    expect(built.findings).toHaveLength(REVIEW_LIMITS.maxFindings)
  })

  it('严重度冻结（M28）：上一版 high 不能被新版降成 medium；已处置的条目可降；升与新增不受限', () => {
    const prev = report({ findings: [finding({ severity: 'high', status: 'open' })] })
    // 混入别的任务 / 别的阶段 / 更旧版本：上一版定位必须只认 (taskId, stageId, 最大 rev)
    const base = view({
      reviewReports: new Map([
        [prev.id, prev],
        ['other-task', report({ id: 'other-task', taskId: 'task-9', findings: [] })],
        ['other-stage', report({ id: 'other-stage', stageId: 'st-9', findings: [] })],
        ['older', report({ id: 'older', rev: 0, findings: [] })],
      ]),
    })

    const downgraded = buildReport(
      base,
      run(),
      'task-1',
      'st-review',
      'pass',
      [],
      [{ key: 'R1', severity: 'medium', claim: 'c', requiredAction: 'a' }],
      null,
      NOW,
    )
    expect(downgraded.rev).toBe(2)
    expect(downgraded.findings[0]?.severity).toBe('high')

    const rejected = report({ findings: [finding({ severity: 'high', status: 'rejected' })] })
    const allowed = buildReport(
      view({ reviewReports: new Map([[rejected.id, rejected]]) }),
      run(),
      'task-1',
      'st-review',
      'pass',
      [],
      [{ key: 'R1', severity: 'low', claim: 'c', requiredAction: 'a' }],
      null,
      NOW,
    )
    expect(allowed.findings[0]?.severity).toBe('low')

    // 已标记 addressed 的旧条目不设下限（它是「已修好」的出口，不参与冻结）
    const addressed = report({ findings: [finding({ severity: 'high', status: 'addressed' })] })
    const afterFix = buildReport(
      view({ reviewReports: new Map([[addressed.id, addressed]]) }),
      run(),
      'task-1',
      'st-review',
      'pass',
      [],
      [{ key: 'R1', severity: 'low', claim: 'c', requiredAction: 'a' }],
      null,
      NOW,
    )
    expect(afterFix.findings[0]?.severity).toBe('low')

    const raised = buildReport(
      base,
      run(),
      'task-1',
      'st-review',
      'pass',
      [],
      [
        { key: 'R1', severity: 'blocker', claim: 'c', requiredAction: 'a' },
        { key: 'R2', severity: 'low', claim: 'c', requiredAction: 'a' },
      ],
      null,
      NOW,
    )
    expect(raised.findings.map((item) => item.severity)).toEqual(['blocker', 'low'])
  })

  it('fixed 必须带同回执里退出码 0 的 checkRef；rejected / deferred 必须写理由', () => {
    const applied = applyAddresses(
      report({
        findings: [
          finding({ id: 'r#fixed-ok', key: 'fixed-ok' }),
          finding({ id: 'r#fixed-bad-exit', key: 'fixed-bad-exit' }),
          finding({ id: 'r#fixed-no-ref', key: 'fixed-no-ref' }),
          finding({ id: 'r#fixed-unknown-ref', key: 'fixed-unknown-ref' }),
          finding({ id: 'r#reject-no-note', key: 'reject-no-note' }),
          finding({ id: 'r#reject-ok', key: 'reject-ok' }),
          finding({ id: 'r#defer-ok', key: 'defer-ok', status: 'open' }),
          finding({ id: 'r#closed', key: 'closed', status: 'addressed' }),
        ],
      }),
      [
        { findingId: 'r#fixed-ok', disposition: 'fixed', checkRef: 'cmd-0' },
        { findingId: 'r#fixed-bad-exit', disposition: 'fixed', checkRef: 'cmd-1' },
        { findingId: 'r#fixed-no-ref', disposition: 'fixed' },
        { findingId: 'r#fixed-unknown-ref', disposition: 'fixed', checkRef: 'nope' },
        { findingId: 'r#reject-no-note', disposition: 'rejected' },
        { findingId: 'r#reject-ok', disposition: 'rejected', note: '  不改  ' },
        { findingId: 'r#defer-ok', disposition: 'deferred', note: '下轮' },
        { findingId: 'r#closed', disposition: 'fixed', checkRef: 'cmd-0' },
        { findingId: 'r#missing', disposition: 'fixed', checkRef: 'cmd-0' },
      ],
      checks(0, 1),
      'run-fix',
      NOW,
    )
    const byId = new Map(applied.report.findings.map((item) => [item.id, item]))
    expect(byId.get('r#fixed-ok')?.status).toBe('addressed')
    expect(byId.get('r#fixed-ok')?.addressedByRunId).toBe('run-fix')
    expect(byId.get('r#fixed-bad-exit')?.status).toBe('open')
    expect(byId.get('r#fixed-no-ref')?.status).toBe('open')
    expect(byId.get('r#fixed-unknown-ref')?.status).toBe('open')
    expect(byId.get('r#reject-no-note')?.status).toBe('open')
    expect(byId.get('r#reject-ok')?.status).toBe('rejected')
    expect(byId.get('r#reject-ok')?.note).toBe('不改')
    expect(byId.get('r#defer-ok')?.status).toBe('deferred')
    expect(byId.get('r#closed')?.status).toBe('addressed')
    expect(applied.addressed.sort()).toEqual(['r#defer-ok', 'r#fixed-ok', 'r#reject-ok'])
    expect(applied.report.updatedAt).toBe(NOW)
  })

  it('没有一条被处置时原样返回（幂等，不产生新事实）', () => {
    const source = report()
    const applied = applyAddresses(source, [], checks(0), 'run-fix', NOW)
    expect(applied.report).toBe(source)
    expect(applied.addressed).toEqual([])
  })

  it('同一 findingId 重复出现只认第一条（后到的覆盖不了）', () => {
    const applied = applyAddresses(
      report(),
      [
        { findingId: 'report-1#R1', disposition: 'fixed', checkRef: 'nope' },
        { findingId: 'report-1#R1', disposition: 'fixed', checkRef: 'cmd-0' },
      ],
      checks(0),
      'run-fix',
      NOW,
    )
    expect(applied.addressed).toEqual([])
  })

  it('openFindings 只挑 open；漏项评论文案带条数上限', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      finding({ id: `r#R${index}`, key: `R${index}` }),
    )
    const text = blockedCommentText(report({ rev: 4, findings: many }), many)
    expect(text).toContain('rev 4')
    expect(text).toContain('等 12 条')
    expect(openFindings(report({ findings: [] }))).toEqual([])
    expect(blockedCommentText(report({ findings: [finding()] }), [finding()])).toContain(
      'report-1#R1',
    )
  })
})

describe('kernel/review 回执 → 事实与硬门', () => {
  it('非阶段 run / 无任务 / 任务或阶段缺失：零事实、不拦截', () => {
    expect(
      reviewFactsOf(view(), run({ purpose: 'chat' }), receipt(), null, { kind: 'kernel' }, NOW),
    ).toEqual({ facts: [], blocked: false })
    expect(
      reviewFactsOf(view(), run({ taskId: null }), receipt(), null, { kind: 'kernel' }, NOW),
    ).toEqual({ facts: [], blocked: false })
    expect(
      reviewFactsOf(
        view({ tasks: new Map() }),
        run(),
        receipt({ verdict: 'fail' }),
        null,
        { kind: 'kernel' },
        NOW,
      ),
    ).toEqual({ facts: [], blocked: false })
    expect(
      reviewFactsOf(view(), run({ stageId: null }), receipt(), null, { kind: 'kernel' }, NOW),
    ).toEqual({ facts: [], blocked: false })
  })

  it('评审轮带 verdict + findings → 产 review.reported，判定证据一并入行', () => {
    const reviewRun = run({ id: 'run-review', stageId: 'st-review' })
    const facts = reviewFactsOf(
      view({ reviewReports: new Map() }),
      reviewRun,
      receipt({
        verdict: 'fail',
        checks: [{ cmd: 'pnpm check', exitCode: 1 }],
        findings: [
          {
            key: 'R1',
            severity: 'high',
            location: 'src/a.ts:64',
            claim: 'BOM',
            requiredAction: '复跑',
          },
        ],
      }),
      { path: '/tmp/report.md', sha256: 'abc', bytes: 12 },
      { kind: 'kernel' },
      NOW,
    )
    const reported = facts.facts.find((fact) => fact.type === 'review.reported')
    expect(reported).toBeDefined()
    expect(facts.blocked).toBe(false)
    const report = (reported?.payload as { report: ReviewReport }).report
    expect(report.id).toBe('run-review:1')
    expect(report.verdict).toBe('fail')
    expect(report.artifact?.path).toBe('/tmp/report.md')
    expect(report.findings[0]?.id).toBe('run-review:1#R1')
    expect(report.checks).toEqual([{ cmd: 'pnpm check', exitCode: 1 }])
  })

  it('修复轮逐条回应全部处置 → 产 review.addressed 且放行', () => {
    const outcome = reviewFactsOf(
      view(),
      run(),
      receipt({
        addresses: [{ findingId: 'report-1#R1', disposition: 'fixed', checkRef: 'cmd-0' }],
        checks: [{ cmd: 'cmd-0', exitCode: 0 }],
      }),
      null,
      { kind: 'kernel' },
      NOW,
    )
    expect(outcome.blocked).toBe(false)
    const addressed = outcome.facts.find((fact) => fact.type === 'review.addressed')
    expect((addressed?.payload as { addressed: string[] }).addressed).toEqual(['report-1#R1'])
  })

  it('修复轮没回应 / 条件不成立 → 硬门：不推进并追加一条漏项评论', () => {
    const outcome = reviewFactsOf(view(), run(), receipt(), null, { kind: 'kernel' }, NOW)
    expect(outcome.blocked).toBe(true)
    const comment = outcome.facts.find((fact) => fact.type === 'task.comment_added')
    expect((comment?.payload as { comment: { text: string } }).comment.text).toContain(
      '还有未处置条目',
    )
    expect((comment?.payload as { comment: { id: string } }).comment.id).toBe(
      'review-blocked-run-fix',
    )
  })

  it('当前阶段不是该报告的打回目标时不上硬门（避免误伤普通阶段）', () => {
    const outcome = reviewFactsOf(
      view({ tasks: new Map([['task-1', task({ currentStageId: 'st-other' })]]) }),
      run({ stageId: 'st-other' }),
      receipt(),
      null,
      { kind: 'kernel' },
      NOW,
    )
    expect(outcome.blocked).toBe(false)
    expect(outcome.facts).toEqual([])
  })

  it('本轮没有定位到报告：不产事实也不拦截', () => {
    const outcome = reviewFactsOf(
      view({ reviewReports: new Map() }),
      run(),
      receipt({ addresses: [{ findingId: 'x#R1', disposition: 'deferred', note: '以后' }] }),
      null,
      { kind: 'kernel' },
      NOW,
    )
    expect(outcome).toEqual({ facts: [], blocked: false })
  })

  it('任务当前阶段缺失（脏投影）时报告不指向任何阶段：不拦不评', () => {
    const outcome = reviewFactsOf(
      view({ tasks: new Map([['task-1', task({ currentStageId: null })]]) }),
      run(),
      receipt(),
      null,
      { kind: 'kernel' },
      NOW,
    )
    expect(outcome.blocked).toBe(false)
    expect(outcome.facts).toEqual([])
  })
})
describe('kernel/review 排序与渲染的边角分支', () => {
  it('同 rev 时 a 更新 → 取 a；同刻同 rev 时按 id 兜底（两个方向都稳定）', () => {
    const stages = new Map([
      ['st-review', stage()],
      ['st-fix', stage({ id: 'st-fix' })],
    ])

    // 先插入较新的 report-z，再插入较旧的 report-a：createdAt 比较走「保 a」一侧
    const newerFirst = view({
      stages,
      reviewReports: new Map([
        ['report-z', report({ id: 'report-z', rev: 1, createdAt: NOW })],
        ['report-a', report({ id: 'report-a', rev: 1, createdAt: CREATED })],
      ]),
    })
    expect(locateReport(newerFirst, task())?.id).toBe('report-z')

    // 同刻同 rev：id 大者胜（report-m > report-b）
    const sameInstant = view({
      stages,
      reviewReports: new Map([
        ['report-b', report({ id: 'report-b', rev: 1, createdAt: NOW })],
        ['report-m', report({ id: 'report-m', rev: 1, createdAt: NOW })],
      ]),
    })
    expect(locateReport(sameInstant, task())?.id).toBe('report-m')

    // 反向插入顺序也得到同一结果（确定性）
    const reversed = view({
      stages,
      reviewReports: new Map([
        ['report-m', report({ id: 'report-m', rev: 1, createdAt: NOW })],
        ['report-b', report({ id: 'report-b', rev: 1, createdAt: NOW })],
      ]),
    })
    expect(locateReport(reversed, task())?.id).toBe('report-m')
  })

  it('线程里已有一份 pending 报告，随后遇到已处置干净的：保持 pending 那份', () => {
    const second = task({ id: 'task-2', threadId: 'th-1' })
    const pending = report({ id: 'report-pending', taskId: 'task-1', createdAt: CREATED })
    const clean = report({
      id: 'report-clean',
      taskId: 'task-2',
      rev: 2,
      createdAt: NOW,
      findings: [finding({ id: 'report-clean#R1', status: 'addressed' })],
    })
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        [second.id, second],
      ]),
      threads: new Map([['th-1', thread({ taskIds: ['task-1', 'task-2'] })]]),
      reviewReports: new Map([
        [pending.id, pending],
        [clean.id, clean],
      ]),
    })
    expect(reportForThread(seeded, thread({ taskIds: ['task-1', 'task-2'] }))?.id).toBe(
      'report-pending',
    )
  })

  it('latestRev：跳过别的任务 / 别的阶段，取同键最大 rev', () => {
    const seeded = view({
      reviewReports: new Map([
        ['r-a', report({ id: 'r-a', rev: 2 })],
        ['r-b', report({ id: 'r-b', rev: 5, stageId: 'st-other' })],
        ['r-c', report({ id: 'r-c', rev: 7, taskId: 'task-9' })],
        ['r-d', report({ id: 'r-d', rev: 1 })],
      ]),
    })
    expect(latestRev(seeded, 'task-1', 'st-review')).toBe(2)
    expect(latestRev(view({ reviewReports: new Map() }), 'task-1', 'st-review')).toBe(0)
  })

  it('建行保留 evidence 原文（有证据时不是 null）', () => {
    const built = buildReport(
      view(),
      run(),
      'task-1',
      'st-review',
      undefined,
      [],
      [
        {
          key: 'R1',
          severity: 'high',
          claim: '断言',
          evidence: '  python verify.py  ',
          requiredAction: '复跑',
        },
      ],
      null,
      NOW,
    )
    expect(built.findings[0]?.evidence).toBe('python verify.py')
  })
})
describe('kernel/review 提升为文档（M14 S5）', () => {
  const project = {
    id: 'pj-1',
    name: 'P',
    path: 'D:/work',
    description: '',
    createdAt: CREATED,
    updatedAt: CREATED,
  }

  const exportView = (over: Partial<View> = {}): View =>
    view({
      projects: new Map([[project.id, project]]),
      tasks: new Map([['task-1', task({ projectId: 'pj-1' })]]),
      ...over,
    })

  it('内核只做归属校验：任务 / 项目 / 报告齐备时零事实', () => {
    const decision = exportReview(exportView(), {
      type: 'review.export',
      commandId: 'c1',
      taskId: 'task-1',
    })
    expect(decision.facts).toEqual([])
    expect(decision.reject).toBeUndefined()
  })

  it('任务不存在 → not_found；未归属项目 → conflict；没有报告 → conflict', () => {
    expect(
      exportReview(exportView(), { type: 'review.export', commandId: 'c1', taskId: 't-x' }).reject
        ?.code,
    ).toBe('not_found')
    expect(
      exportReview(exportView({ tasks: new Map([['task-1', task({ projectId: null })]]) }), {
        type: 'review.export',
        commandId: 'c1',
        taskId: 'task-1',
      }).reject?.message,
    ).toContain('未归属项目')
    expect(
      exportReview(exportView({ reviewReports: new Map() }), {
        type: 'review.export',
        commandId: 'c1',
        taskId: 'task-1',
      }).reject?.message,
    ).toContain('还没有评审报告')
  })

  it('指定 reportId：取不到 / 属于别的任务都按不存在处理', () => {
    const decision = exportReview(exportView(), {
      type: 'review.export',
      commandId: 'c1',
      taskId: 'task-1',
      reportId: 'nope',
    })
    expect(decision.reject?.message).toContain('报告不存在')
    expect(findReportForExport(view(), 'task-1', 'report-1')?.id).toBe('report-1')
    expect(findReportForExport(view(), 'task-2', 'report-1')).toBeUndefined()
    expect(findReportForExport(view(), 'task-1')?.id).toBe('report-1')
    expect(findReportForExport(view({ tasks: new Map() }), 'task-1')).toBeUndefined()
  })

  it('文件名：标题净化 + 任务 id 前 8 + rev；全被净化掉时退回 review', () => {
    expect(reviewDocFileName('导出 JSON 加 HASH', 'task-1234567890', 2)).toBe(
      '导出-JSON-加-HASH-task-123-r2.md',
    )
    expect(reviewDocFileName('a/b:c*d?"<>|e', 't-1', 1)).toBe('a-b-c-d-e-t-1-r1.md')
    expect(reviewDocFileName('   ', 't-1', 1)).toBe('review-t-1-r1.md')
    expect(reviewDocFileName('x'.repeat(60), 't-1', 1).split('-')[0]).toHaveLength(40)
  })

  it('markdown：判定与证据在前，open 条目优先，含断言 / 证据 / 验收 / 处置说明', () => {
    const text = reviewMarkdown(
      '导出 JSON 加 HASH',
      report({
        rev: 2,
        checks: [{ cmd: 'pnpm check', exitCode: 1 }],
        findings: [
          finding({ id: 'r#R2', key: 'R2', severity: 'low', status: 'addressed', note: '改了' }),
          finding({ id: 'r#R1', key: 'R1', severity: 'blocker', status: 'open' }),
        ],
      }),
    )
    expect(text.startsWith('# 评审报告：导出 JSON 加 HASH')).toBe(true)
    expect(text).toContain('- 判定：fail')
    expect(text).toContain('`pnpm check` → 退出码 1')
    expect(text).toContain('待改清单（open 1 / 共 2）')
    // open 的 R1 排在已处置的 R2 前面
    expect(text.indexOf('R1 [blocker]')).toBeLessThan(text.indexOf('R2 [low]'))
    expect(text).toContain('- 证据：python verify.py')
    expect(text).toContain('- 验收：改成 utf-8-sig 后复跑')
    expect(text).toContain('- 处置说明：改了')
  })

  it('markdown：无判定证据 / 无条目时给占位文案', () => {
    const text = reviewMarkdown('任务', report({ verdict: null, checks: [], findings: [] }))
    expect(text).toContain('- 判定：（无判定）')
    expect(text).toContain('（未给出复核命令）')
    expect(text).toContain('（这份评审没有列条目）')
  })

  it('markdown：条目没有位置时不写空位置；已处置的条目带处置轮次', () => {
    const text = reviewMarkdown(
      '任务',
      report({
        findings: [
          finding({
            location: null,
            status: 'addressed',
            note: '改了',
            addressedByRunId: 'run-2',
          }),
        ],
      }),
    )
    expect(text).toContain('### R1 [high] — addressed')
    expect(text).toContain('- 处置说明：改了')
    expect(text).toContain('- 处置轮次：run-2')
  })
})

// —— 性质测试（fast-check）：逐条处置的不变量 ————————————————————————————————————
//
// 示例用例挑的是「一条 fixed + 一条 rejected」这类人工组合；这里随机生成任意状态组合的
// 清单与任意处置批，断言 `applyAddresses` 的五类不变量：
// ① 只动原本 open 的条目（已 addressed / rejected / deferred 的逐字段不变）；
// ② 被处置的 id 必在原 open 集合内、无重复、顺序与清单顺序一致；
// ③ 同批重放幂等；④ 去重后与处置批顺序无关；
// ⑤ 未知 id / `fixed` 缺有效 checkRef / 缺理由：零处置、报告引用不变。
// 固定种子，同一份输入永远给出同一条反例（`FC_SEED` 换一批）。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261113)
const PROPERTY_RUNS = 100
const ADDRESSING_RUN = 'run-fix-2'
const PASS_CMD = 'cmd-pass'
const PROPERTY_CHECKS: readonly GateCheck[] = [
  { cmd: PASS_CMD, exitCode: 0 },
  { cmd: 'cmd-fail', exitCode: 1 },
]

const severityArb: Arbitrary<ReviewFinding['severity']> = fc.constantFrom(
  'blocker',
  'high',
  'medium',
  'low',
)
const statusArb: Arbitrary<ReviewFinding['status']> = fc.constantFrom(
  'open',
  'addressed',
  'rejected',
  'deferred',
)

const propertyFindingArb: Arbitrary<ReviewFinding> = fc
  .tuple(fc.integer({ min: 1, max: 8 }), severityArb, statusArb)
  .map(([key, severity, status]): ReviewFinding => ({
    id: `report-prop#R${key}`,
    key: `R${key}`,
    severity,
    location: null,
    claim: `断言 ${key}`,
    evidence: null,
    requiredAction: '复跑门禁',
    status,
    note: status === 'open' ? null : '已处置',
    addressedByRunId: status === 'open' ? null : 'run-review',
    updatedAt: CREATED,
  }))

const findingsArb: Arbitrary<ReviewFinding[]> = fc.uniqueArray(propertyFindingArb, {
  selector: (row) => row.id,
  minLength: 1,
  maxLength: 6,
})

const dispositionArb: Arbitrary<FindingAddress['disposition']> = fc.constantFrom(
  'fixed',
  'rejected',
  'deferred',
)
const addressNoteArb: Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.constant('   '),
  fc.string({ maxLength: 20 }),
)
const addressRefArb: Arbitrary<string | undefined> = fc.constantFrom(
  undefined,
  '',
  PASS_CMD,
  'cmd-fail',
  'cmd-missing',
)

interface AddressCase {
  findings: ReviewFinding[]
  addresses: FindingAddress[]
}

/** 处置批：`index === findings.length` 时指向不存在的 finding（未知 id）。 */
const addressCaseArb: Arbitrary<AddressCase> = findingsArb.chain((findings) =>
  fc
    .array(
      fc.tuple(
        fc.integer({ min: 0, max: findings.length }),
        dispositionArb,
        addressNoteArb,
        addressRefArb,
      ),
      { maxLength: 8 },
    )
    .map((rows) => ({
      findings,
      addresses: rows.map(([index, disposition, note, checkRef]): FindingAddress => {
        const target = findings[index]
        return {
          findingId: target === undefined ? 'report-prop#ghost' : target.id,
          disposition,
          ...(note === undefined ? {} : { note }),
          ...(checkRef === undefined ? {} : { checkRef }),
        }
      }),
    })),
)

/** 实现口径：同一 findingId 只认第一条。 */
const dedupeAddresses = (addresses: readonly FindingAddress[]): FindingAddress[] => {
  const seen = new Set<string>()
  return addresses.filter((address) => {
    if (seen.has(address.findingId)) return false
    seen.add(address.findingId)
    return true
  })
}

/** 全部非法的处置批：未知 id 不用管，`note` / `checkRef` 一律缺省。 */
const invalidAddressCaseArb: Arbitrary<AddressCase> = findingsArb.chain((findings) =>
  fc
    .array(fc.tuple(fc.integer({ min: 0, max: findings.length }), dispositionArb), {
      maxLength: 6,
    })
    .map((rows) => ({
      findings,
      addresses: rows.map(([index, disposition]): FindingAddress => {
        const target = findings[index]
        return {
          findingId: target === undefined ? 'report-prop#ghost' : target.id,
          disposition,
        }
      }),
    })),
)

const applyTo = (findings: ReviewFinding[], addresses: FindingAddress[]): ReviewReport =>
  applyAddresses(report({ findings }), addresses, PROPERTY_CHECKS, ADDRESSING_RUN, NOW).report

describe('kernel/review 逐条处置的性质（fast-check 随机生成）', () => {
  it('只动原本 open 的条目：已处置的逐字段不变', () => {
    fc.assert(
      fc.property(addressCaseArb, ({ findings, addresses }) => {
        const after = applyTo(findings, addresses)
        expect(after.findings).toHaveLength(findings.length)
        after.findings.forEach((row, index) => {
          const before = findings[index]
          if (before !== undefined && before.status !== 'open') expect(row).toEqual(before)
        })
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('被处置的 id 都在原 open 集合内、不重复、按清单顺序', () => {
    fc.assert(
      fc.property(addressCaseArb, ({ findings, addresses }) => {
        const { addressed } = applyAddresses(
          report({ findings }),
          addresses,
          PROPERTY_CHECKS,
          ADDRESSING_RUN,
          NOW,
        )
        const openIds = findings.filter((row) => row.status === 'open').map((row) => row.id)
        expect(new Set(addressed).size).toBe(addressed.length)
        for (const id of addressed) expect(openIds).toContain(id)
        const positions = addressed.map((id) => findings.findIndex((row) => row.id === id))
        expect(positions).toEqual([...positions].sort((left, right) => left - right))
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('同批重放幂等：第二次零处置且返回同一报告引用', () => {
    fc.assert(
      fc.property(addressCaseArb, ({ findings, addresses }) => {
        const first = applyAddresses(
          report({ findings }),
          addresses,
          PROPERTY_CHECKS,
          ADDRESSING_RUN,
          NOW,
        )
        const second = applyAddresses(first.report, addresses, PROPERTY_CHECKS, ADDRESSING_RUN, NOW)
        expect(second.addressed).toEqual([])
        expect(second.report).toBe(first.report)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('去重后与处置批顺序无关', () => {
    fc.assert(
      fc.property(addressCaseArb, ({ findings, addresses }) => {
        const unique = dedupeAddresses(addresses)
        expect(applyTo(findings, unique)).toEqual(applyTo(findings, [...unique].reverse()))
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('同一 findingId 出现多次只认第一条', () => {
    fc.assert(
      fc.property(addressCaseArb, ({ findings, addresses }) => {
        expect(applyTo(findings, addresses)).toEqual(applyTo(findings, dedupeAddresses(addresses)))
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('全不合法的处置批：零处置且报告引用不变', () => {
    fc.assert(
      fc.property(invalidAddressCaseArb, ({ findings, addresses }) => {
        const before = report({ findings })
        const result = applyAddresses(before, addresses, PROPERTY_CHECKS, ADDRESSING_RUN, NOW)
        expect(result.addressed).toEqual([])
        expect(result.report).toBe(before)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('处置说明规范化：首尾空白去掉，空白等于没写', () => {
    fc.assert(
      fc.property(addressCaseArb, ({ findings, addresses }) => {
        const { report: after } = applyAddresses(
          report({ findings }),
          addresses,
          PROPERTY_CHECKS,
          ADDRESSING_RUN,
          NOW,
        )
        const beforeById = new Map(findings.map((row) => [row.id, row]))
        const firstBy = new Map<string, FindingAddress>()
        for (const address of addresses) {
          if (!firstBy.has(address.findingId)) firstBy.set(address.findingId, address)
        }
        for (const row of after.findings) {
          if (beforeById.get(row.id)?.status !== 'open') continue
          if (row.status === 'open') continue
          const address = firstBy.get(row.id)
          const expected = address?.note?.trim() ? address.note.trim() : null
          expect(row.note).toBe(expected)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('处置为 addressed 必有同回执里退出码 0 的 checkRef', () => {
    fc.assert(
      fc.property(addressCaseArb, ({ findings, addresses }) => {
        const { report: after } = applyAddresses(
          report({ findings }),
          addresses,
          PROPERTY_CHECKS,
          ADDRESSING_RUN,
          NOW,
        )
        const beforeById = new Map(findings.map((row) => [row.id, row]))
        const firstBy = new Map<string, FindingAddress>()
        for (const address of addresses) {
          if (!firstBy.has(address.findingId)) firstBy.set(address.findingId, address)
        }
        for (const row of after.findings) {
          if (row.status !== 'addressed') continue
          if (beforeById.get(row.id)?.status !== 'open') continue
          const address = firstBy.get(row.id)
          expect(address?.disposition).toBe('fixed')
          expect(
            PROPERTY_CHECKS.some(
              (check) => check.cmd === address?.checkRef?.trim() && check.exitCode === 0,
            ),
          ).toBe(true)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})
