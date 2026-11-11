// @vitest-environment node
/**
 * 账本性能基准（M1 T10）：1 万条事实的 `store.rebuild()` < 1000ms。
 *
 * 事实与增量投影用与 store 单次提交相同的写入路径批量落库（`appendFacts` +
 * `kernel.project` + 投影 writer + 元信息，同一事务），避免 1 万次 dispatch 的
 * 测试夹具开销污染计时；重建后取同一份快照逐表比较，避免只在空库上计时。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { decide } from '../../../src/kernel/decide'
import { project } from '../../../src/kernel/project'
import type { Actor, FactDraft, KernelPort } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import { withTx } from '../../../src/host/schema'
import { appendFacts, lastSeq } from '../../../src/host/store/facts'
import { createStore } from '../../../src/host/store/index'
import { currentProjectionFormat, writeProjectionMeta } from '../../../src/host/store/projection'
import { createProjectionWriter } from '../../../src/host/store/projection-apply'
import { createMemoryDb, dumpProjection } from './test-support'

/** 事实条数（1 条 runtime.create + 其余 runtime.updated）。 */
const FACTS_TARGET = 10_000
/** 验收上限：1 万事实重建 < 1 s。 */
const REBUILD_BUDGET_MS = 1000
const AT = '2026-04-04T04:04:04.000Z'
const OWNER: Actor = { kind: 'owner', via: 'ui' }
const kernel: KernelPort = { decide, project, viewSpec }

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

describe('rebuild 性能基准', () => {
  it('1 万条事实重建 < 1000ms，且与增量投影逐表全等', () => {
    const db = createMemoryDb()
    openDbs.push(db)
    const store = createStore({ db, kernel, now: () => AT, newId: () => 'rt-perf' })
    store.ensureProjection()
    store.dispatch({
      type: 'runtime.create',
      commandId: 'perf-0',
      input: { name: '性能运行时', executorKey: 'dsh', command: 'dsh' },
    })

    // 批量生成剩余事实，并按 store 的同一条路径增量落投影
    const seeded = store.query('runtimes.all')[0]
    if (!seeded) throw new Error('缺少性能运行时')
    let row = seeded
    const drafts: FactDraft[] = []
    for (let index = 1; index < FACTS_TARGET; index += 1) {
      // M27：运行时只剩连接字段，逐条换参数模板与启停（并发上限在智能体上）
      row = {
        ...row,
        argsTemplate: JSON.stringify([`--v${(index % 8) + 1}`]),
        enabled: index % 2 === 0,
      }
      drafts.push({ type: 'runtime.updated', actor: OWNER, at: AT, payload: { runtime: row } })
    }
    const writer = createProjectionWriter(db)
    withTx(db, () => {
      const facts = appendFacts(db, drafts)
      const writes = facts.flatMap((fact) =>
        kernel.project(fact).map((change) => ({ change, at: fact.at })),
      )
      writer.applyAll(writes)
      writeProjectionMeta(db, currentProjectionFormat(), lastSeq(db))
    })

    expect(store.factsCount()).toBe(FACTS_TARGET)
    const incremental = dumpProjection(db)
    expect(incremental.runtimes).toHaveLength(1)

    const startedAt = performance.now()
    store.rebuild()
    const elapsedMs = performance.now() - startedAt
    process.stdout.write(
      `[rebuild.perf] ${FACTS_TARGET} 条事实重建耗时：${elapsedMs.toFixed(1)} ms\n`,
    )

    expect(elapsedMs).toBeLessThan(REBUILD_BUDGET_MS)
    // 防空跑：事实全在、投影与增量快照逐表一致、末条事实的效果已体现
    expect(store.factsSince(0)).toHaveLength(FACTS_TARGET)
    expect(dumpProjection(db)).toEqual(incremental)
    const runtime = store.query('runtimes.all')[0]
    expect(runtime?.argsTemplate).toBe(JSON.stringify([`--v${((FACTS_TARGET - 1) % 8) + 1}`]))
    expect(runtime?.enabled).toBe((FACTS_TARGET - 1) % 2 === 0)
  }, 60_000)
})
