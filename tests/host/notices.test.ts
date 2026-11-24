// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Fact } from '@workbench/kernel/core/types'
import { noticesFromFacts, SETTLEMENT_NOTICE_BODY } from '@workbench/host/notices'

const AT = '2026-01-01T00:00:00.000Z'

/** 智能体 / 宿主推进的完成（该弹通知） */
const completed = (taskId: string, title: string, seq = 1): Fact =>
  ({
    type: 'task.finished',
    actor: { kind: 'host', via: 'scheduler' },
    at: AT,
    seq,
    payload: { task: { id: taskId, title }, outcome: 'done' },
  }) as unknown as Fact

/** 智能体 / 宿主把任务移进内置「已取消」（M53：也是结束，但话不能说成「完成」） */
const cancelled = (taskId: string, title: string, seq = 1): Fact =>
  ({
    type: 'task.finished',
    actor: { kind: 'host', via: 'scheduler' },
    at: AT,
    seq,
    payload: { task: { id: taskId, title }, outcome: 'cancelled' },
  }) as unknown as Fact

/** 人自己点的完成（不该弹） */
const completedByOwner = (taskId: string, title: string, seq = 1): Fact =>
  ({
    type: 'task.finished',
    actor: { kind: 'owner', via: 'ui' },
    at: AT,
    seq,
    payload: { task: { id: taskId, title }, outcome: 'done' },
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

  it('移到「已取消」：说「任务已取消」，不把取消说成完成（M53）', () => {
    expect(noticesFromFacts([cancelled('t1', '写文档')])).toEqual([
      {
        title: '任务已取消：写文档',
        body: SETTLEMENT_NOTICE_BODY.cancelled,
        target: { taskId: 't1' },
      },
    ])
  })

  it('同批里完成与取消各一条，按事实顺序', () => {
    const notices = noticesFromFacts([completed('t1', 'A', 1), cancelled('t2', 'B', 2)])

    expect(notices.map((n) => n.title)).toEqual(['任务完成：A', '任务已取消：B'])
    expect(notices.map((n) => n.body)).toEqual([
      SETTLEMENT_NOTICE_BODY.completed,
      SETTLEMENT_NOTICE_BODY.cancelled,
    ])
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

/**
 * M55：阶段走不动（`stage.errored`）必须弹——这条路径以前只留一条任务评论，
 * 任务在界面上静默挂着，人得自己发现（2026-11-24 任务 `8b76d466`）。
 */
describe('noticesFromFacts · 停机待接手（M55）', () => {
  const errored = (taskId: string, title: string, seq = 1): Fact =>
    ({
      type: 'stage.errored',
      actor: { kind: 'host', via: 'scheduler' },
      at: AT,
      seq,
      payload: {
        task: { id: taskId, title },
        stage: 'st-fix',
        stageName: '修复',
        reason: 'review_unaddressed',
        reportId: 'run-review:3',
        findings: ['run-review:3#R6'],
      },
    }) as unknown as Fact

  const erroredByOwner = (taskId: string, title: string): Fact =>
    ({
      ...(errored(taskId, title) as unknown as { payload: unknown; type: string }),
      type: 'stage.errored',
      actor: { kind: 'owner', via: 'ui' },
    }) as unknown as Fact

  it('停机 → 一条带任务落点的通知（标题带任务名）', () => {
    const notices = noticesFromFacts([errored('t1', '地空协议配置')])
    expect(notices).toHaveLength(1)
    expect(notices[0]?.title).toBe('任务停机待接手：地空协议配置')
    expect(notices[0]?.target?.taskId).toBe('t1')
  })

  it('同一任务在一批里多次停机：只弹一次', () => {
    expect(noticesFromFacts([errored('t1', 'A', 1), errored('t1', 'A', 2)])).toHaveLength(1)
  })

  it('人自己拖出来的阻塞不打扰', () => {
    expect(noticesFromFacts([erroredByOwner('t1', 'A')])).toEqual([])
  })

  it('完成 + 停机 + 失败混在同一批：三条，各有落点', () => {
    const notices = noticesFromFacts([
      completed('t1', 'A', 1),
      errored('t2', 'B', 2),
      failed('t3', 3),
    ])
    expect(notices.map((n) => n.title)).toEqual([
      '任务完成：A',
      '任务停机待接手：B',
      '任务运行失败',
    ])
    expect(notices.map((n) => n.target?.taskId)).toEqual(['t1', 't2', 't3'])
  })
})
