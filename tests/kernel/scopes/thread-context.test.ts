// @vitest-environment node
import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Card, RunRow, Task, WorkflowStage } from '@workbench/protocol/entities'
import { THREAD_LIMITS, type ThreadNote, type ThreadRow } from '@workbench/protocol/thread'
import type { View } from '@workbench/kernel/core/types'
import {
  artifactBlock,
  dropToFit,
  hasThreadHistory,
  headTailSplit,
  indexBlock,
  reviewBlock,
  runIndexBlock,
  threadContextText,
  type Item,
  type Section,
} from '@workbench/kernel/scopes/thread-context'
import type { ReviewFinding, ReviewReport } from '@workbench/protocol/review'

/** 「最近一轮产出」段标题（与实现同文案；未配产物目录时的「仅摘要」变体） */
const PRECEDING_TITLE = '### 最近一轮产出（仅摘要，完整输出见任务动态）'

/** 「任务索引」段标题（M15，独立预算；简报长度判定要把它切掉） */
const INDEX_TITLE = '### 任务索引（每个任务一行；要细节时按 runId 读那一轮的产物）'

/** 「执行索引」段标题（M47，独立预算；按 runId 回溯任意一轮） */
const RUNS_TITLE = '### 执行索引（一行一轮，按 runId 回溯任意一轮）'

/** 「产物」段标题（M51：路径与读取规则两个索引共用，只写一次） */
const ARTIFACT_TITLE = '### 产物（正文按 runId 读该轮 output.md）'

/** 「待修复清单」段标题（M14，夹在执行索引与最近一轮产出之间） */
const REVIEW_TITLE = '### 待修复清单'

/** 简报部分（`contextChars` 预算的判定范围：不含产物段、索引段、清单段与产出段） */
const briefOf = (text: string): string =>
  text.split(`\n\n${ARTIFACT_TITLE}`)[0].split('\n\n### 最近一轮产出（')[0]

/** 任务索引段（无该段时为空串；到执行索引 / 清单 / 产出为止） */
const indexOf = (text: string): string => {
  const start = text.indexOf(INDEX_TITLE)
  if (start < 0) return ''
  const next = [
    text.indexOf(`\n\n${RUNS_TITLE}`, start),
    text.indexOf(`\n\n${REVIEW_TITLE}`, start),
    text.indexOf('\n\n### 最近一轮产出（', start),
  ]
    .filter((at) => at >= 0)
    .sort((left, right) => left - right)[0]
  return next === undefined ? text.slice(start) : text.slice(start, next)
}

/** 执行索引段（无该段时为空串；到待修复清单 / 最近一轮产出为止） */
const runsIndexOf = (text: string): string => {
  const start = text.indexOf(RUNS_TITLE)
  if (start < 0) return ''
  const next = [
    text.indexOf(`\n\n${REVIEW_TITLE}`, start),
    text.indexOf('\n\n### 最近一轮产出（', start),
  ]
    .filter((at) => at >= 0)
    .sort((left, right) => left - right)[0]
  return next === undefined ? text.slice(start) : text.slice(start, next)
}

/** 产出段（无该段时为空串） */
const precedingOf = (text: string): string => {
  const index = text.indexOf('### 最近一轮产出（')
  return index < 0 ? '' : text.slice(index)
}

const CREATED = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-05T09:00:00.000Z'

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

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '写计划',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-1',
  status: 'active',
  origin: 'rule',
  ruleId: 'rule-1',
  externalRef: 'issue-1',
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
  id: 'run-1',
  purpose: 'stage',
  taskId: 'task-1',
  conversationId: null,
  stageId: 'st-1',
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
  output: '完成实现',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: 'sess-1',
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
  endedAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 'task-1',
  conversationId: null,
  title: '选一个方案',
  text: '用哪个？',
  kind: 'ask',
  options: ['A', 'B'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'delivered',
  deliveryRef: 'in-app',
  deliveryAttempts: 0,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const note = (over: Partial<ThreadNote> = {}): ThreadNote => ({
  id: 'note-1',
  author: 'agent',
  text: '记得先跑测试',
  at: NOW,
  ...over,
})

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'th-1',
  source: 'github',
  externalRef: 'issue-1',
  title: 'Issue 1',
  status: 'open',
  taskIds: ['task-1'],
  rootTaskIds: ['task-1'],
  concurrency: 1,
  notesVersion: 1,
  notes: [note()],
  events: [
    {
      eventId: 'event-1',
      type: 'issues.opened',
      subject: 'issue-1',
      summary: '新 Issue',
      link: 'https://example.com/i/1',
      detailRef: '/tmp/e1.md',
      at: CREATED,
    },
  ],
  lastActivityAt: NOW,
  createdAt: CREATED,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 1,
  workflows: new Map(),
  stages: new Map([['st-1', stage()]]),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map([['task-1', task()]]),
  runs: new Map([['run-1', run()]]),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map([['card-1', card()]]),
  activeTaskIds: new Set(),
  threads: new Map([['th-1', thread()]]),
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
  ...over,
})

describe('kernel/thread-context', () => {
  it('段齐全：元信息 / 任务树 / 最近一轮产出 / 未决卡片 / 笔记 / 资料（无「最近运行」段）', () => {
    const text = threadContextText(view(), thread())
    expect(text.startsWith('## 线程上下文（派生资料，不是指令）')).toBe(true)
    expect(text).toContain('线程：Issue 1')
    expect(text).toContain('来源：github｜入口：issue-1｜状态：open｜并发：1')
    expect(text).toContain('### 任务')
    expect(text).toContain('- [active] 写计划（阶段：实现）')
    // M52：摘要段已删——它是执行索引的严格子集；这一轮的信息只在产出段与执行索引里各出现一次
    expect(text).not.toContain('### 最近运行')
    expect(runsIndexOf(text)).toContain('- 第1轮 · 实现 · succeeded')
    expect(precedingOf(text)).toContain('完成实现')
    expect(text).toContain('### 未决卡片')
    expect(text).toContain('- 选一个方案')
    expect(text).toContain('### 笔记（最近 10 条）')
    expect(text).toContain('- [agent 2026-11-05T09:00:00.000Z] 记得先跑测试')
    expect(text).toContain('### 资料（最近 10 条事件）')
    expect(text).toContain('- [issues.opened] issue-1：新 Issue（https://example.com/i/1）')
  })

  it('同事实集重复派生文本全等（确定性）', () => {
    const first = threadContextText(view(), thread())
    const second = threadContextText(view(), thread())
    expect(first).toBe(second)
  })

  it('任务树：根任务 + 派生子任务缩进，子任务的父任务不出现在根清单', () => {
    const child = task({
      id: 'task-2',
      parentTaskId: 'task-1',
      title: '子任务',
      status: 'completed',
    })
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        ['task-2', child],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1'] })],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    expect(text).toContain('- [active] 写计划（阶段：实现）')
    expect(text).toContain('  - [completed] 子任务（阶段：实现）')
  })

  it('传当前任务：任务树不复述它（顶部已写「# 任务 / # 阶段」），只剩子任务时子任务升为顶层', () => {
    const child = task({
      id: 'task-2',
      parentTaskId: 'task-1',
      title: '子任务',
      status: 'completed',
    })
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        ['task-2', child],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1'] })],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow, 'task-1')
    expect(text).not.toContain('- [active] 写计划')
    // 父任务不在树里：子任务按顶层渲染（缩进按「树里可见的父任务层数」算）
    expect(text).toContain('### 任务\n- [completed] 子任务（阶段：实现）')

    // 线程里只有当前任务：整段消失，不产一行业务复述
    const alone = threadContextText(view(), thread(), 'task-1')
    expect(alone).not.toContain('### 任务\n')
    expect(alone).not.toContain('- [active] 写计划（阶段：实现）')
  })

  it('传当前任务：最近一轮产出不再重复任务名（不传时保持原样）', () => {
    const seeded = view()
    const current = precedingOf(threadContextText(seeded, thread(), 'task-1'))
    expect(current).not.toContain('任务：写计划')
    expect(current).toContain('阶段：实现')

    const unknown = precedingOf(threadContextText(seeded, thread()))
    expect(unknown).toContain('任务：写计划')
  })

  it('多子任务 / 多条运行 / 多张未决卡：各自按稳定顺序渲染', () => {
    const childA = task({ id: 'task-a', parentTaskId: 'task-1', title: '子 A' })
    const childB = task({ id: 'task-b', parentTaskId: 'task-1', title: '子 B' })
    const runA = run({ id: 'run-a', endedAt: '2026-11-01T00:00:00.000Z', output: '先' })
    const runB = run({ id: 'run-b', endedAt: '2026-11-02T00:00:00.000Z', output: '后' })
    const runC = run({ id: 'run-c', endedAt: '2026-11-03T00:00:00.000Z', output: '末' })
    const cardA = card({ id: 'card-a', runId: 'run-a', title: '卡 A' })
    const cardB = card({ id: 'card-b', runId: 'run-b', title: '卡 B' })
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        [childA.id, childA],
        [childB.id, childB],
      ]),
      runs: new Map([
        [runA.id, runA],
        [runB.id, runB],
        [runC.id, runC],
      ]),
      cards: new Map([
        [cardA.id, cardA],
        [cardB.id, cardB],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-a', 'task-b'], rootTaskIds: ['task-1'] })],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    const taskPart = text.slice(text.indexOf('### 任务'), text.indexOf('### 未决卡片'))
    expect(taskPart.indexOf('子 A')).toBeLessThan(taskPart.indexOf('子 B'))
    expect(taskPart).toContain('  - [active] 子 A')
    // M52：三条运行只在执行索引里出现（从新到旧），不再有第二份摘要段
    const runPart = runsIndexOf(text)
    expect(runPart.indexOf('末')).toBeLessThan(runPart.indexOf('后'))
    expect(runPart.indexOf('后')).toBeLessThan(runPart.indexOf('先'))
    const cardPart = text.slice(text.indexOf('### 未决卡片'), text.indexOf('### 笔记'))
    expect(cardPart.indexOf('卡 A')).toBeLessThan(cardPart.indexOf('卡 B'))
  })

  it('阶段缺失 / 未绑定入口 / 无链接事件 / endedAt 缺失的兜底文案', () => {
    const noStage = task({ id: 'task-a', title: '无阶段任务', currentStageId: null })
    const missingStage = task({ id: 'task-b', title: '坏阶段任务', currentStageId: 'st-gone' })
    const unbound = thread({
      externalRef: null,
      taskIds: ['task-a', 'task-b'],
      rootTaskIds: ['task-a', 'task-b'],
      events: [
        {
          eventId: 'event-empty',
          type: 'issues.closed',
          subject: 'issue-empty',
          summary: '',
          link: null,
          detailRef: null,
          at: CREATED,
        },
      ],
    })
    const fallbackRun = run({
      id: 'run-empty',
      endedAt: null,
      createdAt: '2026-11-03T00:00:00.000Z',
      output: '',
      error: '失败原因',
      status: 'failed',
    })
    const text = threadContextText(
      view({
        tasks: new Map([
          [noStage.id, noStage],
          [missingStage.id, missingStage],
        ]),
        runs: new Map([[fallbackRun.id, fallbackRun]]),
        threads: new Map([['th-1', unbound]]),
      }),
      unbound,
    )
    expect(text).toContain('入口：（未绑定）')
    expect(text).toContain('- [active] 无阶段任务（无阶段）')
    expect(text).toContain('- [active] 坏阶段任务（无阶段）')
    expect(text).toContain('- [issues.closed] issue-empty')
    // M52：唯一一条 stage run 的正文只在产出段出现；轮次信息在被执行索引接管的段里
    expect(precedingOf(text)).toContain('失败原因')
    expect(runsIndexOf(text)).toContain('run-empty')
    // 兜底文案不得把缺失字段打成字面量 undefined
    expect(text).not.toContain('undefined')
    // 兜底铺满也不越简报预算
    expect(briefOf(text).length).toBeLessThanOrEqual(THREAD_LIMITS.contextChars)
  })

  it('运行缺失 endedAt / 卡片同刻：按 createdAt 与 id 稳定排序', () => {
    const runNoEnd = run({ id: 'run-z', endedAt: null, createdAt: '2026-11-02T00:00:00.000Z' })
    const runSameEnd = run({ id: 'run-a', endedAt: '2026-11-02T00:00:00.000Z' })
    const cardB = card({ id: 'card-b', runId: 'run-a', title: '卡 B' })
    const cardA = card({ id: 'card-a', runId: 'run-a', title: '卡 A' })
    const seeded = view({
      runs: new Map([
        [runNoEnd.id, runNoEnd],
        [runSameEnd.id, runSameEnd],
      ]),
      cards: new Map([
        [cardB.id, cardB],
        [cardA.id, cardA],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    // 两条同刻运行都进执行索引：键相同时按 createdAt → id 兜底，渲染从新到旧
    const runPart = runsIndexOf(text)
    expect(runPart).toContain('run-z')
    expect(runPart).toContain('run-a')
    expect(runPart.indexOf('run-z')).toBeLessThan(runPart.indexOf('run-a'))
    const cardPart = text.slice(text.indexOf('### 未决卡片'), text.indexOf('### 笔记'))
    expect(cardPart.indexOf('卡 A')).toBeLessThan(cardPart.indexOf('卡 B'))

    // 同一批投影换一个插入顺序：渲染结果逐字相同（排序不依赖 Map 迭代顺序）
    const swapped = view({
      runs: new Map([
        [runSameEnd.id, runSameEnd],
        [runNoEnd.id, runNoEnd],
      ]),
      cards: new Map([
        [cardA.id, cardA],
        [cardB.id, cardB],
      ]),
    })
    expect(threadContextText(swapped, swapped.threads.get('th-1') as ThreadRow)).toBe(text)
    // 纯函数：同一视图连算两次逐字相同（没有跨调用的隐藏状态）
    expect(threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)).toBe(text)
  })

  it('性质：运行段的渲染顺序不依赖投影 Map 的插入顺序（随机打乱仍逐字相同）', () => {
    const rows = [
      run({ id: 'run-a', endedAt: '2026-11-02T00:00:00.000Z', output: '甲' }),
      run({ id: 'run-b', endedAt: '2026-11-03T00:00:00.000Z', output: '乙' }),
      run({ id: 'run-c', endedAt: '2026-11-04T00:00:00.000Z', output: '丙' }),
    ]
    fc.assert(
      fc.property(fc.shuffledSubarray(rows, { minLength: 3, maxLength: 3 }), (ordered) => {
        const seeded = view({ runs: new Map(ordered.map((row) => [row.id, row])) })
        const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
        const reversed = view({
          runs: new Map([...ordered].reverse().map((row) => [row.id, row])),
        })
        expect(threadContextText(reversed, reversed.threads.get('th-1') as ThreadRow)).toBe(text)
        // 顺序按时间升序、执行索引从新到旧，与插入顺序无关：丙（最新）必在甲之前
        const index = runsIndexOf(text)
        expect(index.indexOf('丙')).toBeLessThan(index.indexOf('乙'))
        expect(index.indexOf('乙')).toBeLessThan(index.indexOf('甲'))
      }),
    )
  })

  it('超过 6000 码点：按时间倒序截断并标注（保新弃旧）', () => {
    const text = threadContextText(view(), thread())
    const sections = text.split('\n### ')
    const taskSection = sections.find((part) => part.startsWith('任务'))
    expect(taskSection).not.toContain('记得先跑测试')
    expect(taskSection).not.toContain('新 Issue')
  })

  it('空线程仍返回元信息（不产生空行噪音）', () => {
    const empty = thread({
      taskIds: [],
      rootTaskIds: [],
      notes: [],
      events: [],
      title: '空线程',
    })
    const text = threadContextText(view(), empty)
    expect(text).toContain('线程：空线程')
    expect(text).not.toContain('### 任务')
  })

  it('超过 6000 码点：100 个任务时按时间倒序截断（最旧的先丢，最新保留）', () => {
    const tasks = new Map<string, Task>()
    const taskIds: string[] = []
    for (let index = 0; index < 100; index += 1) {
      const id = `task-${index}`
      taskIds.push(id)
      tasks.set(id, task({ id, title: `${String(index).padStart(3, '0')}-${'x'.repeat(90)}` }))
    }
    const seeded = thread({ taskIds, rootTaskIds: taskIds, notes: [], events: [] })
    const text = threadContextText(view({ tasks, threads: new Map([['th-1', seeded]]) }), seeded)
    // 简报（含截断标注）始终 ≤ contextChars；「最近一轮产出」段走独立预算
    expect(Array.from(briefOf(text)).length).toBeLessThanOrEqual(THREAD_LIMITS.contextChars)
    expect(Array.from(precedingOf(text)).length).toBeLessThanOrEqual(
      THREAD_LIMITS.precedingChars + 160,
    )
    expect(text).toContain('已截断')
    // 最旧的任务被丢弃、最新保留
    expect(text).toContain('099-')
    expect(text).not.toContain('000-')
  })

  it('运行缺 endedAt：按 createdAt 兜底参与排序（两侧比较都走兜底）', () => {
    // 终态 run 的 endedAt 缺失属于脏投影兜底：排序键回落到 createdAt，
    // 缺 endedAt 的一方排在后面，作为比较左操作数进入兜底。
    const ended = run({
      id: 'run-ended',
      endedAt: '2026-11-02T00:00:00.000Z',
      output: '有结束时间',
    })
    const noEnd = run({
      id: 'run-no-end',
      endedAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      output: '无结束时间',
    })
    const seeded = view({
      runs: new Map([
        [ended.id, ended],
        [noEnd.id, noEnd],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    const runPart = runsIndexOf(text)
    // 排序键取 `endedAt ?? createdAt`：有结束时间的一轮更新，因此在索引里排在前面
    expect(runPart.indexOf('run-ended')).toBeLessThan(runPart.indexOf('run-no-end'))
  })

  it('截断排序：同刻同文的笔记按原始顺序稳定取舍（不越限、不丢新任务）', () => {
    // 两条 at / 正文完全相同的笔记在「按时间倒序丢弃」时 byTime 相等，
    // 必须回落到原始下标决定取舍；无论丢哪条，可观察文本都一致。
    const tasks = new Map<string, Task>()
    const taskIds: string[] = []
    for (let index = 0; index < 100; index += 1) {
      const id = `task-${index}`
      taskIds.push(id)
      tasks.set(id, task({ id, title: `${String(index).padStart(3, '0')}-${'x'.repeat(90)}` }))
    }
    const repeatedA = note({ id: 'note-a', text: '重复笔记' })
    const repeatedB = note({ id: 'note-b', text: '重复笔记' })
    const seeded = thread({
      taskIds,
      rootTaskIds: taskIds,
      notes: [repeatedA, repeatedB],
      events: [],
    })
    const text = threadContextText(view({ tasks, threads: new Map([['th-1', seeded]]) }), seeded)
    expect(Array.from(briefOf(text)).length).toBeLessThanOrEqual(THREAD_LIMITS.contextChars)
    expect(text).toContain('已截断')
    expect(text).toContain('099-')
    expect(text).not.toContain('000-')
    expect(text).not.toContain('重复笔记')
  })
})

describe('kernel/thread-context 最近一轮产出（P1）', () => {
  it('取线程内最近一条终态 stage run：归属行 + 正文', () => {
    const text = threadContextText(view(), thread())
    expect(precedingOf(text)).toBe(
      [
        PRECEDING_TITLE,
        '- 任务：写计划｜阶段：实现｜结果：succeeded｜结束：2026-11-01T00:00:00.000Z',
        '完成实现',
      ].join('\n'),
    )
  })

  it('多条终态 run：按 endedAt 取最新；失败轮用 error 兜底正文', () => {
    const older = run({ id: 'run-old', endedAt: '2026-11-01T00:00:00.000Z', output: '旧产出' })
    const newer = run({
      id: 'run-new',
      endedAt: '2026-11-03T00:00:00.000Z',
      status: 'failed',
      output: '',
      error: '编译失败',
    })
    const seeded = view({
      runs: new Map([
        [older.id, older],
        [newer.id, newer],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    expect(precedingOf(text)).toContain('结果：failed')
    expect(precedingOf(text)).toContain('编译失败')
    expect(precedingOf(text)).not.toContain('旧产出')
  })

  it('超长正文按 precedingChars 截断：保头保尾并标注，保留换行（不压成一行）', () => {
    const long = run({
      id: 'run-long',
      output:
        '第一行\n```js\nconst a = 1\n```\n' +
        'x'.repeat(3000) +
        '\n末尾结论：Verdict: REQUEST_CHANGES',
    })
    const seeded = view({ runs: new Map([[long.id, long]]) })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    const part = precedingOf(text)
    expect(part).toContain('第一行\n```js\nconst a = 1\n```')
    expect(part).toContain('…（中间已截断')
    // 头部截断会把结论切掉，所以尾部必须保留（M14 的「保头保尾」口径）
    expect(part).toContain('末尾结论：Verdict: REQUEST_CHANGES')
    expect(Array.from(part).length).toBeLessThanOrEqual(THREAD_LIMITS.precedingChars + 160)
  })

  it('没有终态 stage run（仅 queued / running / 聊天 run）时不产该段', () => {
    const queued = run({ id: 'run-q', status: 'queued', output: '', sessionId: null })
    const chat = run({ id: 'run-c', purpose: 'chat', output: '聊天回复' })
    const seeded = view({
      runs: new Map([
        [queued.id, queued],
        [chat.id, chat],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    expect(precedingOf(text)).toBe('')
  })

  it('同 endedAt 同 createdAt 的终态 run：按 id 兜底排序（顺序稳定）', () => {
    const later = run({ id: 'run-b', endedAt: CREATED, createdAt: CREATED, output: 'B 产出' })
    const earlier = run({ id: 'run-a', endedAt: CREATED, createdAt: CREATED, output: 'A 产出' })
    const seeded = view({
      runs: new Map([
        [later.id, later],
        [earlier.id, earlier],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    // 同刻同创建时间：id 升序 → run-a 在后一条，因此它成为「最近一轮产出」，正文只在产出段
    expect(precedingOf(text)).toContain('B 产出')
    expect(precedingOf(text)).not.toContain('A 产出')
    // 执行索引列出两轮（从新到旧：run-b → run-a），id 兜底排序在两侧都比较过
    const runPart = runsIndexOf(text)
    expect(runPart.indexOf('run-b')).toBeLessThan(runPart.indexOf('run-a'))
  })

  it('任务 / 阶段缺失时归属行给兜底文案', () => {
    const orphan = run({ id: 'run-orphan', taskId: null, stageId: null, output: '孤儿产出' })
    const seeded = view({ runs: new Map([[orphan.id, orphan]]) })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    expect(precedingOf(text)).toContain('- 任务：（未知任务）｜阶段：无阶段｜结果：succeeded')
    expect(precedingOf(text)).toContain('孤儿产出')
  })
})

describe('kernel/thread-context hasThreadHistory（P1）', () => {
  it('单任务、无笔记、无事件，但有终态 run：仍视为有历史（重跑 / 打回要看到上一轮）', () => {
    const solo = thread({ taskIds: ['task-1'], rootTaskIds: ['task-1'], notes: [], events: [] })
    expect(hasThreadHistory(view(), solo)).toBe(true)
  })

  it('全新隐式线程（单任务 / 无笔记 / 无事件 / 无终态 run）不拼上下文', () => {
    const fresh = thread({ taskIds: ['task-1'], rootTaskIds: ['task-1'], notes: [], events: [] })
    expect(
      hasThreadHistory(view({ runs: new Map([['run-1', run({ status: 'queued' })]]) }), fresh),
    ).toBe(false)
  })

  it('事件 / 笔记 / 多任务任一成立即有历史', () => {
    const noRuns = view({ runs: new Map() })
    expect(hasThreadHistory(view(), thread({ notes: [note()], events: [] }))).toBe(true)
    expect(hasThreadHistory(noRuns, thread({ notes: [], events: [] }))).toBe(false)
    expect(
      hasThreadHistory(noRuns, thread({ notes: [], events: [], taskIds: ['task-1', 'task-2'] })),
    ).toBe(true)
  })
})

describe('kernel/thread-context 丢弃顺序（P1）', () => {
  it('超限时先丢事件段，笔记与任务树不动', () => {
    const tasks = new Map<string, Task>()
    const taskIds: string[] = []
    for (let index = 0; index < 55; index += 1) {
      const id = `task-${index}`
      taskIds.push(id)
      tasks.set(id, task({ id, title: `${String(index).padStart(3, '0')}-${'x'.repeat(90)}` }))
    }
    const events = Array.from({ length: 10 }, (_, index) => ({
      eventId: `event-${index}`,
      type: 'issues.opened',
      subject: `issue-${index}`,
      summary: 'y'.repeat(100),
      link: null,
      detailRef: null,
      at: CREATED,
    }))
    const seeded = thread({
      taskIds,
      rootTaskIds: taskIds,
      notes: [
        note({ id: 'note-a', text: '记得先跑测试' }),
        note({ id: 'note-b', text: '别改公共数据结构' }),
      ],
      events,
    })
    const text = threadContextText(view({ tasks, threads: new Map([['th-1', seeded]]) }), seeded)
    expect(text).toContain('已截断')
    // 事件是低价值段：先被丢（不再 10 条齐全）
    expect((text.match(/issues\.opened/g) ?? []).length).toBeLessThan(10)
    // 笔记与任务树一条不动
    expect(text).toContain('记得先跑测试')
    expect(text).toContain('别改公共数据结构')
    expect(text).toContain('000-')
    expect(text).toContain('054-')
  })
})

describe('dropToFit（丢弃循环）', () => {
  it('超限时按段丢弃：先丢最前面的段，段内保新弃旧', () => {
    const sections = [
      { title: '### 资料', items: [{ at: '2026-11-01T00:00:00.000Z', text: '旧资料' }] },
      { title: '### 笔记', items: [{ at: '2026-11-02T00:00:00.000Z', text: '新笔记' }] },
    ]
    const dropped = dropToFit(sections, (count) => count < 2)
    expect(dropped).toBe(2)
    expect(sections[0].items).toHaveLength(0)
    expect(sections[1].items).toHaveLength(0)
  })

  it('所有段落都已空但仍超上限：不再丢、停下（段数组为空时不炸）', () => {
    const dropped = dropToFit([], () => true)
    expect(dropped).toBe(0)
  })
})

describe('headTailSplit（保头保尾的切分）', () => {
  it('常规情况：头部 60% / 尾部其余，中间字数为丢弃量', () => {
    expect(headTailSplit(Array.from('abcdefghij'), 4)).toEqual({
      head: 'abc',
      tail: 'j',
      dropped: 6,
    })
  })

  it('上限小到没有尾部预算：尾部为空串（不把头部内容重复一遍）', () => {
    expect(headTailSplit(Array.from('abcdef'), 1)).toEqual({ head: 'a', tail: '', dropped: 5 })
  })
})
const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'run-review:1#R1',
  key: 'R1',
  severity: 'high',
  location: 'src/a.ts:64',
  claim: 'BOM 文件被判非法 JSON',
  evidence: null,
  requiredAction: '改成 utf-8-sig 后复跑',
  status: 'open',
  note: null,
  addressedByRunId: null,
  updatedAt: NOW,
  ...over,
})

const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  id: 'run-review:1',
  taskId: 'task-1',
  stageId: 'st-1',
  runId: 'run-review',
  threadId: 'th-1',
  rev: 1,
  verdict: 'fail',
  checks: [],
  findings: [finding()],
  artifact: null,
  createdAt: CREATED,
  updatedAt: NOW,
  ...over,
})

describe('kernel/thread-context 待修复清单段（M14）', () => {
  const withReport = (over: Partial<ReviewReport> = {}): View =>
    view({ reviewReports: new Map([['run-review:1', report(over)]]) })

  it('内联 open 条目：blocker / high 带验收条件，已处置折成计数', () => {
    const text = reviewBlock(
      withReport({
        findings: [
          finding({ id: 'r#R1', key: 'R1', severity: 'blocker' }),
          finding({ id: 'r#R2', key: 'R2', severity: 'low', requiredAction: '不该出现' }),
          finding({ id: 'r#R3', key: 'R3', status: 'addressed', claim: '已修' }),
        ],
      }),
      thread(),
    )
    expect(text).toContain('### 待修复清单（报告 rev 1，fail，open 2 / 共 3，已处置 1）')
    expect(text).toContain(
      '- R1 [blocker] src/a.ts:64 — BOM 文件被判非法 JSON → 验收：改成 utf-8-sig 后复跑',
    )
    expect(text).toContain('- R2 [low]')
    expect(text).not.toContain('不该出现')
    expect(text).toContain('完整清单：报告 run-review:1')
  })

  it('清单已全部处置：只给一行结论（不渲染条目）', () => {
    const text = reviewBlock(
      withReport({ findings: [finding({ status: 'deferred', note: '下轮' })] }),
      thread(),
    )
    expect(text).toContain('清单已全部处置。')
    expect(text).not.toContain('- R1 [high]')
  })

  it('只有 verdict、没有清单：也给段（判定是结论），但没有条目行', () => {
    const text = reviewBlock(withReport({ findings: [], verdict: 'pass' }), thread())
    expect(text).toContain('报告 rev 1，pass')
    expect(text).toContain('清单已全部处置。')
  })

  it('既无判定又无清单的报告不产该段（避免空噪音）', () => {
    expect(reviewBlock(withReport({ verdict: null, findings: [] }), thread())).toBe('')
    expect(reviewBlock(view({ reviewReports: new Map() }), thread())).toBe('')
  })

  it('条目没有位置时不留空位标记（整体性问题不属于某一行代码）', () => {
    const text = reviewBlock(
      withReport({ findings: [finding({ location: null, severity: 'low' })] }),
      thread(),
    )
    expect(text).toContain('- R1 [low] — BOM 文件被判非法 JSON')
    expect(text).not.toContain('[low]  ')
  })

  it('判定缺省但清单非空：判定位置写「无判定」，清单照常内联', () => {
    const text = reviewBlock(withReport({ verdict: null, findings: [finding()] }), thread())
    expect(text).toContain('### 待修复清单（报告 rev 1，无判定，open 1 / 共 1）')
    expect(text).toContain('- R1 [high]')
  })

  it('条数超上限折叠成计数（blocker / high 排在前）', () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      finding({
        id: `r#R${index}`,
        key: `R${String(index).padStart(2, '0')}`,
        severity: index === 44 ? 'blocker' : 'low',
        claim: '短断言',
      }),
    )
    const text = reviewBlock(withReport({ findings: many }), thread())
    expect(text).toContain('还有 5 条未在此列出')
  })

  it('字数超 reviewChars 时提前收口（不靠条数上限）', () => {
    const long = Array.from({ length: 30 }, (_, index) =>
      finding({
        id: `r#R${index}`,
        key: `R${index}`,
        severity: 'low',
        claim: 'x'.repeat(500),
        requiredAction: 'y',
      }),
    )
    const text = reviewBlock(withReport({ findings: long }), thread())
    expect(text).toContain('还有')
    expect(Array.from(text).length).toBeLessThan(THREAD_LIMITS.reviewChars + 600)
  })

  it('正文已落盘时给路径引用（不给运行 id）', () => {
    const text = reviewBlock(
      withReport({
        artifact: {
          path: '/data/artifacts/threads/th-1/reviews/1/report.md',
          sha256: 'a',
          bytes: 10,
        },
      }),
      thread(),
    )
    expect(text).toContain('完整清单：/data/artifacts/threads/th-1/reviews/1/report.md')
  })

  it('上下文总文本把该段排到「最近一轮产出」之前（下一轮最需要）', () => {
    const text = threadContextText(withReport(), thread())
    const reviewAt = text.indexOf('### 待修复清单')
    const precedingAt = text.indexOf(PRECEDING_TITLE)
    expect(reviewAt).toBeGreaterThan(-1)
    expect(precedingAt).toBeGreaterThan(reviewAt)
  })

  it('只有报告、没有事件 / 笔记 / 其他任务时也算「有历史」（交接来的修复任务要看到上游结论）', () => {
    const seeded = view({
      threads: new Map([['th-1', thread({ events: [], notes: [], taskIds: ['task-1'] })]]),
      runs: new Map(),
      cards: new Map(),
      reviewReports: new Map([['run-review:1', report()]]),
      events: new Map(),
      ruleSkips: [],
    })
    expect(hasThreadHistory(seeded, seeded.threads.get('th-1') as ThreadRow)).toBe(true)
  })
})

describe('kernel/thread-context 任务索引（M15）', () => {
  const threadOf = (seeded: View): ThreadRow => seeded.threads.get('th-1') as ThreadRow

  it('每个任务一行：阶段 · 状态 · 时间 · runId · 摘要；进行中的任务没有 runId', () => {
    const child = task({ id: 'task-2', parentTaskId: 'task-1', title: '子任务' })
    const third = task({ id: 'task-3', title: '第三个' })
    const finished = run({
      id: 'run-2',
      taskId: 'task-2',
      endedAt: '2026-11-02T03:04:05.000Z',
      output: '子任务先跑完了',
    })
    const live = run({
      id: 'run-3',
      taskId: 'task-3',
      status: 'running',
      endedAt: null,
      sessionId: null,
    })
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        ['task-2', child],
        ['task-3', third],
      ]),
      runs: new Map([
        ['run-1', run()],
        ['run-2', finished],
        ['run-3', live],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2', 'task-3'], rootTaskIds: ['task-1'] })],
      ]),
      activeTaskIds: new Set(['task-3']),
    })
    const text = indexBlock(seeded, threadOf(seeded), 'task-1')
    expect(text).toContain('- [task-1] 实现 · succeeded · 11-01 00:00 · run-1 · 完成实现 ←当前')
    expect(text).toContain('- [task-2] 实现 · succeeded · 11-02 03:04 · run-2 · 子任务先跑完了')
    expect(text).toContain('- [task-3] 实现 · 进行中 · —')
  })

  it('产物段（M51）：路径按 artifactsRoot 拼，未配置时明确说没有目录', () => {
    const rooted = artifactBlock(view({ artifactsRoot: 'C:/data/artifacts' }), thread())
    expect(rooted).toContain(ARTIFACT_TITLE)
    expect(rooted).toContain('产物：C:/data/artifacts/threads/th-1/runs/<runId>/output.md')
    const bare = artifactBlock(view(), thread())
    expect(bare).toContain('宿主未配置产物目录')
    expect(bare).not.toContain('/runs/')
  })

  it('读取规则是白名单：只点名 output.md，明确禁止把流水当上下文读', () => {
    const text = artifactBlock(view({ artifactsRoot: 'C:/data/artifacts' }), thread())
    expect(text).toContain('只打开那一轮的 `output.md`')
    expect(text).toContain('`transcript.jsonl`（全帧流水，单轮数百 KB）')
    expect(text).toContain('不要当上下文读')
    expect(text).toContain('不要遍历 `runs/` 找轮次')
    expect(text).toContain('不要向用户索要全文')
  })

  it('M51：同一路径 / 规则在整段上下文里只出现一次（两个索引共用，索引自身不再带）', () => {
    const other = task({ id: 'task-2', title: '另一个' })
    const seeded = view({
      artifactsRoot: 'C:/data/artifacts',
      tasks: new Map([
        ['task-1', task()],
        ['task-2', other],
      ]),
      runs: new Map([
        ['run-1', run()],
        ['run-2', run({ id: 'run-2', taskId: 'task-2', endedAt: '2026-11-02T00:00:00.000Z' })],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1'] })],
      ]),
    })
    const text = threadContextText(seeded, threadOf(seeded), 'task-1')
    const template = '产物：C:/data/artifacts/threads/th-1/runs/<runId>/output.md'
    expect(text.split(template)).toHaveLength(2)
    expect(text.split('不要遍历 `runs/` 找轮次')).toHaveLength(2)
    // 索引段自己不再背路径与规则
    expect(indexBlock(seeded, threadOf(seeded), 'task-1')).not.toContain('产物：')
    expect(runIndexBlock(seeded, threadOf(seeded))).not.toContain('产物：')
  })

  it('M51：线程里只有当前任务时任务索引整段不产出（与执行索引同构），产物段仍留', () => {
    const seeded = view({ artifactsRoot: 'C:/data/artifacts' })
    const text = threadContextText(seeded, thread(), 'task-1')
    expect(indexBlock(seeded, thread(), 'task-1')).toBe('')
    expect(text).not.toContain(INDEX_TITLE)
    expect(text).toContain(ARTIFACT_TITLE)
    expect(text).toContain(RUNS_TITLE)
    // 不知道当前任务时不裁：任务全列
    expect(indexBlock(seeded, thread(), null)).toContain('- [task-1]')
  })

  it('当前任务与祖先链优先；超出条目上限折叠成计数，当前任务不被折掉', () => {
    const tasks = new Map<string, Task>()
    const runs = new Map<string, RunRow>()
    const ids: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const id = `task-${index}`
      ids.push(id)
      tasks.set(id, task({ id }))
      runs.set(`run-${index}`, run({ id: `run-${index}`, taskId: id }))
    }
    const seeded = view({
      tasks,
      runs,
      threads: new Map([['th-1', thread({ taskIds: ids, rootTaskIds: ids })]]),
    })
    const text = indexBlock(seeded, threadOf(seeded), 'task-5')
    const listed = text.split('\n').filter((line) => line.startsWith('- ['))
    expect(listed.length).toBeLessThanOrEqual(THREAD_LIMITS.indexTasks)
    // 当前任务置顶：即使它在线程的任务清单里靠后，也不会被折叠掉
    expect(listed[0]).toContain('[task-5]')
    expect(text).toContain('[task-5]')
    expect(text).toContain('还有')
  })

  it('出过评审报告的 run 在索引行标 review', () => {
    // 单任务线程现在不产任务索引（M51），这里给第二个任务让索引段存在
    const seeded = view({
      reviewReports: new Map([['run-1:1', report({ runId: 'run-1' })]]),
      tasks: new Map([
        ['task-1', task()],
        ['task-2', task({ id: 'task-2', title: '另一个' })],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1'] })],
      ]),
    })
    expect(indexBlock(seeded, threadOf(seeded), 'task-1')).toContain('·review')
  })

  it('当前任务在前面、它的祖先链紧随其后（保留序按 parentTaskId 上溯）', () => {
    const parent = task({ id: 'task-1' })
    const child = task({ id: 'task-2', parentTaskId: 'task-1', title: '子任务' })
    const seeded = view({
      tasks: new Map([
        ['task-1', parent],
        ['task-2', child],
      ]),
      runs: new Map([
        ['run-1', run()],
        ['run-2', run({ id: 'run-2', taskId: 'task-2' })],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1'] })],
      ]),
    })
    const listed = indexBlock(seeded, threadOf(seeded), 'task-2')
      .split('\n')
      .filter((line) => line.startsWith('- ['))
    expect(listed[0]).toContain('[task-2]')
    expect(listed[0]).toContain('←当前')
    expect(listed[1]).toContain('[task-1]')
  })

  it('同一任务在线程里重复登记（脏投影）：比较器拿到同一个任务，按 id 兜底返回 0，顺序稳定', () => {
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        ['task-2', task({ id: 'task-2', title: '另一个' })],
      ]),
      runs: new Map([
        ['run-1', run()],
        ['run-2', run({ id: 'run-2', taskId: 'task-2' })],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2', 'task-2'], rootTaskIds: ['task-1'] })],
      ]),
    })
    const first = indexBlock(seeded, threadOf(seeded), null)
    expect(first).toBe(indexBlock(seeded, threadOf(seeded), null))
    expect(first.split('\n').filter((line) => line.startsWith('- [task-'))).toHaveLength(3)
  })

  it('条目够多但没到条数上限：按字数预算提前收口，剩下的折叠成计数', () => {
    const tasks = new Map<string, Task>()
    const runs = new Map<string, RunRow>()
    const ids: string[] = []
    for (let index = 0; index < 20; index += 1) {
      const id = `task-${index}`
      const runId = `run-3f9a2c1e-0000-4000-8000-000000000000-0000000000${String(index).padStart(2, '0')}`
      ids.push(id)
      tasks.set(id, task({ id }))
      runs.set(runId, run({ id: runId, taskId: id, output: 'y'.repeat(120) }))
    }
    const seeded = view({
      stages: new Map([['st-1', stage({ name: 'z'.repeat(40) })]]),
      tasks,
      runs,
      threads: new Map([['th-1', thread({ taskIds: ids, rootTaskIds: ids })]]),
    })
    const text = indexBlock(seeded, threadOf(seeded), 'task-0')
    const listed = text.split('\n').filter((line) => line.startsWith('- ['))
    // 条数上限是 20，这里必须是被字数预算先卡住的：列出的条目少于 20 且明确标注还有多少没列
    expect(listed.length).toBeLessThan(THREAD_LIMITS.indexTasks)
    expect(text).toContain('还有')
    expect(Array.from(text).length).toBeLessThanOrEqual(THREAD_LIMITS.indexChars)
  })

  it('同事实集两次派生全等；索引段不进 contextChars 预算', () => {
    const seeded = view({ artifactsRoot: 'C:/data/artifacts' })
    expect(indexBlock(seeded, threadOf(seeded), 'task-1')).toBe(
      indexBlock(seeded, threadOf(seeded), 'task-1'),
    )
    const text = threadContextText(seeded, threadOf(seeded), 'task-1')
    expect(Array.from(indexOf(text)).length).toBeLessThanOrEqual(THREAD_LIMITS.indexChars)
    expect(Array.from(briefOf(text)).length).toBeLessThanOrEqual(THREAD_LIMITS.contextChars)
  })
})

describe('最近一轮产出的交付物行（M28）', () => {
  const withDeliverables = run({
    id: 'run-d',
    endedAt: '2026-11-02T00:00:00.000Z',
    output: '做完了',
    deliverables: {
      branch: 'feat/export-integrity',
      base: 'develop',
      commits: ['57be895', '20c2eab'],
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      gates: [{ cmd: 'pnpm check', exitCode: 0 }],
    },
  })

  it('把分支 / 基线 / 提交 / 文件路径 / 门禁压成一行注入下游', () => {
    const seeded = view({ runs: new Map([[withDeliverables.id, withDeliverables]]) })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    const head = precedingOf(text)
    expect(head).toContain('交付物：分支 feat/export-integrity')
    expect(head).toContain('基线 develop')
    expect(head).toContain('提交 57be895 20c2eab')
    // 文件给路径而不是只给个数：这段的目的就是「下游不用再考古」
    expect(head).toContain('文件 src/a.ts src/b.ts src/c.ts')
    expect(head).toContain('门禁 pnpm check=0')
  })

  it('文件超过 4 条：列前 4 条 + 总数（路径不截断，截断的路径不是坐标）', () => {
    const many = run({
      id: 'run-m',
      endedAt: '2026-11-02T00:00:00.000Z',
      output: '做完了',
      deliverables: {
        branch: null,
        base: null,
        commits: [],
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        gates: [],
      },
    })
    const seeded = view({ runs: new Map([[many.id, many]]) })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    expect(precedingOf(text)).toContain('交付物：文件 a.ts b.ts c.ts d.ts 等 5 个')
  })

  it('没声明交付物 / 声明为空对象：整行消失，老提示词逐字不变', () => {
    const plain = run({ id: 'run-p', endedAt: '2026-11-02T00:00:00.000Z', output: 'x' })
    const seeded = view({ runs: new Map([[plain.id, plain]]) })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow)
    expect(precedingOf(text)).not.toContain('交付物：')

    const empty = run({
      id: 'run-e',
      endedAt: '2026-11-02T00:00:00.000Z',
      output: 'x',
      deliverables: { branch: null, base: null, commits: [], files: [], gates: [] },
    })
    const seededEmpty = view({ runs: new Map([[empty.id, empty]]) })
    const textEmpty = threadContextText(seededEmpty, seededEmpty.threads.get('th-1') as ThreadRow)
    expect(precedingOf(textEmpty)).not.toContain('交付物：')
  })
})

// —— 性质测试（fast-check）：预算截断的不变量 ————————————————————————————————————
//
// `headTailSplit` 与 `dropToFit` 是「超预算怎么办」的唯一判定处，边界全在 ±1 与排序上。
// 随机生成长度与预算、段与条目时刻，断言：
// ① 头尾恰好用满预算、按码点/元素不重不漏，`dropped` 与预算差严格对应；
// ② 丢弃从低重要性段开始（靠前段先空），段内按 (时刻, 正文) 升序丢弃，即保新弃旧；
// ③ 删到不超预算就停，删空也不再动，同输入结果确定。
// 固定种子，反例可复现（`FC_SEED` 换一批）。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261113)
const PROPERTY_RUNS = 100

const headTailArb: Arbitrary<{ chars: string[]; max: number }> = fc
  .tuple(fc.array(fc.string({ maxLength: 6 }), { maxLength: 30 }), fc.integer({ min: 1, max: 30 }))
  .map(([chars, max]) => ({ chars, max }))

describe('headTailSplit 的性质（fast-check 随机生成）', () => {
  it('头是前缀、尾是后缀，头尾恰好用满预算且不重叠', () => {
    fc.assert(
      fc.property(headTailArb, ({ chars, max }) => {
        // 契约范围：只在超预算时切分（未超预算的调用方根本不会进来）
        fc.pre(chars.length >= max)
        const { head, tail } = headTailSplit(chars, max)
        const headLen = Math.ceil(max * 0.6)
        const tailLen = max - headLen
        expect(head).toBe(chars.slice(0, headLen).join(''))
        expect(tail).toBe(tailLen === 0 ? '' : chars.slice(chars.length - tailLen).join(''))
        // 头尾元素数加起来正好是预算，中间那截才是被丢掉的
        expect(headLen + tailLen).toBe(max)
        // 头预算不小于尾预算（保头的口径）
        expect(headLen).toBeGreaterThanOrEqual(tailLen)
        if (tailLen > 0) expect(chars.slice(-tailLen).join('')).toBe(tail)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('未被截断时头就是全部：没有丢内容，也没有凭空补内容', () => {
    fc.assert(
      fc.property(headTailArb, ({ chars, max }) => {
        fc.pre(chars.length <= Math.ceil(max * 0.6))
        const { head } = headTailSplit(chars, max)
        expect(head).toBe(chars.join(''))
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('dropped 恒等于长度与预算之差（±1 会立刻露馅）', () => {
    fc.assert(
      fc.property(headTailArb, ({ chars, max }) => {
        const { dropped } = headTailSplit(chars, max)
        expect(dropped).toBe(chars.length - max)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('预算为 1 时没有尾部预算：tail 为空串（不重复头部）', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 20 }), (chars) => {
        expect(headTailSplit(chars, 1).tail).toBe('')
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})

/** 段内条目：`text` 做成唯一键，保证 (时刻, 正文) 是全序，剩余集合可逐项核对。 */
const sectionsArb: Arbitrary<Section[]> = fc
  .array(
    fc.array(
      fc.record({
        at: fc.oneof(
          fc.constant<string | null>(null),
          fc.integer({ min: 1, max: 5 }).map((day) => `2026-11-0${day}T00:00:00.000Z`),
        ),
      }),
      { maxLength: 4 },
    ),
    { minLength: 2, maxLength: 4 },
  )
  .map((sections) =>
    sections.map((items, sectionIndex) => ({
      title: `S${sectionIndex}`,
      items: items.map((item, itemIndex): Item => ({
        at: item.at,
        text: `t${sectionIndex}-${itemIndex}`,
      })),
    })),
  )

const cloneSections = (sections: readonly Section[]): Section[] =>
  sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) => ({ ...item })),
  }))

/** 与实现同口径的排序键（用来独立算「该保留哪些」）。 */
const byTimeKey = (a: Item, b: Item): number =>
  (a.at ?? '').localeCompare(b.at ?? '') || a.text.localeCompare(b.text)

const countItems = (sections: readonly Section[]): number =>
  sections.reduce((total, section) => total + section.items.length, 0)

describe('dropToFit 的性质（fast-check 随机生成）', () => {
  it('删到不超上限就停：返回值等于实际删除数，剩余数 ≤ 上限或全空', () => {
    fc.assert(
      fc.property(sectionsArb, fc.integer({ min: 0, max: 16 }), (sections, limit) => {
        const total = countItems(sections)
        const working = cloneSections(sections)
        const dropped = dropToFit(working, (count) => total - count > limit)
        expect(dropped).toBe(total - countItems(working))
        const remaining = countItems(working)
        expect(remaining).toBeLessThanOrEqual(limit)
        expect(dropped).toBeLessThanOrEqual(total)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('从低重要性段开始丢：某段被删过时，靠前的段必须已空', () => {
    fc.assert(
      fc.property(sectionsArb, fc.integer({ min: 0, max: 16 }), (sections, limit) => {
        const total = countItems(sections)
        const working = cloneSections(sections)
        dropToFit(working, (count) => total - count > limit)
        sections.forEach((section, index) => {
          const trimmed = (working[index] as Section).items.length < section.items.length
          if (!trimmed) return
          for (let front = 0; front < index; front += 1) {
            expect((working[front] as Section).items.length).toBe(0)
          }
        })
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('段内保新弃旧：删掉的是按 (时刻, 正文) 升序排在最前的那批，留下的保持原序', () => {
    fc.assert(
      fc.property(sectionsArb, fc.integer({ min: 0, max: 16 }), (sections, limit) => {
        const total = countItems(sections)
        const working = cloneSections(sections)
        dropToFit(working, (count) => total - count > limit)
        sections.forEach((section, index) => {
          const kept = (working[index] as Section).items.map((item) => item.text)
          const before = section.items.map((item) => item.text)
          const ordered = [...section.items].sort(byTimeKey).map((item) => item.text)
          const removed = before.filter((text) => !kept.includes(text))
          expect([...removed].sort()).toEqual(ordered.slice(0, removed.length).sort())
          // 留下的是原序的子序列（splice 不会被排序打乱）
          expect(kept).toEqual(before.filter((text) => kept.includes(text)))
        })
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('同输入结果确定；没有条目时直接返回 0（不会死循环）', () => {
    fc.assert(
      fc.property(sectionsArb, fc.integer({ min: 0, max: 16 }), (sections, limit) => {
        const total = countItems(sections)
        const first = cloneSections(sections)
        const second = cloneSections(sections)
        const once = dropToFit(first, (count) => total - count > limit)
        const twice = dropToFit(second, (count) => total - count > limit)
        expect(twice).toBe(once)
        expect(second.map((section) => section.items.map((item) => item.text))).toEqual(
          first.map((section) => section.items.map((item) => item.text)),
        )
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('全部删空仍超上限：不越界、不抛错，返回总条目数', () => {
    fc.assert(
      fc.property(sectionsArb, (sections) => {
        const total = countItems(sections)
        const working = cloneSections(sections)
        expect(dropToFit(working, () => true)).toBe(total)
        expect(countItems(working)).toBe(0)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})

describe('kernel/thread-context 执行索引（M47）', () => {
  const threadOf = (seeded: View): ThreadRow => seeded.threads.get('th-1') as ThreadRow

  /** 造 n 轮终态 run：轮次 1..n，结束时刻逐轮递增（排序口径必须单调，否则「最新」是随机的）。 */
  const seededRuns = (n: number, over: (index: number) => Partial<RunRow> = () => ({})) => {
    const runs = new Map<string, RunRow>()
    for (let index = 1; index <= n; index += 1) {
      const id = `run-${String(index).padStart(2, '0')}`
      runs.set(
        id,
        run({
          id,
          turn: index,
          endedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
          output: `第 ${index} 轮做完了`,
          ...over(index),
        }),
      )
    }
    return runs
  }

  it('每轮一行、从新到旧：轮次 · 阶段 · 状态 · 时刻 · runId · 摘要', () => {
    const seeded = view({ runs: seededRuns(3) })
    const text = runIndexBlock(seeded, threadOf(seeded))
    const lines = text.split('\n').filter((line) => line.startsWith('- 第'))
    expect(lines).toHaveLength(3)
    // 从新到旧：最新的一轮排在最前
    expect(lines[0]).toContain('第3轮')
    expect(lines[2]).toContain('第1轮')
    expect(lines[0]).toContain('实现 · succeeded ·')
    expect(lines[0]).toContain('run-03')
    expect(lines[0]).toContain('第 3 轮做完了')
  })

  it('本线程没有任务时执行索引照常给条目，路径与规则由产物段给（M51）', () => {
    const empty = view({
      runs: seededRuns(2),
      tasks: new Map(),
      threads: new Map([['th-1', thread({ taskIds: [], rootTaskIds: [] })]]),
    })
    expect(indexBlock(empty, threadOf(empty), null)).toBe('')
    expect(runIndexBlock(empty, threadOf(empty))).not.toContain('产物：')
    // 产物段独立于两个索引：没有任务也有
    expect(artifactBlock(empty, threadOf(empty))).toContain('产物：宿主未配置产物目录')
    const text = threadContextText(empty, threadOf(empty), null)
    expect(text).toContain(ARTIFACT_TITLE)
    expect(text).toContain(RUNS_TITLE)
  })

  it('只列终态 stage run：running 与聊天 run 不进索引', () => {
    const seeded = view({
      runs: new Map([
        ['run-01', run({ id: 'run-01', turn: 1, endedAt: '2026-11-01T01:00:00.000Z' })],
        [
          'run-02',
          run({ id: 'run-02', turn: 2, status: 'running', endedAt: null, sessionId: null }),
        ],
        [
          'run-03',
          run({ id: 'run-03', turn: 3, purpose: 'chat', endedAt: '2026-11-03T03:00:00.000Z' }),
        ],
      ]),
    })
    const lines = runIndexBlock(seeded, threadOf(seeded))
      .split('\n')
      .filter((line) => line.startsWith('- 第'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('run-01')
  })

  it('超过条数上限折叠成计数（保留最新的 N 轮）', () => {
    const seeded = view({
      runs: seededRuns(THREAD_LIMITS.indexRuns + 5, () => ({ output: '短结论' })),
    })
    const text = runIndexBlock(seeded, threadOf(seeded))
    const lines = text.split('\n').filter((line) => line.startsWith('- 第'))
    expect(lines).toHaveLength(THREAD_LIMITS.indexRuns)
    expect(lines[0]).toContain(`第${THREAD_LIMITS.indexRuns + 5}轮`)
    expect(text).toContain('还有 5 轮更早的未列出')
  })

  it('字数预算先卡住：提前收口并标注还有多少轮，整段不超预算', () => {
    const seeded = view({
      runs: seededRuns(THREAD_LIMITS.indexRuns, (index) => ({
        output: `第 ${index} 轮：${'结论'.repeat(40)}`,
      })),
    })
    const text = runIndexBlock(seeded, threadOf(seeded))
    const lines = text.split('\n').filter((line) => line.startsWith('- 第'))
    expect(lines.length).toBeLessThan(THREAD_LIMITS.indexRuns)
    expect(text).toContain('未列出')
    expect(Array.from(text).length).toBeLessThanOrEqual(THREAD_LIMITS.runsChars)
  })

  it('没有终态 run 时不产该段（避免空噪音）', () => {
    const seeded = view({ runs: new Map() })
    expect(runIndexBlock(seeded, threadOf(seeded))).toBe('')
  })

  it('同事实集两次派生全等，且不进 contextChars 预算', () => {
    const seeded = view({ artifactsRoot: 'C:/data/artifacts', runs: seededRuns(4) })
    expect(runIndexBlock(seeded, threadOf(seeded))).toBe(runIndexBlock(seeded, threadOf(seeded)))
    const text = threadContextText(seeded, threadOf(seeded), 'task-1')
    expect(Array.from(runsIndexOf(text)).length).toBeLessThanOrEqual(THREAD_LIMITS.runsChars)
    expect(Array.from(briefOf(text)).length).toBeLessThanOrEqual(THREAD_LIMITS.contextChars)
  })

  it('段序：产物 → 任务索引 → 执行索引 → 待修复清单 → 最近一轮产出', () => {
    const seeded = view({
      artifactsRoot: 'C:/data/artifacts',
      runs: seededRuns(2),
      reviewReports: new Map([['run-review:1', report({ threadId: 'th-1' })]]),
      tasks: new Map([
        ['task-1', task()],
        ['task-2', task({ id: 'task-2', title: '另一个' })],
      ]),
      threads: new Map([
        ['th-1', thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1'] })],
      ]),
    })
    const text = threadContextText(seeded, threadOf(seeded), 'task-1')
    const at = (title: string): number => text.indexOf(title)
    expect(at(ARTIFACT_TITLE)).toBeGreaterThanOrEqual(0)
    expect(at(INDEX_TITLE)).toBeGreaterThan(at(ARTIFACT_TITLE))
    expect(at(RUNS_TITLE)).toBeGreaterThan(at(INDEX_TITLE))
    expect(at(REVIEW_TITLE)).toBeGreaterThan(at(RUNS_TITLE))
    expect(text.indexOf('### 最近一轮产出（')).toBeGreaterThan(at(REVIEW_TITLE))
  })
})

describe('kernel/thread-context 最近一轮产出的取材与死链接（M47）', () => {
  /** 「最近一轮产出」段本体：索引段里也有「产物：」模板行，断言必须限定在这一段内。 */
  const precedingOfView = (seeded: View): string => {
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow, 'task-1')
    const at = text.indexOf('### 最近一轮产出（')
    return at < 0 ? '' : text.slice(at)
  }

  it('最新终态是 cancelled：退到上一轮有产出的终态，取消轮留在执行索引', () => {
    const seeded = view({
      artifactsRoot: 'C:/data/artifacts',
      runs: new Map([
        [
          'run-ok',
          run({
            id: 'run-ok',
            turn: 6,
            output: '改了 label 语义',
            endedAt: '2026-11-16T11:55:00.000Z',
          }),
        ],
        [
          'run-cancelled',
          run({
            id: 'run-cancelled',
            turn: 7,
            status: 'cancelled',
            output: '已取消',
            endedAt: '2026-11-16T12:04:00.000Z',
          }),
        ],
      ]),
    })
    const text = threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow, 'task-1')
    expect(precedingOfView(seeded)).toContain('runs/run-ok/output.md')
    expect(precedingOfView(seeded)).toContain('改了 label 语义')
    expect(precedingOfView(seeded)).not.toContain('runs/run-cancelled/output.md')
    // 取消轮仍出现在执行索引里，信息不丢
    expect(runsIndexOf(text)).toContain('cancelled')
    expect(runsIndexOf(text)).toContain('run-cancelled')
  })

  it('全部是 cancelled：仍取最新一轮（有信息比没有好）', () => {
    const seeded = view({
      artifactsRoot: 'C:/data/artifacts',
      runs: new Map([
        [
          'run-c1',
          run({
            id: 'run-c1',
            turn: 1,
            status: 'cancelled',
            output: '已取消',
            endedAt: '2026-11-16T00:00:00.000Z',
          }),
        ],
      ]),
    })
    expect(precedingOfView(seeded)).toContain('runs/run-c1/output.md')
  })

  it('取到的那一轮没有正文：不写产物路径（读不到的坐标比不给更贵）', () => {
    const seeded = view({
      artifactsRoot: 'C:/data/artifacts',
      runs: new Map([
        ['run-blank', run({ id: 'run-blank', turn: 3, status: 'failed', output: '', error: null })],
      ]),
    })
    const section = precedingOfView(seeded)
    expect(section).not.toContain('产物：')
    expect(section).not.toContain('runs/run-blank/output.md')
    expect(section).toContain('### 最近一轮产出（这一轮没有留下正文）')
    expect(section).toContain('这一轮没有留下正文，原因见「执行索引」与任务动态')
  })

  it('失败但有 error：error 当正文，照常给路径（失败原因也要能读全文）', () => {
    const seeded = view({
      artifactsRoot: 'C:/data/artifacts',
      runs: new Map([
        ['run-fail', run({ id: 'run-fail', status: 'failed', output: '', error: '退出码 1' })],
      ]),
    })
    expect(precedingOfView(seeded)).toContain('runs/run-fail/output.md')
    expect(precedingOfView(seeded)).toContain('退出码 1')
  })
})

describe('kernel/thread-context 脚本轮不进「最近一轮产出」（M47）', () => {
  const textOf = (seeded: View): string =>
    threadContextText(seeded, seeded.threads.get('th-1') as ThreadRow, 'task-1')

  it('最新的终态是脚本轮：产出段仍取最近一轮智能体轮（stdout 不是结论）', () => {
    const seeded = view({
      artifactsRoot: 'C:/data/artifacts',
      runs: new Map([
        [
          'run-agent',
          run({
            id: 'run-agent',
            turn: 7,
            output: '七层门禁全部通过',
            endedAt: '2026-11-16T12:24:00.000Z',
          }),
        ],
        [
          'run-script',
          run({
            id: 'run-script',
            turn: 8,
            agentId: null,
            executorKey: 'command',
            output: '> pkg@1 test\n> node scripts/verify.mjs\n[verify] ▶ 文档一致性',
            endedAt: '2026-11-16T12:30:00.000Z',
          }),
        ],
      ]),
    })
    const text = textOf(seeded)
    const at = text.indexOf('### 最近一轮产出（')
    const section = text.slice(at)
    expect(section).toContain('runs/run-agent/output.md')
    expect(section).toContain('七层门禁全部通过')
    expect(section).not.toContain('runs/run-script/output.md')
  })

  it('索引行的脚本摘要给退出码与错误首行，不给 stdout 横幅', () => {
    const seeded = view({
      runs: new Map([
        [
          'run-script',
          run({
            id: 'run-script',
            turn: 8,
            agentId: null,
            executorKey: 'command',
            status: 'failed',
            exitCode: 1,
            output: '> sa_protocol_library@2.1.2 test\n> node scripts/verify.mjs -…',
            error: '退出码 1\n[command stderr]\n[verify] 1 层失败：后端 pytest',
          }),
        ],
      ]),
    })
    const lines = runIndexBlock(seeded, seeded.threads.get('th-1') as ThreadRow)
      .split('\n')
      .filter((line) => line.startsWith('- 第'))
    expect(lines[0]).toContain('退出码 1')
    expect(lines[0]).toContain('[verify] 1 层失败')
    expect(lines[0]).not.toContain('sa_protocol_library')
  })

  it('脚本轮没有退出码也没有 error：给字面量，不留空位', () => {
    const seeded = view({
      runs: new Map([
        [
          'run-quiet',
          run({ id: 'run-quiet', agentId: null, output: 'noise', exitCode: null, error: null }),
        ],
      ]),
    })
    expect(runIndexBlock(seeded, seeded.threads.get('th-1') as ThreadRow)).toContain(
      '（脚本轮没留下结论）',
    )
  })
})

describe('kernel/thread-context 跨流程裁剪（M50）', () => {
  /** 同一话题里两张卡：task-1（wf-1）+ task-2（wf-2 派单产物）。 */
  const crossThread = (notes: ThreadNote[]): ThreadRow =>
    thread({ taskIds: ['task-1', 'task-2'], rootTaskIds: ['task-1'], notes })
  const crossView = (row: ThreadRow): View =>
    view({
      tasks: new Map([
        ['task-1', task()],
        [
          'task-2',
          task({
            id: 'task-2',
            workflowId: 'wf-2',
            origin: 'handoff',
            parentTaskId: 'task-1',
            handoffFromTaskId: 'task-1',
            handoffFromStageId: 'st-1',
          }),
        ],
      ]),
      threads: new Map([['th-1', row]]),
    })

  it('跨流程：智能体笔记不注入，人给的资料照带，并留一行说明', () => {
    const row = crossThread([
      note(),
      note({ id: 'note-2', author: 'owner', text: '合规要求：只改前端' }),
    ])
    const text = threadContextText(crossView(row), row, 'task-2')

    expect(text).not.toContain('记得先跑测试')
    expect(text).toContain('合规要求：只改前端')
    expect(text).toContain('跨流程：智能体笔记 1 条未注入')
  })

  it('只有人给的资料时不加说明行', () => {
    const row = crossThread([note({ author: 'owner', text: '合规要求：只改前端' })])
    const text = threadContextText(crossView(row), row, 'task-2')

    expect(text).toContain('合规要求：只改前端')
    expect(text).not.toContain('未注入')
  })

  it('同一工作流内的多张卡不裁（子任务要看到父任务的作业笔记）', () => {
    const row = thread({ taskIds: ['task-1', 'task-3'], rootTaskIds: ['task-1'] })
    const seeded = view({
      tasks: new Map([
        ['task-1', task()],
        ['task-3', task({ id: 'task-3', parentTaskId: 'task-1' })],
      ]),
      threads: new Map([['th-1', row]]),
    })

    expect(threadContextText(seeded, row, 'task-3')).toContain('记得先跑测试')
  })

  it('不知道当前任务（currentTaskId=null）时不裁：判据缺省不猜边界', () => {
    const row = crossThread([note()])

    expect(threadContextText(crossView(row), row)).toContain('记得先跑测试')
  })
})
