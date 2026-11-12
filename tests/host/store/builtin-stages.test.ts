// @vitest-environment node
/**
 * 启动补齐内置阶段（M18）：`store.ensureBuiltinStages()`。
 *
 * 真实内核 + 真实 store：老工作流（M18 之前的事实：阶段没有 `builtin` 键）在启动补齐后
 * 变成「待办 / 已阻塞 / 已完成 / 已取消」四件套，并按规范顺序重排位置；补建与改写都走
 * 「追加事实 + 应用投影」，因此重建后与实时投影逐表全等，重复调用幂等。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { decide } from '../../../src/kernel/decide'
import { project } from '../../../src/kernel/project'
import { viewSpec } from '../../../src/kernel/view-spec'
import type { Actor, FactDraft, KernelPort } from '../../../src/kernel/types'
import type { Workflow, WorkflowStage } from '../../../src/protocol/entities'
import { withTx } from '../../../src/host/schema'
import { BUILTIN_BACKFILL_ACTOR, planBuiltinStages } from '../../../src/host/store/builtin-stages'
import { appendFacts } from '../../../src/host/store/facts'
import { createStore, type Store } from '../../../src/host/store/index'
import { createMemoryDb, dumpProjection } from './test-support'

const AT = '2026-04-04T04:04:04.000Z'
const OWNER: Actor = { kind: 'owner', via: 'ui' }
const kernel: KernelPort = { decide, project, viewSpec }

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

function memory(): DatabaseSync {
  const db = createMemoryDb()
  openDbs.push(db)
  return db
}

/** 确定性 id 生成器：补齐时按补建顺序取用。 */
function ids(...values: string[]): () => string {
  let index = 0
  return () => {
    const id = values[index] ?? `gen-${index}`
    index += 1
    return id
  }
}

function storeOn(db: DatabaseSync, newId: () => string = ids()): Store {
  const store = createStore({ db, kernel, now: () => AT, newId })
  store.ensureProjection()
  return store
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`缺少${label}`)
  return value
}

function stageRow(
  id: string,
  workflowId: string,
  name: string,
  position: number,
  overrides: Partial<WorkflowStage> = {},
): WorkflowStage {
  return {
    id,
    workflowId,
    name,
    position,
    entryMode: 'none',
    builtin: null,
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
    handoffs: [],
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: '',
    gate: null,
    ...overrides,
  }
}

/**
 * 把「M18 之前会写出来的事实」直接追加成老库：workflow.created + 若干 stage.created，
 * 阶段行没有 `builtin` 键。再 `rebuild()` 让投影与事实一致（等价于老库首启）。
 */
function seedLegacy(
  db: DatabaseSync,
  store: Store,
  workflow: Workflow,
  stages: WorkflowStage[],
): void {
  const drafts: FactDraft[] = [
    { type: 'workflow.created', actor: OWNER, at: AT, payload: { workflow } },
    ...stages.map((stage) => ({
      type: 'stage.created' as const,
      actor: OWNER,
      at: AT,
      payload: { stage },
    })),
  ]
  withTx(db, () => appendFacts(db, drafts))
  store.rebuild()
}

/** 某工作流当前的阶段（按投影的 position 顺序）。 */
function stagesOf(store: Store, workflowId: string): WorkflowStage[] {
  return must(
    store.query('workflows.all').find((item) => item.id === workflowId),
    `工作流 ${workflowId}`,
  ).stages
}

describe('store.ensureBuiltinStages：空库与已规范的工作流', () => {
  it('空库：零事实、created / updated 都是 0', () => {
    const db = memory()
    const store = storeOn(db)

    expect(store.ensureBuiltinStages()).toEqual({ created: 0, updated: 0 })
    expect(store.factsCount()).toBe(0)
  })

  it('内核已补齐四件套的工作流：幂等零事实、投影不动', () => {
    const db = memory()
    const store = storeOn(db, ids('wf-1', 'st-user'))
    store.dispatch({
      type: 'workflow.create',
      commandId: 'w-1',
      input: { name: '流程', stages: [{ name: '实现', entryMode: 'none' }] },
    })
    const before = dumpProjection(db)
    const factsBefore = store.factsCount()
    const stagesBefore = stagesOf(store, 'wf-1')

    expect(store.ensureBuiltinStages()).toEqual({ created: 0, updated: 0 })
    expect(store.factsCount()).toBe(factsBefore)
    expect(dumpProjection(db)).toEqual(before)
    // 再跑一次仍幂等
    expect(store.ensureBuiltinStages()).toEqual({ created: 0, updated: 0 })
    expect(stagesOf(store, 'wf-1')).toEqual(stagesBefore)
  })
})

describe('store.ensureBuiltinStages：老工作流按名认领 / 补建 / 重排', () => {
  it('老工作流：按名认领「待办」保留 id 与配置，缺的三个补建默认值，位置按规范顺序重排', () => {
    const db = memory()
    // id 生成顺序：运行时 → 智能体 → 补齐时按规范顺序补建的三个内置阶段
    const store = storeOn(db, ids('rt-1', 'ag-1', 'st-blocked', 'st-done', 'st-cancelled'))
    // 老库里「待办」被配成 agent 阶段：认领后必须原样保留（引用真实智能体，外键才成立）
    store.dispatch({
      type: 'runtime.create',
      commandId: 'r-1',
      input: { name: '本机 dsh', executorKey: 'dsh', command: 'dsh' },
    })
    store.dispatch({
      type: 'agent.create',
      commandId: 'a-1',
      input: { name: '实现者', runtimeId: 'rt-1' },
    })
    const workflow: Workflow = { id: 'wf-old', name: '老流程', description: '', createdAt: AT }
    seedLegacy(db, store, workflow, [
      stageRow('st-todo', 'wf-old', '待办', 0, {
        entryMode: 'agent',
        agentId: 'ag-1',
        instructions: '先看工单',
      }),
      stageRow('st-impl', 'wf-old', '实现', 1),
    ])
    expect(stagesOf(store, 'wf-old')).toHaveLength(2)
    const factsBefore = store.factsCount()

    expect(store.ensureBuiltinStages()).toEqual({ created: 3, updated: 1 })
    // 1 条 stage.updated（待办认领成内置：类别变了）+ 3 条 stage.created（补建）
    const appended = store.factsSince(factsBefore)
    expect(appended.map((fact) => fact.type)).toEqual([
      'stage.updated',
      'stage.created',
      'stage.created',
      'stage.created',
    ])
    expect(appended.map((fact) => fact.actor)).toEqual([
      BUILTIN_BACKFILL_ACTOR,
      BUILTIN_BACKFILL_ACTOR,
      BUILTIN_BACKFILL_ACTOR,
      BUILTIN_BACKFILL_ACTOR,
    ])
    expect(appended.map((fact) => fact.at)).toEqual([AT, AT, AT, AT])

    const stages = stagesOf(store, 'wf-old')
    // 规范顺序：待办 → 自己添加的阶段 → 已阻塞 → 已完成 → 已取消
    expect(stages.map((stage) => stage.name)).toEqual([
      '待办',
      '实现',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(stages.map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4])
    expect(stages.map((stage) => stage.builtin ?? null)).toEqual([
      'todo',
      null,
      'blocked',
      'done',
      'cancelled',
    ])
    // 认领保留原 id 与配置（只改类别与位置）
    expect(stages[0]).toMatchObject({
      id: 'st-todo',
      entryMode: 'agent',
      agentId: 'ag-1',
      instructions: '先看工单',
    })
    // 补建的内置阶段按默认值：进入时停下、无 agent、无去向、无闸门
    expect(stages[2]).toMatchObject({
      id: 'st-blocked',
      entryMode: 'none',
      agentId: null,
      onCompleteStageId: null,
      onRejectStageId: null,
      instructions: '',
      gate: null,
    })
  })

  it('位置不规范的存量：按规范顺序重排，两个移动过的阶段各写一条 stage.updated', () => {
    const db = memory()
    const store = storeOn(db, ids('st-blocked', 'st-done', 'st-cancelled'))
    const workflow: Workflow = {
      id: 'wf-shuffle',
      name: '乱序流程',
      description: '',
      createdAt: AT,
    }
    // 老数据：自己添加的阶段在前、「待办」垫在末尾
    seedLegacy(db, store, workflow, [
      stageRow('st-impl', 'wf-shuffle', '实现', 0),
      stageRow('st-todo', 'wf-shuffle', '待办', 1),
    ])

    expect(store.ensureBuiltinStages()).toEqual({ created: 3, updated: 2 })
    expect(stagesOf(store, 'wf-shuffle').map((stage) => [stage.name, stage.position])).toEqual([
      ['待办', 0],
      ['实现', 1],
      ['已阻塞', 2],
      ['已完成', 3],
      ['已取消', 4],
    ])
  })

  it('补齐后重建与实时投影逐表全等；第二次调用零事实', () => {
    const db = memory()
    const store = storeOn(db, ids('st-blocked', 'st-done', 'st-cancelled'))
    const workflow: Workflow = { id: 'wf-eq', name: '等价流程', description: '', createdAt: AT }
    seedLegacy(db, store, workflow, [stageRow('st-impl', 'wf-eq', '实现', 0)])
    store.ensureBuiltinStages()

    const live = dumpProjection(db)
    const factsAfter = store.factsCount()
    store.rebuild()
    expect(dumpProjection(db)).toEqual(live)
    expect(store.factsCount()).toBe(factsAfter)
    expect(store.ensureBuiltinStages()).toEqual({ created: 0, updated: 0 })
    expect(store.factsCount()).toBe(factsAfter)
  })

  it('多个工作流一次补齐：各自独立补建，互不影响', () => {
    const db = memory()
    const store = storeOn(db, ids('st-a', 'st-b', 'st-c', 'st-d', 'st-e', 'st-f', 'st-g', 'st-h'))
    seedLegacy(db, store, { id: 'wf-1', name: '流程一', description: '', createdAt: AT }, [
      stageRow('st-one', 'wf-1', '实现', 0),
    ])
    seedLegacy(db, store, { id: 'wf-2', name: '流程二', description: '', createdAt: AT }, [
      stageRow('st-two', 'wf-2', '验收', 0),
    ])

    // 两个工作流各补 4 个内置阶段；各自唯一阶段的位置从 0 挪到 1 → 各 1 条 stage.updated
    expect(store.ensureBuiltinStages()).toEqual({ created: 8, updated: 2 })
    expect(stagesOf(store, 'wf-1').map((stage) => stage.name)).toEqual([
      '待办',
      '实现',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(stagesOf(store, 'wf-2').map((stage) => stage.name)).toEqual([
      '待办',
      '验收',
      '已阻塞',
      '已完成',
      '已取消',
    ])
  })
})

describe('planBuiltinStages：补齐计划是纯函数', () => {
  it('已规范的工作流：零变更', () => {
    const workflowId = 'wf-plan'
    const canonical = [
      stageRow('st-todo', workflowId, '待办', 0, { builtin: 'todo' }),
      stageRow('st-impl', workflowId, '实现', 1),
      stageRow('st-blocked', workflowId, '已阻塞', 2, { builtin: 'blocked' }),
      stageRow('st-done', workflowId, '已完成', 3, { builtin: 'done' }),
      stageRow('st-cancelled', workflowId, '已取消', 4, { builtin: 'cancelled' }),
    ]
    const plan = planBuiltinStages(workflowId, canonical, ids())
    expect(plan.changed).toEqual([])
    expect(plan.rows).toEqual(canonical)
  })

  it('老数据里名字叫「已完成」的行按名认领成内置，不会被当成自己添加的阶段', () => {
    const workflowId = 'wf-plan'
    const legacy = [
      stageRow('st-impl', workflowId, '实现', 0),
      stageRow('st-done', workflowId, '已完成', 1),
    ]
    const plan = planBuiltinStages(workflowId, legacy, ids('st-todo', 'st-blocked', 'st-cancelled'))
    expect(plan.rows.map((row) => [row.name, row.builtin ?? null, row.position])).toEqual([
      ['待办', 'todo', 0],
      ['实现', null, 1],
      ['已阻塞', 'blocked', 2],
      ['已完成', 'done', 3],
      ['已取消', 'cancelled', 4],
    ])
    // 认领保 id：不重建「已完成」
    expect(
      must(
        plan.rows.find((row) => row.name === '已完成'),
        '已完成',
      ).id,
    ).toBe('st-done')
    // 待办 / 已阻塞 / 已取消补建 + 实现与已完成的位置变化
    expect(plan.changed).toHaveLength(5)
  })

  it('同名内置阶段（脏数据）：第一个按名认领成内置，重复的那个留在自己添加的阶段里不改名', () => {
    const workflowId = 'wf-dup'
    const duplicated = [
      stageRow('st-blocked', workflowId, '已阻塞', 0),
      stageRow('st-blocked-2', workflowId, '已阻塞', 1),
    ]
    const plan = planBuiltinStages(
      workflowId,
      duplicated,
      ids('st-todo', 'st-done', 'st-cancelled'),
    )
    // 认领走的那个留在「已阻塞」的固定位置；重复的那个按自己添加的阶段排在自己添加的段里
    expect(plan.rows.map((row) => [row.id, row.builtin ?? null])).toEqual([
      ['st-todo', 'todo'],
      ['st-blocked-2', null],
      ['st-blocked', 'blocked'],
      ['st-done', 'done'],
      ['st-cancelled', 'cancelled'],
    ])
  })
})
