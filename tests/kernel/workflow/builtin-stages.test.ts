import { describe, expect, it } from 'vitest'
import type { WorkflowStage } from '../../../src/protocol/entities'
import {
  builtinStageInput,
  orderStagesByBuiltin,
  resolveBuiltinStages,
} from '../../../src/kernel/workflow/builtin-stages'

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '开发',
  position: 0,
  entryMode: 'none',
  builtin: null,
  agentId: null,
  exits: {},
  judge: null,
  handoffs: [],
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  instructions: '',
  acceptance: [],
  maxRounds: null,
  runTimeoutMs: null,
  ...over,
})

describe('kernel/workflow/builtin-stages resolveBuiltinStages', () => {
  it('新建：空提交缺四个内置阶段，全部按缺失补齐', () => {
    expect(resolveBuiltinStages([], null)).toEqual({
      keys: [],
      missing: ['todo', 'blocked', 'done', 'cancelled'],
      error: null,
    })
  })

  it('新建：按名字认领内置阶段（保留配置），只补缺的键', () => {
    const resolved = resolveBuiltinStages(
      [
        { name: ' 已完成 ', entryMode: 'agent', agentId: 'ag-1' },
        { name: '开发', entryMode: 'none' },
      ],
      null,
    )
    expect(resolved).toEqual({
      keys: ['done', null],
      missing: ['todo', 'blocked', 'cancelled'],
      error: null,
    })
  })

  it('显式内置键与名称不符 → 拒绝（内置阶段名称固定）', () => {
    expect(
      resolveBuiltinStages([{ name: '待办', entryMode: 'none', builtin: 'done' }], null),
    ).toEqual({
      keys: [],
      missing: [],
      error: '内置阶段名称固定为「已完成」',
    })
  })

  it('同一个内置键提交两次 → 重复', () => {
    expect(
      resolveBuiltinStages(
        [
          { name: '已完成', entryMode: 'none' },
          { name: '已完成', entryMode: 'none' },
        ],
        null,
      ),
    ).toEqual({
      keys: [],
      missing: [],
      error: '内置阶段「已完成」重复',
    })
  })

  it('既有内置行换键 → 类别不可修改', () => {
    const existing = [stage({ id: 's1', name: '已完成', builtin: 'done' })]
    expect(
      resolveBuiltinStages(
        [{ id: 's1', name: '已取消', entryMode: 'none', builtin: 'cancelled' }],
        existing,
      ),
    ).toEqual({
      keys: [],
      missing: [],
      error: '阶段「已完成」是内置阶段，类别不可修改',
    })
  })

  it('既有内置行不带标记且改了名 → 不可改名', () => {
    const existing = [stage({ id: 's1', name: '已完成', builtin: 'done' })]
    expect(resolveBuiltinStages([{ id: 's1', name: '验收', entryMode: 'none' }], existing)).toEqual(
      {
        keys: [],
        missing: [],
        error: '内置阶段「已完成」不可改名',
      },
    )
  })

  it('既有内置行换个 id 重建 → 不可删除后重建', () => {
    const existing = [stage({ id: 's1', name: '已完成', builtin: 'done' })]
    expect(resolveBuiltinStages([{ name: '已完成', entryMode: 'none' }], existing)).toEqual({
      keys: [],
      missing: [],
      error: '内置阶段「已完成」不可删除后重建',
    })
  })

  it('自己添加的阶段改名撞上内置阶段名 → 提示改名（不是「删除后重建」）', () => {
    const existing = [
      stage({ id: 's0', name: '待办', builtin: 'todo' }),
      stage({ id: 'u1', name: '开发', builtin: null }),
    ]
    expect(resolveBuiltinStages([{ id: 'u1', name: '待办', entryMode: 'none' }], existing)).toEqual(
      {
        keys: [],
        missing: [],
        error: '阶段「待办」的名称与内置阶段冲突，请改名',
      },
    )
  })

  it('既有内置行按 id 认领、名称不变时不报错', () => {
    const existing = [stage({ id: 's1', name: '已完成', builtin: 'done' })]
    expect(
      resolveBuiltinStages([{ id: 's1', name: '已完成', entryMode: 'none' }], existing),
    ).toEqual({
      keys: ['done'],
      missing: ['todo', 'blocked', 'cancelled'],
      error: null,
    })
  })

  it('终态也不拦：派单的终态校验归 validateStageHandoffs（M29 从本函数移出）', () => {
    const resolved = resolveBuiltinStages([{ name: '已完成', entryMode: 'none' }], null)

    expect(resolved.keys).toEqual(['done'])
    expect(resolved.missing).toEqual(['todo', 'blocked', 'cancelled'])
    expect(resolved.error).toBeNull()
  })

  it('自己添加的阶段不受影响：键为 null、参与缺失计算', () => {
    expect(
      resolveBuiltinStages(
        [
          { name: '开发', entryMode: 'none' },
          { name: '验收', entryMode: 'none' },
        ],
        null,
      ),
    ).toEqual({
      keys: [null, null],
      missing: ['todo', 'blocked', 'done', 'cancelled'],
      error: null,
    })
  })
})

describe('kernel/workflow/builtin-stages builtinStageInput', () => {
  it('默认值：进入时停下、无智能体 / 去向 / 闸门 / 说明', () => {
    expect(builtinStageInput('blocked')).toEqual({
      name: '已阻塞',
      entryMode: 'none',
      builtin: 'blocked',
      agentId: null,
      exits: [],
      handoffs: [],
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      instructions: '',
      acceptance: [],
      maxRounds: null,
      judge: null,
    })
  })
})

describe('kernel/workflow/builtin-stages orderStagesByBuiltin', () => {
  it('规范顺序：待办 → 自己添加的阶段（保序）→ 已阻塞 → 已完成 → 已取消', () => {
    const entries = [
      { id: 'cancelled', builtin: 'cancelled' as const },
      { id: 'b', builtin: null },
      { id: 'done', builtin: 'done' as const },
      { id: 'todo', builtin: 'todo' as const },
      { id: 'a', builtin: null },
      { id: 'blocked', builtin: 'blocked' as const },
    ]
    expect(orderStagesByBuiltin(entries).map((entry) => entry.id)).toEqual([
      'todo',
      'b',
      'a',
      'blocked',
      'done',
      'cancelled',
    ])
  })

  it('缺内置阶段时只排现有的（不造行）', () => {
    const entries = [
      { id: 'a', builtin: null },
      { id: 'done', builtin: 'done' as const },
    ]
    expect(orderStagesByBuiltin(entries).map((entry) => entry.id)).toEqual(['a', 'done'])
  })
})
