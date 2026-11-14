// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Fact } from '../../src/kernel/core/types'
import { noticesFromFacts, SETTLEMENT_NOTICE_BODY } from '../../src/host/notices'

const AT = '2026-01-01T00:00:00.000Z'

/** 智能体 / 宿主推进的完成（该弹通知） */
const completed = (taskId: string, title: string, seq = 1): Fact =>
  ({
    type: 'task.completed',
    actor: { kind: 'host', via: 'scheduler' },
    at: AT,
    seq,
    payload: { task: { id: taskId, title } },
  }) as unknown as Fact

/** 人自己点的完成（不该弹） */
const completedByOwner = (taskId: string, title: string, seq = 1): Fact =>
  ({
    type: 'task.completed',
    actor: { kind: 'owner', via: 'ui' },
    at: AT,
    seq,
    payload: { task: { id: taskId, title } },
  }) as unknown as Fact

/** 终态失败：`taskId === null` 表示聊天轮次 */
const failed = (taskId: string | null, seq = 1): Fact =>
  ({
    type: 'run.failed',
    actor: { kind: 'host', via: 'scheduler' },
    at: AT,
    seq,
    payload: { run: { id: `run-${seq}`, taskId } },
  }) as unknown as Fact

const unrelated = (seq = 1): Fact =>
  ({
    type: 'task.created',
    actor: { kind: 'owner', via: 'ui' },
    at: AT,
    seq,
    payload: { task: { id: 't-x', title: '无关事实' } },
  }) as unknown as Fact

describe('noticesFromFacts：结局通知（M12）', () => {
  it('宿主 / 智能体推进的完成：一条「任务完成：标题」+ 任务落点，正文是固定指引', () => {
    expect(noticesFromFacts([completed('t1', '写文档')])).toEqual([
      {
        title: '任务完成：写文档',
        body: SETTLEMENT_NOTICE_BODY.completed,
        target: { taskId: 't1' },
      },
    ])
  })

  it('人自己在 UI 里点的完成不打扰', () => {
    expect(noticesFromFacts([completedByOwner('t1', '写文档')])).toEqual([])
  })

  it('同一任务在一批里被级联多次完成：只留一条', () => {
    expect(
      noticesFromFacts([completed('t1', '写文档', 1), completed('t1', '写文档', 2)]),
    ).toHaveLength(1)
  })

  it('两个任务完成：各弹一条并各自带自己的落点，按事实顺序', () => {
    const notices = noticesFromFacts([completed('t1', 'A', 1), completed('t2', 'B', 2)])

    expect(notices.map((n) => n.title)).toEqual(['任务完成：A', '任务完成：B'])
    expect(notices.map((n) => n.target?.taskId)).toEqual(['t1', 't2'])
  })

  it('单个任务运行失败：一条 + 该任务落点，正文是固定指引', () => {
    expect(noticesFromFacts([failed('t1')])).toEqual([
      {
        title: '任务运行失败',
        body: SETTLEMENT_NOTICE_BODY.failed,
        target: { taskId: 't1' },
      },
    ])
  })

  it('聊天轮次失败（taskId 为 null）不弹系统通知', () => {
    expect(noticesFromFacts([failed(null)])).toEqual([])
  })

  it('同一任务重试失败多次：只算一次，落点仍是这个任务', () => {
    const notices = noticesFromFacts([failed('t1', 1), failed('t1', 2)])

    expect(notices.map((n) => n.title)).toEqual(['任务运行失败'])
    expect(notices[0]?.target).toEqual({ taskId: 't1' })
  })

  it('多个任务同时失败：合成一条并在标题里带数量，且不挂落点（没有单一落点）', () => {
    const notices = noticesFromFacts([failed('t1', 1), failed('t2', 2), failed('t3', 3)])

    expect(notices.map((n) => n.title)).toEqual(['任务运行失败（3 个）'])
    // 跳到哪个任务都是猜：宁可不跳，也不随机挑一个
    expect(notices[0]).not.toHaveProperty('target')
  })

  it('完成 + 失败混合：完成在前（按事实顺序），失败聚合在后，各自带落点', () => {
    const notices = noticesFromFacts([completed('t1', 'A', 1), failed('t2', 2)])

    expect(notices.map((n) => n.title)).toEqual(['任务完成：A', '任务运行失败'])
    expect(notices.map((n) => n.target?.taskId)).toEqual(['t1', 't2'])
  })

  it('无关事实与空批次都不产生通知', () => {
    expect(noticesFromFacts([unrelated()])).toEqual([])
    expect(noticesFromFacts([])).toEqual([])
  })
})
