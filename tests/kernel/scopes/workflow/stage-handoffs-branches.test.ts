// @vitest-environment node
/**
 * 派单配置的归一与深比较（`scopes/workflow/stage-handoffs.ts`）的边缘臂。
 *
 * 两块：M7 老两列归一成触发条件时「没有 judge、只有 gate」这一支；以及深比较遇到
 * `null` / `undefined` 一侧时按空清单处理（保存前判断要不要落 `stage.updated`）。
 */
import { describe, expect, it } from 'vitest'
import { legacyHandoffs, sameHandoffs } from '@workbench/kernel/scopes/workflow/stage-handoffs'

describe('legacyHandoffs：老字段缺 judge', () => {
  it('没有 judge 但有 gate：按「通过」触发（M11 之前的闸门语义）', () => {
    const handoffs = legacyHandoffs({
      gate: { maxFails: 2 },
      handoffWorkflowId: 'wf-2',
      handoffStageId: 'st-2',
    })
    expect(handoffs).toEqual([
      { on: 'passed', workflowId: 'wf-2', stageId: 'st-2' },
      { on: 'manual', workflowId: 'wf-2', stageId: 'st-2', forwardOnly: true },
    ])
  })

  it('既没有 judge 也没有 gate：按「跑完」触发', () => {
    expect(legacyHandoffs({ handoffWorkflowId: 'wf-2' }).map((item) => item.on)).toEqual([
      'done',
      'manual',
    ])
  })

  it('judge 显式为 null：按「跑完」触发', () => {
    expect(
      legacyHandoffs({ judge: null, handoffWorkflowId: 'wf-2' }).map((item) => item.on),
    ).toEqual(['done', 'manual'])
  })

  it('没有派单目标工作流：空清单', () => {
    expect(legacyHandoffs({ gate: { maxFails: 1 } })).toEqual([])
  })
})

describe('sameHandoffs：缺省一侧按空清单', () => {
  const handoffs = [{ on: 'done' as const, workflowId: 'wf-2', stageId: null }]

  it('一侧是 null / undefined：与空清单同值', () => {
    expect(sameHandoffs(null, [])).toBe(true)
    expect(sameHandoffs(handoffs, undefined)).toBe(false)
  })

  it('长度相同但触发条件不同：不同值', () => {
    expect(sameHandoffs(handoffs, [{ on: 'manual', workflowId: 'wf-2', stageId: null }])).toBe(
      false,
    )
  })
})
