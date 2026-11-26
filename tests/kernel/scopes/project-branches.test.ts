// @vitest-environment node
/**
 * 投影归一与「只审计」的事实（`scopes/project.ts`）的边缘臂。
 *
 * 两块：老事实 replay 的默认值（缺字段的历史行不能让投影列写 undefined），以及
 * `event.admitted` / `event.denied` / `stage.errored` 这类**不写表**的审计事实。
 */
import { describe, expect, it } from 'vitest'
import type { Card, Task, WorkflowStage } from '@workbench/protocol/entities'
import { normalizeCard, normalizeTask, project } from '@workbench/kernel/scopes/project'
import type { Fact } from '@workbench/kernel/core/types'

const AT = '2026-11-24T09:00:00.000Z'
const ACTOR = { kind: 'kernel' } as const

/** 老事实里的任务行：只带当年有的列。 */
const legacyTask = (over: Record<string, unknown> = {}): Task =>
  ({
    id: 't-1',
    title: '任务',
    workflowId: 'wf-1',
    currentStageId: 'st-1',
    ...over,
  }) as unknown as Task

const legacyStage = (over: Record<string, unknown> = {}): WorkflowStage =>
  ({
    id: 'st-1',
    workflowId: 'wf-1',
    name: '评审',
    position: 0,
    entryMode: 'agent',
    agentId: 'ag-1',
    judge: { maxFails: 2 },
    ...over,
  }) as unknown as WorkflowStage

const legacyCard = (over: Record<string, unknown> = {}): Card =>
  ({ id: 'card-1', runId: 'run-1', taskId: 't-1', options: [], ...over }) as unknown as Card

const fact = (type: string, payload: Record<string, unknown>): Fact =>
  ({ seq: 1, type, actor: ACTOR, at: AT, payload }) as unknown as Fact

describe('normalizeTask：老行没有归档时刻', () => {
  it('老口径 completed：归档时刻取补记的时刻', () => {
    expect(normalizeTask(legacyTask({ status: 'completed' }), AT).archivedAt).toBe(AT)
  })

  it('老口径 completed 但没给补记时刻：按「仍在追踪」归一（不编时刻）', () => {
    expect(normalizeTask(legacyTask({ status: 'completed' })).archivedAt).toBeNull()
  })

  it('老口径 active / 已经有归档列：不覆盖', () => {
    expect(normalizeTask(legacyTask({ status: 'active' }), AT).archivedAt).toBeNull()
    expect(
      normalizeTask(legacyTask({ archivedAt: AT }), '2026-12-01T00:00:00.000Z').archivedAt,
    ).toBe(AT)
  })
})

describe('normalizeStage（经 stage.updated 投影）：缺字段补默认值', () => {
  const normalized = (over: Record<string, unknown> = {}): WorkflowStage => {
    const [change] = project(fact('stage.updated', { stage: legacyStage(over) }))
    return change!.row as WorkflowStage
  }

  it('没有 instructions / acceptance / notifyOnPark：补空串、空清单、不喊人', () => {
    const stage = normalized()
    expect(stage.instructions).toBe('')
    expect(stage.acceptance).toEqual([])
    expect(stage.notifyOnPark).toBe(false)
  })

  it('非闸门阶段：老行里残留的验收条目作废（配了也不生效）', () => {
    expect(normalized({ judge: null, acceptance: ['跑通'] }).acceptance).toEqual([])
  })

  it('内置阶段恒不喊人（哪怕老行写着要喊）', () => {
    expect(normalized({ builtin: 'blocked', notifyOnPark: true }).notifyOnPark).toBe(false)
  })
})

describe('normalizeCard：老行没有投递账与回答人', () => {
  it('缺投递三列 / 按通道记录 / 回答人引用：归一成空账', () => {
    const card = normalizeCard(legacyCard())
    expect(card.kind).toBe('notice')
    expect(card.deliveryAttempts).toBe(0)
    expect(card.nextDeliveryAt).toBeNull()
    expect(card.deliveryRefs).toEqual({})
    expect(card.answeredByRef).toBeNull()
  })

  it('信息卡（options 为空）按 notice 归一；问答卡保留 kind', () => {
    expect(normalizeCard(legacyCard({ options: ['好'] })).kind).toBe('ask')
    expect(normalizeCard(legacyCard({ kind: 'stall' })).kind).toBe('stall')
  })

  it('不挂 run 的卡：runId 空串 / 缺字段一律折成 null（写 NULL 才满足 cards 的外键）', () => {
    expect(normalizeCard(legacyCard({ runId: '' })).runId).toBeNull()
    expect(normalizeCard(legacyCard({ runId: undefined })).runId).toBeNull()
    // 正常的卡原样保留，不要顺手把 run 归属抹掉
    expect(normalizeCard(legacyCard({ runId: 'run-1' })).runId).toBe('run-1')
  })
})

describe('project：只作审计的事实不写表', () => {
  it('准入结论（admitted / denied）零变更', () => {
    expect(project(fact('event.admitted', { eventId: 'evt-1', source: 'github' }))).toEqual([])
    expect(project(fact('event.denied', { eventId: 'evt-1', reason: 'not-listed' }))).toEqual([])
  })

  it('阶段错误零变更（任务行由同批 task.moved 落）', () => {
    expect(
      project(
        fact('stage.errored', {
          task: legacyTask(),
          stage: 'st-1',
          stageName: '评审',
          reason: 'stalled',
          reportId: null,
          findings: [],
        }),
      ),
    ).toEqual([])
  })

  it('thread.removed 只删线程行', () => {
    expect(project(fact('thread.removed', { thread: { id: 'th-1' } }))).toEqual([
      { table: 'threads', key: 'th-1', row: null },
    ])
  })
})
