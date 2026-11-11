import { describe, expect, it } from 'vitest'
import type { StageInput } from '../../../src/protocol/entities'
import { validateStageSet } from '../../../src/kernel/workflow/stage-validation'

const stage = (over: Partial<StageInput> = {}): StageInput => ({
  name: '待办',
  entryMode: 'none',
  ...over,
})

describe('validateStageSet', () => {
  it('没有阶段时返回「至少一个阶段」', () => {
    expect(validateStageSet([])).toBe('工作流至少需要一个阶段')
  })

  it('阶段名称为空时按「第 N 个阶段」报错', () => {
    expect(validateStageSet([stage({ name: '' })])).toBe('第 1 个阶段名称必填')
    expect(validateStageSet([stage({ name: '   ' })])).toBe('第 1 个阶段名称必填')
    expect(validateStageSet([stage({ name: '待办' }), stage({ name: '' })])).toBe(
      '第 2 个阶段名称必填',
    )
  })

  it('agent 阶段未选智能体时报错', () => {
    expect(validateStageSet([stage({ name: '审核中', entryMode: 'agent' })])).toBe(
      '阶段「审核中」设为交给智能体时必须选择智能体',
    )
    expect(validateStageSet([stage({ name: '审核中', entryMode: 'agent', agentId: null })])).toBe(
      '阶段「审核中」设为交给智能体时必须选择智能体',
    )
  })

  it('目标下标越界时报错（过大 / 负数 / 非整数）', () => {
    expect(
      validateStageSet([stage({ name: '待办' }), stage({ name: '进行中', onCompleteIndex: 2 })]),
    ).toBe('阶段「进行中」的完成后进入目标越界')
    expect(validateStageSet([stage({ name: '待办', onRejectIndex: -1 })])).toBe(
      '阶段「待办」的出错时进入目标越界',
    )
    expect(validateStageSet([stage({ name: '待办', onCompleteIndex: 1.5 })])).toBe(
      '阶段「待办」的完成后进入目标越界',
    )
  })

  it('目标指向自己时报错', () => {
    expect(validateStageSet([stage({ name: '待办', onCompleteIndex: 0 })])).toBe(
      '阶段「待办」的完成后进入不能指向自己',
    )
    expect(
      validateStageSet([stage({ name: '待办' }), stage({ name: '进行中', onRejectIndex: 1 })]),
    ).toBe('阶段「进行中」的出错时进入不能指向自己')
  })

  it('闸门必须是 agent 阶段，且次数 ≥1', () => {
    expect(
      validateStageSet([stage({ name: '自测', entryMode: 'none', gate: { maxFails: 3 } })]),
    ).toBe('阶段「自测」设为闸门时必须交给智能体')
    expect(
      validateStageSet([
        stage({ name: '自测', entryMode: 'agent', agentId: 'a-1', gate: { maxFails: 0 } }),
      ]),
    ).toBe('阶段「自测」的闸门次数必须是 ≥1 的整数')
    expect(
      validateStageSet([
        stage({ name: '自测', entryMode: 'agent', agentId: 'a-1', gate: { maxFails: 2.5 } }),
      ]),
    ).toBe('阶段「自测」的闸门次数必须是 ≥1 的整数')
  })

  it('闸门去向同样受越界与自指约束', () => {
    expect(
      validateStageSet([
        stage({
          name: '自测',
          entryMode: 'agent',
          agentId: 'a-1',
          gate: { maxFails: 3, onFailIndex: 0 },
        }),
      ]),
    ).toBe('阶段「自测」的闸门未通过时进入不能指向自己')
    expect(
      validateStageSet([
        stage({
          name: '自测',
          entryMode: 'agent',
          agentId: 'a-1',
          gate: { maxFails: 3, onPassIndex: 9 },
        }),
      ]),
    ).toBe('阶段「自测」的闸门通过时进入目标越界')
  })

  it('合法闸门配置返回 null', () => {
    expect(
      validateStageSet([
        stage({ name: '执行', entryMode: 'agent', agentId: 'a-1' }),
        stage({
          name: '自测',
          entryMode: 'agent',
          agentId: 'a-1',
          gate: { maxFails: 3, onPassIndex: 2, onFailIndex: 0 },
        }),
        stage({ name: '结束' }),
      ]),
    ).toBeNull()
  })

  it('合法配置返回 null（含 null / undefined 目标与带智能体的 agent 阶段）', () => {
    expect(
      validateStageSet([
        stage({ name: '待办' }),
        stage({ name: '进行中', onCompleteIndex: 2, onRejectIndex: 0 }),
        stage({ name: '审核中', entryMode: 'agent', agentId: 'agent-1', onRejectIndex: null }),
        stage({ name: '已完成', entryMode: 'user', onCompleteIndex: null }),
      ]),
    ).toBeNull()
    expect(validateStageSet([stage({ name: '唯一阶段', onRejectIndex: undefined })])).toBeNull()
  })
})
