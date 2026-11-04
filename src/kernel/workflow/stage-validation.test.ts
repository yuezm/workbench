import { describe, expect, it } from 'vitest'
import type { StageInput } from '../../protocol/types'
import { validateStageSet } from './stage-validation'

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
      '阶段「待办」的打回时退回到目标越界',
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
    ).toBe('阶段「进行中」的打回时退回到不能指向自己')
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
