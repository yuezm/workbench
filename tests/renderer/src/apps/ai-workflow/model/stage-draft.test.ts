// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { StageInput } from '../../../../../../src/protocol/entities'
import {
  builtinKeyOfName,
  builtinStageDraft,
  dropStageIndexes,
  dropVanishedStages,
  emptyStage,
  firstUserStageIndex,
  insertStageIndex,
  insertUserStage,
  isTerminalStage,
  isUserStage,
  nextUserStageName,
  stageIdAfterWorkflowChange,
  userStageRange,
  withBuiltinStages,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/stage-draft'

/**
 * 草稿阶段列表（M18）：内置阶段的补齐 / 规范排序 / 下标重映射。
 *
 * 这里守住三件事：① 四个内置阶段恒在、顺序固定；② 老数据按内置名认领（保留 id 与配置）；
 * ③ 任何插入 / 排序都要把出口表里 `goto` 的下标一起重映射——不然界面看不出异常，流转会指错阶段。
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
      exits: [],
      handoffs: [],
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      instructions: '',
      acceptance: [],
      runTimeoutMs: null,
      judge: null,
      script: null,
    })
  })

  it('内置阶段的默认值：固定名称 + 内置键 + 进入时停下', () => {
    expect(builtinStageDraft('todo')).toMatchObject({
      name: '待办',
      builtin: 'todo',
      entryMode: 'none',
      // 出口表留空：缺省（done → 下一阶段，errored → 停在这里等人）由内核保存时补齐
      exits: [],
      judge: null,
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
    const once = withBuiltinStages([
      user('方案', { exits: [{ on: 'done', do: 'goto', stageIndex: 2 }] }),
    ])
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

  it('重映射下标：待办插到最前面，出口表里的 goto 目标整体 +1', () => {
    // A 的「完成时」指向老数组下标 2（C），「出错时」指向 0（A 自己）
    const stages = withBuiltinStages([
      user('A', {
        exits: [
          { on: 'done', do: 'goto', stageIndex: 2 },
          { on: 'errored', do: 'goto', stageIndex: 0 },
        ],
      }),
      user('B'),
      user('C'),
    ])
    expect(names(stages)).toEqual(['待办', 'A', 'B', 'C', '已阻塞', '已完成', '已取消'])
    // A 在新数组里是下标 1：2 → 3（C），0 → 1（A 自己，内核会以自指拒收，这里只管下标正确）
    expect(stages[1].exits).toEqual([
      { on: 'done', do: 'goto', stageIndex: 3 },
      { on: 'errored', do: 'goto', stageIndex: 1 },
    ])
  })

  it('判定阶段的通过 / 未通过两条出口也一起重映射', () => {
    const stages = withBuiltinStages([
      user('执行', { entryMode: 'agent' }),
      user('判定', {
        entryMode: 'agent',
        judge: { maxFails: 2 },
        exits: [
          { on: 'passed', do: 'goto', stageIndex: 1 },
          { on: 'failed', do: 'goto', stageIndex: 0 },
        ],
      }),
    ])
    // 判定在新数组里是下标 2：通过 = 1 → 2（自己，重映射只管下标），未通过 0 → 1
    expect(stages[2].judge).toEqual({ maxFails: 2 })
    expect(stages[2].exits).toEqual([
      { on: 'passed', do: 'goto', stageIndex: 2 },
      { on: 'failed', do: 'goto', stageIndex: 1 },
    ])
  })

  it('越界下标原样保留：交给保存前的悬空目标校验去指出位置', () => {
    const stages = withBuiltinStages([
      user('A', { exits: [{ on: 'done', do: 'goto', stageIndex: 9 }] }),
    ])
    expect(stages[1].exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 9 }])
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

  it('插入点之后的出口表目标 +1（指向「已阻塞 / 已完成」的目标不会差一位）', () => {
    const stages = withBuiltinStages([
      user('A', {
        exits: [
          { on: 'done', do: 'goto', stageIndex: 3 },
          { on: 'errored', do: 'goto', stageIndex: 0 },
        ],
      }),
      user('B', {
        entryMode: 'agent',
        judge: { maxFails: 3 },
        exits: [
          { on: 'passed', do: 'goto', stageIndex: 3 },
          { on: 'failed', do: 'goto', stageIndex: 0 },
        ],
      }),
    ])
    // 「已阻塞」在下标 3：插入一个用户阶段后变 4
    const result = insertUserStage(stages, user('C'))
    expect(names(result.stages)).toEqual(['待办', 'A', 'B', 'C', '已阻塞', '已完成', '已取消'])
    expect(result.stages[1].exits).toEqual([
      { on: 'done', do: 'goto', stageIndex: 4 },
      { on: 'errored', do: 'goto', stageIndex: 1 },
    ])
    expect(result.stages[2].judge).toEqual({ maxFails: 3 })
    expect(result.stages[2].exits).toEqual([
      { on: 'passed', do: 'goto', stageIndex: 4 },
      { on: 'failed', do: 'goto', stageIndex: 1 },
    ])
  })

  it('空出口表保持为空：判定者与出口都不凭空补', () => {
    const result = insertUserStage(withBuiltinStages([]), user('A'))
    expect(result.stages[1].exits).toEqual([])
    expect(result.stages[1].judge).toBeNull()
  })
})

/**
 * 规范顺序的草稿（待办 → 用户阶段 → 已阻塞 → 已完成 → 已取消），用户阶段的下标恰好从 1 起。
 *
 * 直接拼而不走 `withBuiltinStages`：那个函数会重映射下标，这里要按下标精确断言。
 */
const draft = (...stages: readonly StageInput[]): StageInput[] => [
  builtinStageDraft('todo'),
  ...stages,
  builtinStageDraft('blocked'),
  builtinStageDraft('done'),
  builtinStageDraft('cancelled'),
]

describe('dropStageIndexes', () => {
  it('删掉中间一个阶段：后面的下标整体前移，指向它的出口清空', () => {
    // 下标：0 待办 / 1 A / 2 B / 3 C / 4 已阻塞 / 5 已完成 / 6 已取消
    const stages = draft(
      user('A', { id: 'a', exits: [{ on: 'done', do: 'goto', stageIndex: 2 }] }),
      user('B', {
        id: 'b',
        entryMode: 'agent',
        judge: { maxFails: 2 },
        exits: [
          { on: 'passed', do: 'goto', stageIndex: 1 },
          { on: 'failed', do: 'goto', stageIndex: 4 },
        ],
      }),
      user('C', {
        id: 'c',
        exits: [{ on: 'errored', do: 'goto', stageIndex: 1 }],
        subtaskStageId: 'b',
      }),
    )
    const next = dropStageIndexes(stages, [2])
    expect(names(next)).toEqual(['待办', 'A', 'C', '已阻塞', '已完成', '已取消'])
    // A 原来指向 B（2）→ 清成「未指定」；C 原来指向 A（1）保持 1
    expect(next[1].exits).toEqual([{ on: 'done', do: 'goto', stageIndex: null }])
    expect(next[2]).toMatchObject({ subtaskStageId: 'b' })
    expect(next[2].exits).toEqual([{ on: 'errored', do: 'goto', stageIndex: 1 }])
  })

  it('判定两侧的出口一起重映射；一次删多个下标按新顺序压紧', () => {
    const stages = draft(
      user('A', { id: 'a' }),
      user('B', {
        id: 'b',
        entryMode: 'agent',
        judge: { maxFails: 2 },
        exits: [
          { on: 'done', do: 'goto', stageIndex: 4 },
          { on: 'passed', do: 'goto', stageIndex: 4 },
          { on: 'failed', do: 'goto', stageIndex: 0 },
        ],
      }),
      user('C', { id: 'c' }),
    )
    // 删掉「待办」之后的第一项与最后一项 → 只剩 B
    const next = dropStageIndexes(stages, [1, 3])
    expect(names(next)).toEqual(['待办', 'B', '已阻塞', '已完成', '已取消'])
    // 已阻塞原来在下标 4：删掉 1、3 之后变 2；失败退回「待办」仍在下标 0
    expect(next[1].exits).toEqual([
      { on: 'done', do: 'goto', stageIndex: 2 },
      { on: 'passed', do: 'goto', stageIndex: 2 },
      { on: 'failed', do: 'goto', stageIndex: 0 },
    ])
    expect(next[1].judge).toEqual({ maxFails: 2 })
  })

  it('越界下标原样保留：交给保存前的悬空目标校验去指出位置', () => {
    const next = dropStageIndexes(
      draft(user('A', { id: 'a', exits: [{ on: 'done', do: 'goto', stageIndex: 99 }] })),
      [2],
    )
    expect(next[1].exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 98 }])
  })
})

describe('dropVanishedStages', () => {
  it('库里有 / 没 id 的阶段都留着：新阶段还没 id，不能当成「已删除」', () => {
    const stages = draft(user('A', { id: 'a' }), user('B'))
    expect(dropVanishedStages(stages, new Set(['a']))).toEqual(stages)
  })

  it('id 已不在库里的阶段丢掉，并清掉指向它的子任务落点', () => {
    const stages = draft(
      user('A', { id: 'a', exits: [{ on: 'done', do: 'goto', stageIndex: 2 }] }),
      user('B', { id: 'gone', subtaskStageId: 'a' }),
      user('C', {
        id: 'c',
        subtaskStageId: 'gone',
        exits: [{ on: 'errored', do: 'goto', stageIndex: 4 }],
      }),
    )
    const live = new Set(['a', 'c'])
    const next = dropVanishedStages(stages, live)
    expect(names(next)).toEqual(['待办', 'A', 'C', '已阻塞', '已完成', '已取消'])
    // A 原来指向 B（2，已被别处删掉）→ 清成「未指定」；C 的子任务落点指向已删阶段 → 清空，
    // 指向「已阻塞」的出错出口跟着前移一位
    expect(next[1].exits).toEqual([{ on: 'done', do: 'goto', stageIndex: null }])
    expect(next[2]).toMatchObject({ subtaskStageId: null })
    expect(next[2].exits).toEqual([{ on: 'errored', do: 'goto', stageIndex: 3 }])
  })

  it('内置项本来就没有 id：不算「已删除」，原样提交由内核补齐', () => {
    const stages = draft()
    expect(dropVanishedStages(stages, new Set())).toEqual(stages)
  })
})

describe('stageIdAfterWorkflowChange（规则弹窗换工作流后的起始阶段）', () => {
  it('新流程里还有这个阶段：保留原值', () => {
    expect(stageIdAfterWorkflowChange([{ id: 's1' }, { id: 's2' }], 's2')).toBe('s2')
  })

  it('新流程里没有这个阶段：回到首阶段（空串），避免提交悬空 id', () => {
    expect(stageIdAfterWorkflowChange([{ id: 's1' }], 's2')).toBe('')
  })

  it('新流程读不到（工作流被删 / 还没同步）：同样回到首阶段', () => {
    expect(stageIdAfterWorkflowChange(undefined, 's1')).toBe('')
  })
})
