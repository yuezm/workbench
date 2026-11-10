// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { StageInput } from '../../../../../../src/protocol/entities'
import {
  builtinKeyOfName,
  builtinStageDraft,
  emptyStage,
  firstUserStageIndex,
  insertStageIndex,
  insertUserStage,
  isTerminalStage,
  isUserStage,
  nextUserStageName,
  userStageRange,
  withBuiltinStages,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/stage-draft'

/**
 * 草稿阶段列表（M18）：内置阶段的补齐 / 规范排序 / 下标重映射。
 *
 * 这里守住三件事：① 四个内置阶段恒在、顺序固定；② 老数据按内置名认领（保留 id 与配置）；
 * ③ 任何插入 / 排序都要把流转目标的下标一起重映射——不然界面看不出异常，流转会指错阶段。
 */

/** 一个自己添加的阶段（只是名字 + 进入方式，字段形状与草稿一致） */
const user = (name: string, extra: Partial<StageInput> = {}): StageInput => ({
  ...emptyStage(name),
  ...extra,
})

/** 只取名字，断言顺序时最好读 */
const names = (stages: readonly StageInput[]): string[] => stages.map((stage) => stage.name)
const builtins = (stages: readonly StageInput[]): Array<string | null | undefined> =>
  stages.map((stage) => stage.builtin)

describe('emptyStage / builtinStageDraft', () => {
  it('自己添加的阶段：进入时停下、流转目标与交接全空、没有内置键', () => {
    expect(emptyStage('阶段1')).toEqual({
      name: '阶段1',
      entryMode: 'none',
      builtin: null,
      onCompleteIndex: null,
      onRejectIndex: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      instructions: '',
      gate: null,
    })
  })

  it('内置阶段的默认值：固定名称 + 内置键 + 进入时停下', () => {
    expect(builtinStageDraft('todo')).toMatchObject({
      name: '待办',
      builtin: 'todo',
      entryMode: 'none',
      onCompleteIndex: null,
      gate: null,
    })
    expect(builtinStageDraft('cancelled')).toMatchObject({ name: '已取消', builtin: 'cancelled' })
  })
})

describe('builtinKeyOfName', () => {
  it('按固定名称（去首尾空白）认出内置键', () => {
    expect(builtinKeyOfName('待办')).toBe('todo')
    expect(builtinKeyOfName(' 已阻塞 ')).toBe('blocked')
    expect(builtinKeyOfName('已完成')).toBe('done')
    expect(builtinKeyOfName('已取消')).toBe('cancelled')
  })

  it('不是内置名 / 没名字 → null', () => {
    expect(builtinKeyOfName('待办中')).toBeNull()
    expect(builtinKeyOfName('')).toBeNull()
    expect(builtinKeyOfName(undefined)).toBeNull()
  })
})

describe('isUserStage / isTerminalStage', () => {
  it('没有内置键的是自己添加的阶段', () => {
    expect(isUserStage(user('方案'))).toBe(true)
    expect(isUserStage(builtinStageDraft('blocked'))).toBe(false)
  })

  it('只有已完成 / 已取消是终态（自己添加的阶段永远不是）', () => {
    expect(isTerminalStage(builtinStageDraft('done'))).toBe(true)
    expect(isTerminalStage(builtinStageDraft('cancelled'))).toBe(true)
    expect(isTerminalStage(builtinStageDraft('todo'))).toBe(false)
    expect(isTerminalStage(builtinStageDraft('blocked'))).toBe(false)
    expect(isTerminalStage(user('已完成'))).toBe(false)
  })
})

describe('withBuiltinStages', () => {
  it('空草稿补出四件套：待办 → 已阻塞 → 已完成 → 已取消', () => {
    const stages = withBuiltinStages([])
    expect(names(stages)).toEqual(['待办', '已阻塞', '已完成', '已取消'])
    expect(builtins(stages)).toEqual(['todo', 'blocked', 'done', 'cancelled'])
    // 补齐的内置项没有 id：保存时由内核分配
    expect(stages.every((stage) => stage.id === undefined)).toBe(true)
  })

  it('自己添加的阶段排进中间区块，顺序不变', () => {
    const stages = withBuiltinStages([user('方案'), user('实现')])
    expect(names(stages)).toEqual(['待办', '方案', '实现', '已阻塞', '已完成', '已取消'])
    expect(builtins(stages)).toEqual(['todo', null, null, 'blocked', 'done', 'cancelled'])
  })

  it('幂等：已经规范的列表再跑一次，顺序与字段都不变', () => {
    const once = withBuiltinStages([user('方案', { onCompleteIndex: 2 })])
    const twice = withBuiltinStages(once)
    expect(twice).toEqual(once)
  })

  it('老数据按内置名认领：保留 id 与配置，只补上内置键', () => {
    const legacy = user('待办', { id: 's0', entryMode: 'agent', agentId: 'ag1' })
    const stages = withBuiltinStages([legacy, user('实现')])
    expect(stages[0]).toMatchObject({
      id: 's0',
      name: '待办',
      builtin: 'todo',
      entryMode: 'agent',
      agentId: 'ag1',
    })
  })

  it('显式内置键优先于名字：键与名字不符时以键为准', () => {
    const stages = withBuiltinStages([{ ...user('随意名'), builtin: 'done' }])
    expect(stages[2]).toMatchObject({ name: '随意名', builtin: 'done' })
  })

  it('同名阶段只认领第一个：多出来的仍按自己添加的阶段排进中间', () => {
    const stages = withBuiltinStages([user('待办', { id: 'a' }), user('待办', { id: 'b' })])
    expect(names(stages)).toEqual(['待办', '待办', '已阻塞', '已完成', '已取消'])
    expect(stages.map((stage) => stage.id)).toEqual(['a', 'b', undefined, undefined, undefined])
  })

  it('重映射下标：待办插到最前面，原有目标整体 +1', () => {
    // A 的「完成后进入」指向 B（老数组下标 2 = C？不：老数组是 [A,B,C]，指向 B = 下标 1）
    const stages = withBuiltinStages([
      user('A', { onCompleteIndex: 2, onRejectIndex: 0 }),
      user('B'),
      user('C'),
    ])
    expect(names(stages)).toEqual(['待办', 'A', 'B', 'C', '已阻塞', '已完成', '已取消'])
    // A 在新数组里是下标 1：2 → 3（C），0 → 1（A 自己，内核会以自指拒收，这里只管下标正确）
    expect(stages[1]).toMatchObject({ onCompleteIndex: 3, onRejectIndex: 1 })
  })

  it('闸门两侧的去向也一起重映射', () => {
    const stages = withBuiltinStages([
      user('执行', { entryMode: 'agent' }),
      user('判定', {
        entryMode: 'agent',
        gate: { maxFails: 2, onPassIndex: 1, onFailIndex: 0 },
      }),
    ])
    // 判定在新数组里是下标 2：通过 = 1 → 2（自己）？老数组下标 1 就是判定自己，重映射后仍是 2
    expect(stages[2].gate).toEqual({ maxFails: 2, onPassIndex: 2, onFailIndex: 1 })
  })

  it('越界下标原样保留：交给保存前的悬空目标校验去指出位置', () => {
    const stages = withBuiltinStages([user('A', { onCompleteIndex: 9 })])
    expect(stages[1].onCompleteIndex).toBe(9)
  })

  it('没有内置阶段的老数据里，名字不撞内置名的阶段不受影响', () => {
    const stages = withBuiltinStages([user('方案'), user('实现')])
    expect(stages[1].builtin).toBeNull()
    expect(stages[1].name).toBe('方案')
  })
})

describe('userStageRange / insertStageIndex / nextUserStageName', () => {
  it('用户区块从「待办」之后开始，到「已阻塞」之前结束', () => {
    expect(userStageRange(withBuiltinStages([]))).toEqual({ start: 1, end: 1 })
    expect(userStageRange(withBuiltinStages([user('A'), user('B')]))).toEqual({ start: 1, end: 3 })
  })

  it('插入位置就是用户区块末尾', () => {
    expect(insertStageIndex(withBuiltinStages([]))).toBe(1)
    expect(insertStageIndex(withBuiltinStages([user('A'), user('B')]))).toBe(3)
  })

  it('新阶段默认名按自己添加的阶段数编号，不把内置阶段算进去', () => {
    expect(nextUserStageName(withBuiltinStages([]))).toBe('阶段1')
    expect(nextUserStageName(withBuiltinStages([user('A'), user('B')]))).toBe('阶段3')
  })
})

describe('firstUserStageIndex', () => {
  it('落在第一个自己添加的阶段上；只有内置阶段时回到待办', () => {
    expect(firstUserStageIndex(withBuiltinStages([user('A'), user('B')]))).toBe(1)
    expect(firstUserStageIndex(withBuiltinStages([]))).toBe(0)
  })
})

describe('insertUserStage', () => {
  it('插到用户区块末尾并返回新下标', () => {
    const result = insertUserStage(withBuiltinStages([user('A')]), user('B'))
    expect(names(result.stages)).toEqual(['待办', 'A', 'B', '已阻塞', '已完成', '已取消'])
    expect(result.index).toBe(2)
  })

  it('插入点之后的流转目标 +1（指向「已阻塞 / 已完成」的目标不会差一位）', () => {
    const stages = withBuiltinStages([
      user('A', { onCompleteIndex: 3, onRejectIndex: 0 }),
      user('B', {
        entryMode: 'agent',
        gate: { maxFails: 3, onPassIndex: 3, onFailIndex: 0 },
      }),
    ])
    // 「已阻塞」在下标 3：插入一个用户阶段后变 4
    const result = insertUserStage(stages, user('C'))
    expect(names(result.stages)).toEqual(['待办', 'A', 'B', 'C', '已阻塞', '已完成', '已取消'])
    expect(result.stages[1]).toMatchObject({ onCompleteIndex: 4, onRejectIndex: 1 })
    expect(result.stages[2].gate).toEqual({ maxFails: 3, onPassIndex: 4, onFailIndex: 1 })
  })

  it('空目标保持 null', () => {
    const result = insertUserStage(withBuiltinStages([]), user('A'))
    expect(result.stages[1]).toMatchObject({ onCompleteIndex: null, onRejectIndex: null })
    expect(result.stages[1].gate).toBeNull()
  })
})
