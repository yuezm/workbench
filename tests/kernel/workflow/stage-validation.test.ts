import { describe, expect, it } from 'vitest'
import type { StageExitInput, StageInput } from '../../../src/protocol/entities'
import { validateStageSet } from '../../../src/kernel/workflow/stage-validation'

const stage = (over: Partial<StageInput> = {}): StageInput => ({
  name: '待办',
  entryMode: 'none',
  ...over,
})

const goto = (on: StageExitInput['on'], stageIndex: number | null): StageExitInput => ({
  on,
  do: 'goto',
  stageIndex,
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

  it('出口的 goto 目标越界时报错（过大 / 负数 / 非整数）', () => {
    expect(
      validateStageSet([
        stage({ name: '待办' }),
        stage({ name: '进行中', exits: [goto('done', 2)] }),
      ]),
    ).toBe('阶段「进行中」的完成后进入目标越界')
    expect(validateStageSet([stage({ name: '待办', exits: [goto('errored', -1)] })])).toBe(
      '阶段「待办」的出错时进入目标越界',
    )
    expect(validateStageSet([stage({ name: '待办', exits: [goto('done', 1.5)] })])).toBe(
      '阶段「待办」的完成后进入目标越界',
    )
  })

  it('goto 不指向自己、也不能不填目标', () => {
    expect(validateStageSet([stage({ name: '待办', exits: [goto('done', 0)] })])).toBe(
      '阶段「待办」的完成后进入不能指向自己',
    )
    expect(validateStageSet([stage({ name: '待办', exits: [goto('done', null)] })])).toBe(
      '阶段「待办」的完成后进入必须指定目标阶段',
    )
    expect(
      validateStageSet([
        stage({ name: '待办' }),
        stage({ name: '进行中', exits: [goto('errored', 1)] }),
      ]),
    ).toBe('阶段「进行中」的出错时进入不能指向自己')
  })

  it('同一个触发条件只能配一条主去向', () => {
    expect(
      validateStageSet([
        stage({ name: '待办', exits: [goto('done', 1), goto('done', 1)] }),
        stage({ name: '进行中' }),
      ]),
    ).toBe('阶段「待办」的完成后进入只能配一条去向')
  })

  it('判定必须是 agent 阶段；护栏是不设或 ≥1 的整数', () => {
    expect(
      validateStageSet([stage({ name: '自测', entryMode: 'none', judge: { maxFails: 3 } })]),
    ).toBe('阶段「自测」设为判定时必须交给智能体')
    expect(
      validateStageSet([
        stage({ name: '自测', entryMode: 'agent', agentId: 'a-1', judge: { maxFails: 0 } }),
      ]),
    ).toBe('阶段「自测」的放行护栏必须是不设或 ≥1 的整数')
    expect(
      validateStageSet([
        stage({ name: '自测', entryMode: 'agent', agentId: 'a-1', judge: { maxFails: 2.5 } }),
      ]),
    ).toBe('阶段「自测」的放行护栏必须是不设或 ≥1 的整数')
  })

  it('判定阶段没有「完成后进入」，非判定阶段没有通过 / 未通过', () => {
    expect(
      validateStageSet([
        stage({
          name: '自测',
          entryMode: 'agent',
          agentId: 'a-1',
          judge: { maxFails: 3 },
          exits: [goto('done', 0)],
        }),
      ]),
    ).toBe('阶段「自测」是判定阶段，没有「完成后进入」')
    expect(validateStageSet([stage({ name: '待办', exits: [goto('passed', 0)] })])).toBe(
      '阶段「待办」不是判定阶段，没有「闸门通过时进入」',
    )
  })

  it('判定阶段的 through / 未通过去向同样受越界与自指约束', () => {
    const judge = (exit: StageExitInput): StageInput =>
      stage({
        name: '自测',
        entryMode: 'agent',
        agentId: 'a-1',
        judge: { maxFails: 3 },
        exits: [exit],
      })

    expect(validateStageSet([judge(goto('failed', 0))])).toBe(
      '阶段「自测」的闸门未通过时进入不能指向自己',
    )
    expect(validateStageSet([judge(goto('passed', 9))])).toBe(
      '阶段「自测」的闸门通过时进入目标越界',
    )
  })

  it('合法配置返回 null（判定两侧 + 普通阶段 + 护栏不设）', () => {
    expect(
      validateStageSet([
        stage({ name: '执行', entryMode: 'agent', agentId: 'a-1' }),
        stage({
          name: '自测',
          entryMode: 'agent',
          agentId: 'a-1',
          judge: { maxFails: 3 },
          exits: [goto('passed', 2), goto('failed', 0)],
        }),
        stage({ name: '结束' }),
      ]),
    ).toBeNull()
    expect(
      validateStageSet([
        stage({ name: '待办' }),
        stage({ name: '进行中', exits: [goto('done', 2), goto('errored', 0)] }),
        stage({
          name: '审核中',
          entryMode: 'agent',
          agentId: 'agent-1',
          judge: { maxFails: null },
          exits: [{ on: 'failed', do: 'await' }],
        }),
        stage({ name: '已完成', entryMode: 'user' }),
      ]),
    ).toBeNull()
  })
})
