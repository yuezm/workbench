// @vitest-environment node
/**
 * 列描述符护栏（#4）：`host/store/columns` 与 `host/schema` 的 DDL 必须逐列一致。
 *
 * 这两份表述服务不同目的（描述符管编解码，DDL 管约束与外键），因此不能合成一份；
 * 但「列名与顺序」必须一致，否则写侧绑参个数对不上、读侧 SELECT 拿到 undefined。
 * 断言用真实库的 `PRAGMA table_info`，不扫源码文本——DDL 改了就一定被抓到。
 */
import { describe, expect, it } from 'vitest'
import { PROJECTION_TABLES } from '@workbench/kernel/core/types'
import { SCHEMA_SQL } from '@workbench/host-store/schema'
import {
  TABLE_SHAPES,
  fromRow,
  insertSql,
  selectList,
  valuesOf,
} from '@workbench/host-store/columns'
import { createMemoryDb } from './test-support'

/** 真实库里的列顺序（DDL 顺序）。 */
const ddlColumns = (db: ReturnType<typeof createMemoryDb>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
    (row) => row.name,
  )

describe('columns：描述符与 DDL 一致', () => {
  const db = createMemoryDb()

  it('每张投影表都有描述符，且表名与键一致', () => {
    expect(Object.keys(TABLE_SHAPES).sort()).toEqual([...PROJECTION_TABLES].sort())
    for (const [key, shape] of Object.entries(TABLE_SHAPES)) {
      expect(shape.table, key).toBe(key)
    }
  })

  it('列名与顺序逐张对齐 DDL', () => {
    for (const table of PROJECTION_TABLES) {
      const shape = TABLE_SHAPES[table]
      const actual = ddlColumns(db, table)
      const described = shape.columns.map((column) => column.column)
      expect(described, table).toEqual(actual)
    }
  })

  it('描述符没有重复列；保留名只出现在写入侧', () => {
    for (const table of PROJECTION_TABLES) {
      const shape = TABLE_SHAPES[table]
      const columns = shape.columns.map((column) => column.column)
      expect(new Set(columns).size, table).toBe(columns.length)
      for (const column of shape.columns) {
        if (column.prop.startsWith('@')) expect(['@at', '@payload'], table).toContain(column.prop)
      }
    }
  })

  it('INSERT 的占位符个数与列数一致，冲突分支不含主键', () => {
    for (const table of PROJECTION_TABLES) {
      const shape = TABLE_SHAPES[table]
      const sql = insertSql(shape)
      const head = sql.split('\n')[0]
      const placeholders = head.split('?').length - 1
      expect(placeholders, table).toBe(shape.columns.length)
      expect(sql, table).not.toMatch(/ON CONFLICT\(id\) DO UPDATE SET id = /)
    }
  })

  it('SELECT 列清单就是描述符的列清单', () => {
    for (const table of PROJECTION_TABLES) {
      const shape = TABLE_SHAPES[table]
      expect(selectList(shape), table).toBe(shape.columns.map((c) => c.column).join(', '))
    }
  })

  it('SCHEMA_SQL 覆盖全部描述符表', () => {
    for (const table of PROJECTION_TABLES) {
      expect(SCHEMA_SQL, table).toContain(`CREATE TABLE IF NOT EXISTS ${table} `)
    }
  })
})

describe('columns：编解码成对且往返一致', () => {
  const stageRow = {
    id: 'st-1',
    workflowId: 'wf-1',
    name: '进行中',
    position: 1,
    entryMode: 'agent',
    agentId: 'ag-1',
    script: { runtimeId: 'rt-1', args: ['pnpm'], cwd: null, env: {}, timeoutMs: 600000 },
    exits: { done: { do: 'goto', stageId: 'st-2' } },
    handoffs: [{ on: 'manual', workflowId: 'wf-2', stageId: 'st-9', forwardOnly: false }],
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: '照做',
    acceptance: ['门禁绿'],
    runTimeoutMs: null,
    judge: { maxFails: 2 },
    builtin: null,
  }

  it('阶段行：JSON 列往返，created_at 走事实时刻', () => {
    const shape = TABLE_SHAPES.workflow_stages
    const values = valuesOf(shape, stageRow, '2026-11-14T00:00:00.000Z')
    const row: Record<string, unknown> = {}
    shape.columns.forEach((column, index) => {
      row[column.column] = values[index]
    })
    expect(row.created_at).toBe('2026-11-14T00:00:00.000Z')
    expect(row.instructions).toBe('照做')
    const back = fromRow<typeof stageRow & { createdAt: string }>(shape, row)
    expect(back).toMatchObject({
      script: stageRow.script,
      exits: stageRow.exits,
      handoffs: stageRow.handoffs,
      acceptance: stageRow.acceptance,
      judge: stageRow.judge,
    })
  })

  it('缺字段的 NOT NULL 列按空串 / 空数组落库', () => {
    const shape = TABLE_SHAPES.workflow_stages
    const values = valuesOf(
      shape,
      { id: 'st-1', workflowId: 'wf-1', name: '跑', position: 0, entryMode: 'none', agentId: null },
      '2026-11-14T00:00:00.000Z',
    )
    const row: Record<string, unknown> = {}
    shape.columns.forEach((column, index) => {
      row[column.column] = values[index]
    })
    expect(row.instructions).toBe('')
    expect(row.exits_json).toBe('{}')
    expect(row.handoffs_json).toBe('[]')
    expect(row.acceptance_json).toBe('[]')
    expect(row.script_json).toBe('null')
    expect(fromRow<{ script: unknown; judge: unknown }>(shape, row)).toMatchObject({
      script: null,
      judge: null,
    })
  })

  it("历史行里的字符串 'null' / 空串读回 null（读侧不再各写一遍兜底）", () => {
    const shape = TABLE_SHAPES.runs
    const base = fromRow<{ script: unknown }>(shape, {
      script_json: 'null',
      event_ids_json: '[]',
      cancel_requested: 0,
    })
    expect(base.script).toBeNull()
    const blank = fromRow<{ script: unknown }>(shape, { script_json: '   ' })
    expect(blank.script).toBeNull()
  })

  it('run_events：payload 不含列名与事实时刻', () => {
    const shape = TABLE_SHAPES.run_events
    const values = valuesOf(
      shape,
      { runId: 'r-1', seq: 3, type: 'text', text: '哈', at: undefined },
      '2026-11-14T00:00:00.000Z',
    )
    expect(values).toEqual([
      'r-1',
      3,
      'text',
      JSON.stringify({ text: '哈' }),
      '2026-11-14T00:00:00.000Z',
    ])
  })

  it('cards：投递记录与布尔列', () => {
    const shape = TABLE_SHAPES.cards
    const values = valuesOf(shape, {
      id: 'c-1',
      runId: 'r-1',
      status: 'open',
      delivery: 'delivered',
      deliveryRefs: { 'in-app': { version: 1, ref: 'x', at: '2026-11-14T00:00:00.000Z' } },
      deliveryGivenUp: true,
      options: ['a'],
    })
    const row: Record<string, unknown> = {}
    shape.columns.forEach((column, index) => {
      row[column.column] = values[index]
    })
    expect(row.delivery_given_up).toBe(1)
    expect(row.options_json).toBe('["a"]')
    const back = fromRow<{ deliveryRefs: unknown; deliveryGivenUp: boolean }>(shape, row)
    expect(back.deliveryGivenUp).toBe(true)
    expect(back.deliveryRefs).toEqual({
      'in-app': { version: 1, ref: 'x', at: '2026-11-14T00:00:00.000Z' },
    })
  })
})
