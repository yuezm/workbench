// @vitest-environment node
/**
 * 事实 → 时间线归属的全表（行为层，补 `tests/architecture.test.ts` 的静态检查）。
 *
 * `architecture.test.ts` 只证明「timeline.ts 里有每个事实类型的 case 标签」——那是对源码
 * 文本的检查，把 `case 'run.succeeded':` 改成 `case '':` 它一个字都看不出来。变异测试正是
 * 这么暴露的：timeline.ts 里大半 `case` 的字符串字面量被替换成空串后测试全绿。
 *
 * 这里给每个事实类型喂一条最小事实，断言它命中哪些实体范围。新增事实类型而忘了在图里
 * 表态，第一条用例就红。
 */
import { describe, expect, it } from 'vitest'
import type { FactPayload, FactType } from '@workbench/protocol/facts'
import { FACT_TYPES } from '@workbench/protocol/facts'
import { IMPORT_ROOT_LABEL, timeline, type TimelineScope } from '@workbench/kernel/scopes/timeline'
import type { Fact } from '@workbench/kernel/core/types'

const AT = '2026-11-04T12:00:00.000Z'

/** 期望命中的实体引用（`refsOf` 只读这些字段，payload 因此可以是最小形状）。 */
type Refs = [TimelineScope, string][]

interface Sample {
  type: FactType
  payload: unknown
  refs: Refs
}

const NOBODY: Refs = []

const SAMPLES: Sample[] = [
  // —— 工作流 / 阶段 ——
  { type: 'workflow.created', payload: { workflow: { id: 'wf-1' } }, refs: [['workflow', 'wf-1']] },
  { type: 'workflow.updated', payload: { workflow: { id: 'wf-1' } }, refs: [['workflow', 'wf-1']] },
  { type: 'workflow.removed', payload: { workflow: { id: 'wf-1' } }, refs: [['workflow', 'wf-1']] },
  { type: 'stage.created', payload: { stage: { id: 'st-1' } }, refs: [['stage', 'st-1']] },
  { type: 'stage.updated', payload: { stage: { id: 'st-1' } }, refs: [['stage', 'st-1']] },
  { type: 'stage.deleted', payload: { stage: { id: 'st-1' } }, refs: [['stage', 'st-1']] },
  // —— 智能体 / 运行时 ——
  { type: 'agent.created', payload: { agent: { id: 'ag-1' } }, refs: [['agent', 'ag-1']] },
  { type: 'agent.updated', payload: { agent: { id: 'ag-1' } }, refs: [['agent', 'ag-1']] },
  { type: 'agent.removed', payload: { agent: { id: 'ag-1' } }, refs: [['agent', 'ag-1']] },
  { type: 'runtime.created', payload: { runtime: { id: 'rt-1' } }, refs: [['runtime', 'rt-1']] },
  { type: 'runtime.updated', payload: { runtime: { id: 'rt-1' } }, refs: [['runtime', 'rt-1']] },
  { type: 'runtime.removed', payload: { runtime: { id: 'rt-1' } }, refs: [['runtime', 'rt-1']] },
  { type: 'runtime.probed', payload: { runtime: { id: 'rt-1' } }, refs: [['runtime', 'rt-1']] },
  // —— 项目 ——
  { type: 'project.created', payload: { project: { id: 'pj-1' } }, refs: [['project', 'pj-1']] },
  { type: 'project.updated', payload: { project: { id: 'pj-1' } }, refs: [['project', 'pj-1']] },
  { type: 'project.removed', payload: { project: { id: 'pj-1' } }, refs: [['project', 'pj-1']] },
  // —— 任务 ——
  { type: 'task.created', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'task.updated', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'task.moved', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'task.finished', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'task.archived', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'task.completed', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'task.removed', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  // 评论行自带 taskId，任务 id 不在 `payload.task` 上
  {
    type: 'task.comment_added',
    payload: { comment: { taskId: 'tk-1' } },
    refs: [['task', 'tk-1']],
  },
  { type: 'task.children_settled', payload: { parentTaskId: 'tk-1' }, refs: [['task', 'tk-1']] },
  // —— 运行：状态事实带整行，帧 / 审计 / 删除只带 runId ——
  ...(
    [
      'run.queued',
      'run.claimed',
      'run.lease_extended',
      'run.waiting',
      'run.abandoned',
      'run.succeeded',
      'run.failed',
      'run.cancelled',
      'run.usage',
      'run.cancel_requested',
    ] as const
  ).map((type): Sample => ({ type, payload: { run: { id: 'run-1' } }, refs: [['run', 'run-1']] })),
  ...(['run.frames', 'run.receipt_rejected', 'run.removed'] as const).map((type): Sample => ({
    type,
    payload: { runId: 'run-1' },
    refs: [['run', 'run-1']],
  })),
  // —— 卡片：同时归到卡片与它所属的 run ——
  ...(
    [
      'card.opened',
      'card.updated',
      'card.delivered',
      'card.delivery_failed',
      'card.answered',
      'card.resolved',
    ] as const
  ).map((type): Sample => ({
    type,
    payload: { card: { id: 'card-1', runId: 'run-1' } },
    refs: [
      ['run', 'run-1'],
      ['card', 'card-1'],
    ],
  })),
  // M57：不挂 run 的卡（进入「会喊人」阶段开的停机卡）只归到卡片本身——它没有「等的那一轮」，
  // 硬塞一个 run id 会让时间线指向不存在或不相干的运行。
  {
    type: 'card.opened',
    payload: { card: { id: 'card-2', runId: null } },
    refs: [['card', 'card-2']],
  },
  // —— 事件：派生事件挂父 run，其余只在 cause 链上出现 ——
  { type: 'event.received', payload: { originRunId: 'run-1' }, refs: [['run', 'run-1']] },
  { type: 'event.merged', payload: { run: { id: 'run-1' } }, refs: [['run', 'run-1']] },
  { type: 'event.dropped', payload: {}, refs: NOBODY },
  { type: 'event.admitted', payload: {}, refs: NOBODY },
  { type: 'event.denied', payload: {}, refs: NOBODY },
  { type: 'event.skipped', payload: {}, refs: NOBODY },
  { type: 'assess.decided', payload: {}, refs: NOBODY },
  // —— 授权 ——
  { type: 'mandate.granted', payload: { mandate: { taskId: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'mandate.revoked', payload: { mandate: { taskId: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'mandate.revalidated', payload: { taskId: 'tk-1' }, refs: [['task', 'tk-1']] },
  // —— 线程 ——
  ...(
    [
      'thread.opened',
      'thread.event_attached',
      'thread.task_attached',
      'thread.note_appended',
      'thread.closed',
      'thread.reopened',
      'thread.bound',
      'thread.removed',
    ] as const
  ).map((type): Sample => ({
    type,
    payload: { thread: { id: 'th-1' } },
    refs: [['thread', 'th-1']],
  })),
  // —— 规则 / 插件：没有独立 scope ——
  { type: 'rules.replaced', payload: {}, refs: NOBODY },
  { type: 'rule.fired', payload: {}, refs: NOBODY },
  { type: 'rule.replayed', payload: { taskId: 'tk-1' }, refs: [['task', 'tk-1']] },
  { type: 'plugins.replaced', payload: {}, refs: NOBODY },
  // —— 评审 / 阶段错误：归到任务 ——
  { type: 'review.reported', payload: { report: { taskId: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'review.addressed', payload: { report: { taskId: 'tk-1' } }, refs: [['task', 'tk-1']] },
  { type: 'stage.errored', payload: { task: { id: 'tk-1' } }, refs: [['task', 'tk-1']] },
  // —— 对话 / 消息 ——
  {
    type: 'conversation.created',
    payload: { conversation: { id: 'cv-1' } },
    refs: [['conversation', 'cv-1']],
  },
  {
    type: 'conversation.updated',
    payload: { conversation: { id: 'cv-1' } },
    refs: [['conversation', 'cv-1']],
  },
  {
    type: 'conversation.removed',
    payload: { conversation: { id: 'cv-1' } },
    refs: [['conversation', 'cv-1']],
  },
  {
    type: 'message.appended',
    payload: { conversationId: 'cv-1', messageId: 'msg-1' },
    refs: [
      ['conversation', 'cv-1'],
      ['message', 'msg-1'],
    ],
  },
  // —— 迁移导入根：按表落到实体范围（`runs` / `run_events` 都归 run） ——
  {
    type: 'snapshot.imported',
    payload: { table: 'tasks', rows: [{ id: 'tk-1' }, { id: 'tk-2' }] },
    refs: [
      ['task', 'tk-1'],
      ['task', 'tk-2'],
    ],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'workflows', rows: [{ id: 'wf-1' }] },
    refs: [['workflow', 'wf-1']],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'workflow_stages', rows: [{ id: 'st-1' }] },
    refs: [['stage', 'st-1']],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'agents', rows: [{ id: 'ag-1' }] },
    refs: [['agent', 'ag-1']],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'runtimes', rows: [{ id: 'rt-1' }] },
    refs: [['runtime', 'rt-1']],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'runs', rows: [{ id: 'run-1' }] },
    refs: [['run', 'run-1']],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'run_events', rows: [{ runId: 'run-1' }] },
    refs: [['run', 'run-1']],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'conversations', rows: [{ id: 'cv-1' }] },
    refs: [['conversation', 'cv-1']],
  },
  {
    type: 'snapshot.imported',
    payload: { table: 'messages', rows: [{ id: 'msg-1', conversationId: 'cv-1' }] },
    refs: [
      ['conversation', 'cv-1'],
      ['message', 'msg-1'],
    ],
  },
]

const factOf = (sample: Sample): Fact => ({
  seq: 1,
  type: sample.type,
  actor: { kind: 'kernel' },
  at: AT,
  payload: sample.payload as FactPayload<FactType>,
})

const ALL_SCOPES: TimelineScope[] = [
  'task',
  'workflow',
  'stage',
  'agent',
  'runtime',
  'project',
  'run',
  'conversation',
  'message',
  'card',
  'thread',
]

describe('事实 → 时间线归属的全表', () => {
  it('每个事实类型都要在图里表态（新增类型忘了写，这条先红）', () => {
    const covered = new Set(SAMPLES.map((sample) => sample.type))
    const missing = FACT_TYPES.filter((type) => !covered.has(type))
    expect(missing, `这些事实类型没有时间线归属样本：${missing.join('、')}`).toEqual([])
  })

  it.each(SAMPLES.filter((sample) => sample.refs.length > 0))(
    '$type 命中它声明的实体范围，别处一律不命中',
    (sample) => {
      const hitScopes = new Set<Refs[number][0]>()
      for (const [scope, id] of sample.refs) {
        expect(
          timeline([factOf(sample)], scope, id).length,
          `${sample.type} → ${scope}/${id}`,
        ).toBe(1)
        hitScopes.add(scope)
      }
      // 声明之外的 scope：用**本条事实自己的 id** 去查（换成不相干的 id 就测不出
      // 「只比 id 不比 scope」这类错），一律不命中。
      for (const scope of ALL_SCOPES) {
        if (hitScopes.has(scope)) continue
        for (const [, id] of sample.refs) {
          expect(
            timeline([factOf(sample)], scope, id).length,
            `${sample.type} 不该命中 ${scope}/${id}`,
          ).toBe(0)
        }
      }
    },
  )

  it.each(SAMPLES.filter((sample) => sample.refs.length === 0))(
    '$type 不归任何实体（只在 cause 链上出现）',
    (sample) => {
      for (const scope of ALL_SCOPES) {
        expect(
          timeline([factOf(sample)], scope, 't-unrelated').length,
          `${sample.type}/${scope}`,
        ).toBe(0)
      }
    },
  )

  it('导入根标注「迁移导入」，其余事实没有标注', () => {
    const importFact = factOf(
      SAMPLES.find((sample) => sample.type === 'snapshot.imported') as Sample,
    )
    // 直接比字面量：比 `IMPORT_ROOT_LABEL` 常量是自证（改坏常量时两边一起错）
    expect(timeline([importFact], 'task', 'tk-1')[0]?.label).toBe('迁移导入')
    expect(IMPORT_ROOT_LABEL).toBe('迁移导入')
    const taskFact = factOf(SAMPLES.find((sample) => sample.type === 'task.created') as Sample)
    expect(timeline([taskFact], 'task', 'tk-1')[0]).toMatchObject({ imported: false, label: null })
  })
})
