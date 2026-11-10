import { describe, expect, it } from 'vitest'
import type { GateCheck, RunRow, Task, WorkflowStage } from '../../src/protocol/entities'
import type { Receipt } from '../../src/protocol/inputs'
import { REVIEW_LIMITS, type ReviewFinding, type ReviewReport } from '../../src/protocol/review'
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
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffWorkflowId: null,
  handoffStageId: null,
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
    ['st-review', stage({ onRejectStageId: 'st-fix' })],
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
          stage({ gate: { maxFails: 3, onPassStageId: null, onFailStageId: 'st-fix' } }),
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
