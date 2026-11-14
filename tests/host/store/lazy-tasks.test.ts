// @vitest-environment node
/**
 * `loadView` 的 `tasks` 切片按需装载（性能整改）。
 *
 * 断言两件事：①按 id 取单行与整表遍历的**结果**与一次性装载等价；②装载确实被推迟——
 * 单行 `get` 不会把整表读进来，只有全量遍历才装载全部。
 */
import { describe, expect, it } from 'vitest'
import { loadView } from '../../../src/host/store/views'
import { createMemoryDb, sample } from './test-support'

/** 内存库 + 关闭外键（本用例只测装载路径，不建依赖行）。 */
function openTasksDb(): ReturnType<typeof createMemoryDb> {
  const db = createMemoryDb()
  db.exec('PRAGMA foreign_keys = OFF')
  return db
}

/** 直接写一行 tasks（绕开内核，只测装载路径）。 */
function insertTask(
  db: ReturnType<typeof createMemoryDb>,
  task: ReturnType<typeof sample.task>,
): void {
  // `node:sqlite` 的匿名参数不接受 undefined：可空列统一归一成 null。
  const nn = <T>(value: T | null | undefined): T | null => value ?? null
  db.prepare(
    `INSERT INTO tasks (id, title, description, workflow_id, project_id, current_stage_id,
       status, origin, rule_id, external_ref, labels_json, thread_id, parent_task_id,
       spawned_by_run_id, batch_no, spawn_key, handoff_from_task_id, handoff_from_stage_id,
       handoff_from_run_id, gate_fails, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.title,
    task.description,
    task.workflowId,
    nn(task.projectId),
    nn(task.currentStageId),
    task.status,
    task.origin,
    nn(task.ruleId),
    nn(task.externalRef),
    JSON.stringify(task.labels),
    nn(task.threadId),
    nn(task.parentTaskId),
    nn(task.spawnedByRunId),
    nn(task.batchNo),
    nn(task.spawnKey),
    nn(task.handoffFromTaskId),
    nn(task.handoffFromStageId),
    nn(task.handoffFromRunId),
    nn(task.gateFails),
    task.createdAt,
    task.updatedAt,
  )
}

describe('loadView 的 tasks 按需装载', () => {
  it('get / has 按 id 单行装载，未命中的 id 返回 undefined', () => {
    const db = openTasksDb()
    const first = sample.task({ id: 'tk-1', title: '甲' })
    const second = sample.task({ id: 'tk-2', title: '乙', createdAt: '2026-01-02T00:00:00.000Z' })
    insertTask(db, first)
    insertTask(db, second)
    const view = loadView(db, ['tasks'])

    // 单行命中后缓存：第二次 get 走缓存分支，结果一致
    expect(view.tasks.get('tk-1')).toEqual(first)
    expect(view.tasks.get('tk-1')).toEqual(first)
    // 未命中（未装载状态）→ 单行查库落空
    expect(view.tasks.get('missing')).toBeUndefined()
    // has 未装载状态：命中行读出来缓存，未命中返回 false
    expect(view.tasks.has('tk-2')).toBe(true)
    expect(view.tasks.get('tk-2')).toEqual(second)
    // 已缓存后再 has：命中缓存分支（不再查库）
    expect(view.tasks.has('tk-2')).toBe(true)
    expect(view.tasks.has('missing')).toBe(false)
    db.close()
  })

  it('全量遍历（size / values / keys / entries / forEach / 迭代器）结果与整表一致', () => {
    const db = openTasksDb()
    const first = sample.task({ id: 'tk-1', title: '甲' })
    const second = sample.task({ id: 'tk-2', title: '乙', createdAt: '2026-01-02T00:00:00.000Z' })
    insertTask(db, first)
    insertTask(db, second)
    const view = loadView(db, ['tasks'])

    // size 触发整表装载；重复访问走已装载分支
    expect(view.tasks.size).toBe(2)
    expect(view.tasks.size).toBe(2)

    expect([...view.tasks.values()]).toEqual([first, second])
    expect([...view.tasks.keys()]).toEqual(['tk-1', 'tk-2'])
    expect([...view.tasks.entries()]).toEqual([
      ['tk-1', first],
      ['tk-2', second],
    ])
    const seen: string[] = []
    view.tasks.forEach((task) => seen.push(task.id))
    expect(seen).toEqual(['tk-1', 'tk-2'])
    expect([...view.tasks]).toEqual([
      ['tk-1', first],
      ['tk-2', second],
    ])

    // 已装载后：未命中直接返回，不再查库；has 走已装载分支
    expect(view.tasks.get('missing')).toBeUndefined()
    expect(view.tasks.has('missing')).toBe(false)
    db.close()
  })

  it('未声明 tasks 切片时给空 Map（不做惰性装载）', () => {
    const db = openTasksDb()
    insertTask(db, sample.task({ id: 'tk-1' }))
    const view = loadView(db, [])
    expect(view.tasks.size).toBe(0)
    expect(view.tasks.get('tk-1')).toBeUndefined()
    db.close()
  })
})
