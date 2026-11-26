// @vitest-environment node
/**
 * 线程收尾（`scopes/threads.ts`）的三条边缘臂：阶段语义缺阶段、本批事实属于别的线程、
 * 任务行已被删（既不在视图里，也本批删掉）。
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@workbench/protocol/entities'
import type { ThreadRow } from '@workbench/protocol/thread'
import {
  batchTaskPhases,
  closeIfAllDone,
  phaseOf,
  threadWithBatchTasks,
} from '@workbench/kernel/scopes/threads'
import type { FactDraft, View } from '@workbench/kernel/core/types'

const CREATED = '2026-11-20T09:00:00.000Z'
const NOW = '2026-11-24T09:00:00.000Z'

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
  threadId: 'th-1',
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'th-1',
  source: 'manual',
  externalRef: null,
  title: '话题',
  status: 'open',
  taskIds: ['t-1'],
  rootTaskIds: ['t-1'],
  concurrency: 1,
  notesVersion: 0,
  notes: [],
  events: [],
  lastActivityAt: CREATED,
  createdAt: CREATED,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 6,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map([[task().id, task()]]),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  threads: new Map([[thread().id, thread()]]),
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
  activeTaskIds: new Set(),
  ...over,
})

const draft = (type: string, payload: Record<string, unknown>): FactDraft =>
  ({ type, actor: { kind: 'kernel' }, at: NOW, payload }) as unknown as FactDraft

describe('phaseOf：没有当前阶段按「未开始」', () => {
  it('阶段查不到时是 todo，不是结束', () => {
    expect(phaseOf(view(), task({ currentStageId: null }))).toBe('todo')
  })
})

describe('threadWithBatchTasks：只认本线程的事实', () => {
  it('线程缺省时原样返回 undefined', () => {
    expect(
      threadWithBatchTasks(undefined, [draft('thread.task_attached', { thread: thread() })]),
    ).toBe(undefined)
  })

  it('事实属于别的线程：不改写（避免把别人的任务清单套过来）', () => {
    const own = thread()
    const other = thread({ id: 'th-2', taskIds: ['t-9'] })
    expect(threadWithBatchTasks(own, [draft('thread.task_attached', { thread: other })])).toBe(own)
  })
})

describe('batchTaskPhases：本批删掉的任务记成 removed', () => {
  it('task.removed 落进覆盖表，交给结束判定当「已走完」', () => {
    const phases = batchTaskPhases(view(), [
      draft('task.removed', { task: task({ id: 't-gone' }) }),
    ])
    expect(phases.get('t-gone')).toBe('removed')
  })
})

describe('batchTaskPhases：完成与取消的相位不能混（M53 口径）', () => {
  it('outcome=done → finished；outcome=cancelled → cancelled（取消不当完成）', () => {
    const phases = batchTaskPhases(view(), [
      draft('task.finished', { task: task({ id: 't-done' }), outcome: 'done' }),
      draft('task.finished', { task: task({ id: 't-cancel' }), outcome: 'cancelled' }),
    ])
    // 今天的两个消费者（父任务 rollup 覆盖表、线程收口）都只问 isTaskOver，两个相位都为真，
    // 所以「取消被记成完成」不会在这两处显形；相位本身是给下一个消费者的口径——记错就是
    // 看板把「已取消」显示成「已完成」。断言就落在这个口径上，变异（恒返回 finished）必红。
    expect(phases.get('t-done')).toBe('finished')
    expect(phases.get('t-cancel')).toBe('cancelled')
  })
})

describe('closeIfAllDone：任务行已被删光', () => {
  it('线程里记着的任务在视图里都没有：视为走完，归档线程', () => {
    const facts = closeIfAllDone(view({ tasks: new Map() }), thread({ taskIds: ['t-gone'] }), NOW, {
      kind: 'host',
      via: 'timer',
    })
    expect(facts).toHaveLength(1)
    expect(facts[0]!.type).toBe('thread.closed')
    expect((facts[0]!.payload as { reason: string }).reason).toBe('all-tasks-done')
  })

  it('还有一个没结束的任务：不归档', () => {
    const facts = closeIfAllDone(view({ stages: new Map() }), thread(), NOW, {
      kind: 'host',
      via: 'timer',
    })
    expect(facts).toEqual([])
  })
})
