// @vitest-environment node
/**
 * 时间线的实体归属（`scopes/timeline.ts`）：哪些事实挂在项目 / 任务上，哪些只在 cause 链上。
 *
 * 只钉此前没走到的几支：项目三件套、准入结论（不挂实体）、阶段错误（挂任务）。
 */
import { describe, expect, it } from 'vitest'
import { timeline } from '@workbench/kernel/scopes/timeline'
import type { Fact } from '@workbench/kernel/core/types'

const AT = '2026-11-24T09:00:00.000Z'
const ACTOR = { kind: 'kernel' } as const

const fact = (seq: number, type: string, payload: Record<string, unknown>): Fact =>
  ({ seq, type, actor: ACTOR, at: AT, payload }) as unknown as Fact

describe('timeline：项目事实归项目时间线', () => {
  it('创建 / 更新 / 删除都归到同一个项目', () => {
    const facts = [
      fact(1, 'project.created', { project: { id: 'p-1' } }),
      fact(2, 'project.updated', { project: { id: 'p-1' } }),
      fact(3, 'project.removed', { project: { id: 'p-1' } }),
    ]
    expect(timeline(facts, 'project', 'p-1').map((entry) => entry.fact.seq)).toEqual([1, 2, 3])
    expect(timeline(facts, 'project', 'p-2')).toEqual([])
  })
})

describe('timeline：准入结论不挂业务实体', () => {
  it('admitted / denied 不产出任何 scope 引用（只出现在 cause 链上）', () => {
    const facts = [
      fact(1, 'event.admitted', { eventId: 'evt-1', source: 'github' }),
      fact(2, 'event.denied', { eventId: 'evt-2', reason: 'not-listed' }),
    ]
    expect(timeline(facts, 'task', 't-1')).toEqual([])
    expect(timeline(facts, 'run', 'r-1')).toEqual([])
  })
})

describe('timeline：阶段错误归到任务', () => {
  it('按 payload.task.id 命中，并沿 cause 串上前置事实', () => {
    const facts = [
      fact(1, 'task.created', { task: { id: 't-1' } }),
      fact(3, 'stage.errored', {
        task: { id: 't-1' },
        stage: 'st-1',
        stageName: '评审',
        reason: 'stalled',
        reportId: null,
        findings: [],
      }),
    ]
    const chained = facts.map((item) => (item.seq === 3 ? { ...item, cause: 1 } : item))
    expect(timeline(chained, 'task', 't-1').map((entry) => entry.fact.seq)).toEqual([1, 3])
  })
})
