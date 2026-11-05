// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Command } from '../../../src/protocol/commands'
import { createStore, StoreError } from '../../../src/host/store/index'
import { createFakeKernel } from './fake-kernel'
import { SAMPLE_AT, captureError, createMemoryDb, sequenceIds } from './test-support'

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

const createWorkflow = (commandId = 'c-1'): Command => ({
  commandId,
  type: 'workflow.create',
  input: {
    name: '研发',
    stages: [
      { name: '待办', entryMode: 'none' },
      { name: '完成', entryMode: 'user' },
    ],
  },
})

describe('store 命令幂等（M5）', () => {
  it('同一 commandId 重复提交：回放原事实、不产生新事实', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })
    const first = store.dispatch(createWorkflow())
    expect(first.facts).toHaveLength(3)
    const factsCount = store.factsCount()

    const replay = store.dispatch(createWorkflow())
    expect(replay.facts).toEqual(first.facts)
    expect(store.factsCount()).toBe(factsCount)
    expect(store.query('workflows.all')).toHaveLength(1)
  })

  it('reject 不入幂等表：同一 commandId 再次提交会重新决策并照样拒绝', () => {
    const db = memory()
    const store = createStore({ db, kernel: createFakeKernel(), now: () => SAMPLE_AT })
    const bad: Command = {
      commandId: 'c-bad',
      type: 'workflow.remove',
      id: 'wf-missing',
    }
    expect((captureError(() => store.dispatch(bad)) as StoreError).code).toBe('not_found')
    expect((captureError(() => store.dispatch(bad)) as StoreError).code).toBe('not_found')
    expect(store.factsCount()).toBe(0)
  })

  it('零事实命令也记幂等：回放空数组，不重复决策', () => {
    const db = memory()
    const kernel = createFakeKernel({ decide: () => ({ facts: [] }) })
    const store = createStore({ db, kernel, now: () => SAMPLE_AT })
    expect(store.dispatch(createWorkflow('zero')).facts).toEqual([])
    const again = store.dispatch(createWorkflow('zero'))
    expect(again.facts).toEqual([])
    expect(kernel.views).toHaveLength(1)
    expect(store.factsCount()).toBe(0)
  })

  it('不同 commandId 的同形命令各自落库', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2', 'wf-2', 'st-3', 'st-4'),
    })
    store.dispatch(createWorkflow('c-1'))
    store.dispatch(createWorkflow('c-2'))
    expect(store.query('workflows.all')).toHaveLength(2)
  })

  it('rememberCommand：连续事实可按区间回放；不连续只记已处理（回放空）', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })
    const created = store.dispatch(createWorkflow())
    // 连续区间原样记录
    store.rememberCommand('c-manual', created.facts)
    expect(store.commandFacts('c-manual')).toEqual(created.facts)

    // 不连续区间（模拟编排命令跨多次提交）只记「已处理」，回放为空数组
    const later = store.dispatch({
      commandId: 'c-later',
      type: 'workflow.remove',
      id: 'wf-1',
    })
    store.rememberCommand('c-orchestrated', [
      ...created.facts.slice(0, 1),
      ...later.facts,
    ] as typeof created.facts)
    expect(store.commandFacts('c-orchestrated')).toEqual([])

    expect(store.commandFacts('c-unknown')).toBeNull()
  })

  it('rebuild 不清 commands 表：重建后幂等仍生效', () => {
    const db = memory()
    const store = createStore({
      db,
      kernel: createFakeKernel(),
      now: () => SAMPLE_AT,
      newId: sequenceIds('wf-1', 'st-1', 'st-2'),
    })
    const first = store.dispatch(createWorkflow())
    store.rebuild()
    expect(store.query('workflows.all')).toHaveLength(1)
    expect(store.factsCount()).toBe(first.facts.length)
    const replay = store.dispatch(createWorkflow())
    expect(replay.facts).toEqual(first.facts)
    expect(store.factsCount()).toBe(first.facts.length)
  })
})
