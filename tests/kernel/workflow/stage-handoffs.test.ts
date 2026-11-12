/**
 * 派单纯函数用例（M29）：触发条件判定、目标解析、类别豁免、老事实归一、深比较。
 *
 * 只构造 `View` 假数据，不起 DB；产事实与 `decide` 集成的用例见
 * `tests/kernel/handoff.test.ts` 与 `tests/kernel/decide.handoff.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import type { StageHandoff, Workflow, WorkflowStage } from '../../../src/protocol/entities'
import type { View } from '../../../src/kernel/types'
import {
  handoffGuardOf,
  handoffTargetsOf,
  legacyHandoffs,
  sameHandoffs,
} from '../../../src/kernel/workflow/stage-handoffs'

const CREATED = '2026-11-01T00:00:00.000Z'

const workflow = (id: string): Workflow => ({
  id,
  name: id,
  description: '',
  createdAt: CREATED,
})

const stage = (
  id: string,
  workflowId: string,
  position: number,
  over: Partial<WorkflowStage> = {},
): WorkflowStage => ({
  id,
  workflowId,
  name: id,
  position,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffs: [],
  ...over,
})

const view = (stages: WorkflowStage[], workflowIds: string[]): View =>
  ({
    seq: 1,
    workflows: new Map(workflowIds.map((id) => [id, workflow(id)])),
    stages: new Map(stages.map((row) => [row.id, row])),
  }) as unknown as View

/** 两工作流：A（st-a0 / st-a1）与 B（st-b0 / st-b1）。 */
const seeded = (handoffs: StageHandoff[]): View =>
  view(
    [
      stage('st-a0', 'wf-a', 0, { handoffs }),
      stage('st-a1', 'wf-a', 1),
      stage('st-b0', 'wf-b', 0),
      stage('st-b1', 'wf-b', 1),
    ],
    ['wf-a', 'wf-b'],
  )

const handoff = (over: Partial<StageHandoff> = {}): StageHandoff => ({
  on: 'done',
  workflowId: 'wf-b',
  stageId: null,
  ...over,
})

describe('handoffGuardOf 触发条件', () => {
  it('人工拖动与完成任务恒为 manual', () => {
    expect(handoffGuardOf({ gate: null }, { kind: 'manual' })).toBe('manual')
    // 闸门阶段的人工拖动同样是 manual：人拖走就是人定的去向
    expect(
      handoffGuardOf(
        { gate: { maxFails: 3, onPassStageId: null, onFailStageId: null } },
        { kind: 'manual' },
      ),
    ).toBe('manual')
  })

  it('取消不派单', () => {
    expect(handoffGuardOf({ gate: null }, { kind: 'run', status: 'cancelled' })).toBeNull()
  })

  it('执行出错 → errored（与业务过没过无关）', () => {
    expect(handoffGuardOf({ gate: null }, { kind: 'run', status: 'failed' })).toBe('errored')
    // 判定阶段崩了也走 errored：崩了不是「没通过」
    expect(
      handoffGuardOf(
        { gate: { maxFails: 3, onPassStageId: null, onFailStageId: null } },
        { kind: 'run', status: 'failed', verdict: 'fail' },
      ),
    ).toBe('errored')
  })

  it('非判定阶段跑完 → done', () => {
    expect(handoffGuardOf({ gate: null }, { kind: 'run', status: 'succeeded' })).toBe('done')
  })

  it('判定阶段：pass → passed，fail → failed，没给结论 → 不派单', () => {
    const gated = { gate: { maxFails: 3, onPassStageId: null, onFailStageId: null } }

    expect(handoffGuardOf(gated, { kind: 'run', status: 'succeeded', verdict: 'pass' })).toBe(
      'passed',
    )
    expect(handoffGuardOf(gated, { kind: 'run', status: 'succeeded', verdict: 'fail' })).toBe(
      'failed',
    )
    expect(handoffGuardOf(gated, { kind: 'run', status: 'succeeded' })).toBeNull()
  })

  it('闸门预算耗尽放行 → passed（放行也算通过）', () => {
    const gated = { gate: { maxFails: 1, onPassStageId: null, onFailStageId: null } }

    expect(
      handoffGuardOf(gated, {
        kind: 'run',
        status: 'succeeded',
        verdict: 'fail',
        gateExhausted: true,
      }),
    ).toBe('passed')
  })
})

describe('handoffTargetsOf 目标解析', () => {
  it('只取本组触发条件，按配置顺序', () => {
    const handoffs = [handoff(), handoff({ on: 'errored' }), handoff({ stageId: 'st-b1' })]
    const targets = handoffTargetsOf(seeded(handoffs), 'wf-a', { handoffs }, 'done')

    expect(targets).toEqual([
      { workflowId: 'wf-b', stageId: 'st-b0' },
      { workflowId: 'wf-b', stageId: 'st-b1' },
    ])
  })

  it('stageId 为空 → 目标工作流首阶段（按 position）', () => {
    expect(handoffTargetsOf(seeded([]), 'wf-a', { handoffs: [handoff()] }, 'done')).toEqual([
      { workflowId: 'wf-b', stageId: 'st-b0' },
    ])
  })

  it('没配 / 目标是自身 / 目标工作流已删 / 目标工作流没有阶段 → 无目标', () => {
    expect(handoffTargetsOf(seeded([]), 'wf-a', { handoffs: [] }, 'done')).toEqual([])
    expect(
      handoffTargetsOf(seeded([]), 'wf-a', { handoffs: [handoff({ workflowId: 'wf-a' })] }, 'done'),
    ).toEqual([])
    expect(
      handoffTargetsOf(
        seeded([]),
        'wf-a',
        { handoffs: [handoff({ workflowId: 'wf-gone' })] },
        'done',
      ),
    ).toEqual([])

    const noStages = view([stage('st-a0', 'wf-a', 0)], ['wf-a', 'wf-b'])

    expect(handoffTargetsOf(noStages, 'wf-a', { handoffs: [handoff()] }, 'done')).toEqual([])
  })

  it('目标阶段已不属目标工作流（被删 / 错指）→ 跳过该条', () => {
    expect(
      handoffTargetsOf(seeded([]), 'wf-a', { handoffs: [handoff({ stageId: 'st-gone' })] }, 'done'),
    ).toEqual([])
    // 指向本工作流的阶段：不是目标工作流的，同样跳过
    expect(
      handoffTargetsOf(seeded([]), 'wf-a', { handoffs: [handoff({ stageId: 'st-a0' })] }, 'done'),
    ).toEqual([])
  })

  it('manual 的「仅向前」：拖回更前不派单，缺省即向前', () => {
    const manual = {
      handoffs: [handoff({ on: 'manual' }), handoff({ on: 'manual', forwardOnly: false })],
    }

    expect(handoffTargetsOf(seeded([]), 'wf-a', manual, 'manual', { forward: true })).toHaveLength(
      2,
    )
    // 拖回更前：只有显式关掉「仅向前」的那条还派
    expect(handoffTargetsOf(seeded([]), 'wf-a', manual, 'manual', { forward: false })).toHaveLength(
      1,
    )
  })

  it('自动触发不看位置：forward 只对 manual 生效', () => {
    expect(
      handoffTargetsOf(seeded([]), 'wf-a', { handoffs: [handoff()] }, 'done', { forward: false }),
    ).toHaveLength(1)
  })
})

describe('legacyHandoffs 老事实归一', () => {
  it('没配 M7 两列 → 空清单', () => {
    expect(legacyHandoffs({ handoffWorkflowId: null, handoffStageId: null })).toEqual([])
    expect(legacyHandoffs({})).toEqual([])
  })

  it('普通阶段 → 跑完 + 人工往前（等价 M7 的两条路）；判定阶段 → 通过 + 人工往前', () => {
    expect(legacyHandoffs({ handoffWorkflowId: 'wf-b', handoffStageId: 'st-b1' })).toEqual([
      { on: 'done', workflowId: 'wf-b', stageId: 'st-b1' },
      { on: 'manual', workflowId: 'wf-b', stageId: 'st-b1', forwardOnly: true },
    ])
    expect(
      legacyHandoffs({
        gate: { maxFails: 3 },
        handoffWorkflowId: 'wf-b',
        handoffStageId: null,
      }),
    ).toEqual([
      { on: 'passed', workflowId: 'wf-b', stageId: null },
      { on: 'manual', workflowId: 'wf-b', stageId: null, forwardOnly: true },
    ])
  })
})

describe('sameHandoffs 深比较', () => {
  it('缺省与空数组同值', () => {
    expect(sameHandoffs(undefined, [])).toBe(true)
    expect(sameHandoffs(null, [])).toBe(true)
  })

  it('字段差异与顺序差异都算变更', () => {
    expect(sameHandoffs([handoff()], [handoff()])).toBe(true)
    expect(sameHandoffs([handoff()], [handoff({ on: 'errored' })])).toBe(false)
    expect(sameHandoffs([handoff()], [handoff({ stageId: 'st-b1' })])).toBe(false)
    expect(sameHandoffs([handoff()], [handoff(), handoff()])).toBe(false)
  })

  it('forwardOnly 缺省与 true 等价', () => {
    expect(sameHandoffs([handoff()], [handoff({ forwardOnly: true })])).toBe(true)
    expect(sameHandoffs([handoff()], [handoff({ forwardOnly: false })])).toBe(false)
  })
})
