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
  deliveryRefs,
  fromRow,
  insertSql,
  runEventPayloadCodec,
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

/**
 * 兜底分支：投影边界收的是「事实携带的行」，历史行与脏行都会到这里——空值、坏的 JSON、
 * 甚至运行时类型不符合契约的值。这些分支不该只看成防御代码：它们是「一条脏行不能把整张
 * 视图读挂」的实现。
 */
describe('columns：脏行 / 历史行的兜底', () => {
  /** 取某列在绑定值里的位置（按描述符顺序）。 */
  const indexOf = (shape: (typeof TABLE_SHAPES)[keyof typeof TABLE_SHAPES], prop: string): number =>
    shape.columns.findIndex((column) => column.prop === prop)

  it('toCell：布尔落 0/1（node:sqlite 不认 boolean），undefined 落 NULL', () => {
    const shape = TABLE_SHAPES.cards
    const versionIndex = indexOf(shape, 'version')
    // 运行时从外部 JSON 反序列化出来的 bool 也要能绑参：0/1 是列协议，不是 JS 的 true/false
    expect(valuesOf(shape, { version: true as unknown as number })[versionIndex]).toBe(1)
    expect(valuesOf(shape, { version: false as unknown as number })[versionIndex]).toBe(0)
    expect(valuesOf(shape, {})[versionIndex]).toBeNull()
  })

  it('JSON 对象列：空值 / 坏 JSON / 标量 / 数组一律归一成 {}', () => {
    const exits = (raw: Record<string, unknown>): unknown =>
      fromRow<{ exits: unknown }>(TABLE_SHAPES.workflow_stages, raw).exits
    expect(exits({})).toEqual({})
    expect(exits({ exits_json: '   ' })).toEqual({})
    expect(exits({ exits_json: '{"done":' })).toEqual({})
    expect(exits({ exits_json: 'null' })).toEqual({})
    expect(exits({ exits_json: '"一堆字"' })).toEqual({})
    expect(exits({ exits_json: '[]' })).toEqual({})
    expect(exits({ exits_json: '{"done":{"do":"await"}}' })).toEqual({ done: { do: 'await' } })
  })

  it('JSON 数组列：坏 JSON 按 [] 归一', () => {
    const labels = (raw: Record<string, unknown>): unknown =>
      fromRow<{ labels: unknown }>(TABLE_SHAPES.tasks, raw).labels
    expect(labels({})).toEqual([])
    expect(labels({ labels_json: '[1,' })).toEqual([])
    expect(labels({ labels_json: '["a"]' })).toEqual(['a'])
  })

  it('agents.env_json：缺字段写 {}，空值读回 {}', () => {
    const shape = TABLE_SHAPES.agents
    const envIndex = indexOf(shape, 'env')
    expect(valuesOf(shape, { id: 'ag-1' })[envIndex]).toBe('{}')
    expect(fromRow<{ env: unknown }>(shape, {}).env).toEqual({})
    expect(fromRow<{ env: unknown }>(shape, { env_json: '{"CI":"1"}' }).env).toEqual({ CI: '1' })
  })

  it('deliveryRefs（导出）：空值 / 坏值 / 非对象都按「没发过」', () => {
    expect(deliveryRefs.decode(undefined)).toEqual({})
    expect(deliveryRefs.decode('   ')).toEqual({})
    expect(deliveryRefs.decode('不是 JSON')).toEqual({})
    expect(deliveryRefs.decode('null')).toEqual({})
    expect(deliveryRefs.decode('[]')).toEqual({})
    expect(deliveryRefs.decode('{"in-app":{"version":2,"ref":"om_2","at":"t"}}')).toEqual({
      'in-app': { version: 2, ref: 'om_2', at: 't' },
    })
    expect(deliveryRefs.encode(undefined, {})).toBe('{}')
  })

  it('run_events 的 payload（导出）：空值按 {} 读回', () => {
    expect(runEventPayloadCodec.decode(undefined)).toEqual({})
    expect(runEventPayloadCodec.decode('  ')).toEqual({})
    expect(runEventPayloadCodec.decode('{坏')).toEqual({})
    expect(runEventPayloadCodec.decode('{"text":"哈"}')).toEqual({ text: '哈' })
  })

  it('@at 列：写入取事实时刻，读行不产生字段（描述符的 decode 是恒等）', () => {
    const shape = TABLE_SHAPES.workflow_stages
    const atIndex = indexOf(shape, '@at')
    expect(valuesOf(shape, { id: 'st-1' }, '2026-11-14T00:00:00.000Z')[atIndex]).toBe(
      '2026-11-14T00:00:00.000Z',
    )
    expect(fromRow(shape, { created_at: '2026-11-14T00:00:00.000Z' })).not.toHaveProperty('@at')
    const column = shape.columns[atIndex]
    expect(column?.codec.decode('2026-11-14T00:00:00.000Z')).toBe('2026-11-14T00:00:00.000Z')
  })
})
