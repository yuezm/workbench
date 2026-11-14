// @vitest-environment node
/**
 * 用量统计视图（M36-E）：`usage.daily` / `usage.byAgent`。
 *
 * 口径三条（缺一项都会让人误读账单）：
 * 1. 只算**已结束**的轮次（queued/running/waiting 不产生费用）；
 * 2. 缺 token / 缺成本的轮次**单独计数**，不当 0；
 * 3. 时间窗按 `endedAt` 的 UTC 日期切天，参数只给 `days` 与 `now`，不读系统时钟。
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunRow } from '../../src/protocol/entities'
import { createProjectionWriter } from '../../src/host/store/projection-apply'
import { queryView } from '../../src/host/store/views'
import type { UsageAgentRow, UsageDailyRow } from '../../src/protocol/views'
import { createMemoryDb, sample } from './store/test-support'

const NOW = '2026-11-14T12:00:00.000Z'

let openDbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

const memory = (): DatabaseSync => {
  const db = createMemoryDb()
  // 视图用例只关心聚合，不建业务行：关外键，直接用投影 writer 种 run
  db.exec('PRAGMA foreign_keys = OFF')
  openDbs.push(db)
  return db
}

const daily = (db: DatabaseSync, params: { days?: number; now?: string }): UsageDailyRow[] =>
  queryView(db, 'usage.daily', params) as UsageDailyRow[]

const byAgent = (db: DatabaseSync, params: { days?: number; now?: string }): UsageAgentRow[] =>
  queryView(db, 'usage.byAgent', params) as UsageAgentRow[]

/** 用投影 writer 种一行终态 run（与真实写路径同一套列映射）。 */
function seedRun(db: DatabaseSync, over: Partial<RunRow> & { id: string }): void {
  const row = sample.run({
    status: 'succeeded',
    agentId: 'ag-1',
    startedAt: '2026-11-13T23:50:00.000Z',
    endedAt: '2026-11-14T00:10:00.000Z',
    ...over,
  })
  createProjectionWriter(db).apply({ table: 'runs', key: row.id, row }, '2026-11-14T00:10:00.000Z')
}

const usage = (over: Partial<NonNullable<RunRow['usage']>> = {}): NonNullable<RunRow['usage']> => ({
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  ...over,
})

describe('usage.daily：按 UTC 日期聚合', () => {
  it('两天的轮次分组；成本缺失单独计数（不当 0）', () => {
    const db = memory()
    seedRun(db, { id: 'r1', usage: usage({ costUsd: 0.5 }), endedAt: '2026-11-13T10:00:00.000Z' })
    seedRun(db, { id: 'r2', usage: usage({ costUsd: null }), endedAt: '2026-11-14T10:00:00.000Z' })
    seedRun(db, {
      id: 'r3',
      usage: usage({ inputTokens: 1, outputTokens: 2, costUsd: 0.25 }),
      endedAt: '2026-11-14T11:00:00.000Z',
    })

    const rows = daily(db, { days: 7, now: NOW })
    expect(rows.map((row) => row.date)).toEqual(['2026-11-13', '2026-11-14'])

    const [first, second] = rows
    expect(first).toMatchObject({
      rounds: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.5,
      missingTokens: 0,
      missingCost: 0,
    })
    expect(second).toMatchObject({
      rounds: 2,
      inputTokens: 101,
      outputTokens: 52,
      costUsd: 0.25,
      missingTokens: 0,
      // 第二轮没报成本：成本合计只算报了的那一轮，缺的那轮单独计数
      missingCost: 1,
    })
  })

  it('没有 usage 的轮次：计入轮数，token 与成本都算缺失', () => {
    const db = memory()
    seedRun(db, { id: 'r1', usage: null })
    const [row] = daily(db, { days: 7, now: NOW })
    expect(row).toMatchObject({
      rounds: 1,
      inputTokens: 0,
      costUsd: 0,
      missingTokens: 1,
      missingCost: 1,
    })
  })

  it('窗口按 endedAt 过滤；未结束的轮次不计', () => {
    const db = memory()
    seedRun(db, { id: 'old', usage: usage(), endedAt: '2026-10-01T00:00:00.000Z' })
    seedRun(db, { id: 'recent', usage: usage(), endedAt: '2026-11-14T00:00:00.000Z' })
    seedRun(db, { id: 'running', status: 'running', usage: usage(), endedAt: null })

    const rows = daily(db, { days: 2, now: NOW })
    expect(rows.map((row) => row.date)).toEqual(['2026-11-14'])
    expect(rows[0]?.rounds).toBe(1)
  })
})

describe('usage 视图参数缺省', () => {
  it('不给参数：按全部历史聚合（只给 days 时窗口取 7 天）', () => {
    const db = memory()
    seedRun(db, { id: 'old', usage: usage({ costUsd: 0.1 }), endedAt: '2026-01-01T00:00:00.000Z' })
    seedRun(db, { id: 'new', usage: usage({ costUsd: 0.2 }), endedAt: '2026-11-14T00:00:00.000Z' })

    expect(queryView(db, 'usage.daily', undefined) as UsageDailyRow[]).toHaveLength(2)
  })
})

describe('usage.byAgent：按智能体聚合', () => {
  it('两个智能体各一行；没有智能体的轮次归 null', () => {
    const db = memory()
    seedRun(db, { id: 'r1', agentId: 'ag-1', usage: usage({ costUsd: 0.1 }) })
    seedRun(db, {
      id: 'r2',
      agentId: 'ag-2',
      usage: usage({ costUsd: 0.2 }),
      endedAt: '2026-11-14T11:00:00.000Z',
    })
    seedRun(db, {
      id: 'r3',
      agentId: null,
      usage: usage({ costUsd: null }),
      endedAt: '2026-11-14T11:30:00.000Z',
    })

    const rows = byAgent(db, { days: 7, now: NOW })
    const byId = new Map(rows.map((row) => [row.agentId, row]))
    expect(byId.get('ag-1')).toMatchObject({ rounds: 1, costUsd: 0.1, missingCost: 0 })
    expect(byId.get('ag-2')).toMatchObject({ rounds: 1, costUsd: 0.2 })
    expect(byId.get(null)).toMatchObject({ rounds: 1, costUsd: 0, missingCost: 1 })
  })
})
