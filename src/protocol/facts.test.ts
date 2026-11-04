import { describe, expect, it } from 'vitest'
import type { Runtime } from './entities'
import {
  FACT_TYPES,
  type FactPayloads,
  type FactType,
  type SnapshotImportedPayload,
  type TaskMovedPayload,
  type FactPayload,
} from './facts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/** payload 映射的键必须恰好覆盖 FACT_TYPES。 */
const payloadKeysCover: Assert<Equal<keyof FactPayloads, FactType>> = true
/** 泛型取出的 payload 类型与具名类型一致。 */
const payloadIndexing: Assert<Equal<FactPayload<'task.moved'>, TaskMovedPayload>> = true
/** runtime 事实一律携带完整行（含 lastProbe），`project` 不做特判。 */
const runtimePayloads: [
  Assert<Equal<FactPayload<'runtime.created'>, { runtime: Runtime }>>,
  Assert<Equal<FactPayload<'runtime.updated'>, { runtime: Runtime }>>,
  Assert<Equal<FactPayload<'runtime.removed'>, { runtime: Runtime }>>,
  Assert<Equal<FactPayload<'runtime.probed'>, { runtime: Runtime }>>,
] = [true, true, true, true]

const expected = [
  'workflow.created',
  'workflow.updated',
  'workflow.removed',
  'stage.created',
  'stage.updated',
  'stage.deleted',
  'agent.created',
  'agent.updated',
  'agent.removed',
  'runtime.created',
  'runtime.updated',
  'runtime.removed',
  'runtime.probed',
  'task.created',
  'task.moved',
  'task.completed',
  'task.removed',
  'snapshot.imported',
]

describe('protocol/facts', () => {
  it('FACT_TYPES 覆盖 M1 事实目录且顺序稳定', () => {
    expect([...FACT_TYPES]).toEqual(expected)
  })

  it('事实名唯一，均为小写点分，且只属于 M1 已登记的前缀', () => {
    expect(new Set(FACT_TYPES).size).toBe(FACT_TYPES.length)
    const prefixes = new Set(['workflow', 'stage', 'agent', 'runtime', 'task', 'snapshot'])
    for (const type of FACT_TYPES) {
      expect(type).toMatch(/^[a-z]+\.[a-z_]+$/)
      expect(prefixes.has(type.split('.')[0])).toBe(true)
    }
  })

  it('事实名到 payload 的映射完整（类型级断言）', () => {
    expect(payloadKeysCover).toBe(true)
    expect(payloadIndexing).toBe(true)
    expect(runtimePayloads).toEqual([true, true, true, true])
  })

  it('snapshot.imported 用 table 判别行类型，五张投影表都能导入', () => {
    const payloads: SnapshotImportedPayload[] = [
      { table: 'tasks', rows: [], importedFrom: 'v2' },
      { table: 'workflows', rows: [], importedFrom: 'v2' },
      { table: 'workflow_stages', rows: [], importedFrom: 'v2' },
      { table: 'agents', rows: [], importedFrom: 'v2' },
      { table: 'runtimes', rows: [], importedFrom: 'v2' },
    ]

    expect(payloads.map((payload) => payload.table)).toEqual([
      'tasks',
      'workflows',
      'workflow_stages',
      'agents',
      'runtimes',
    ])
    for (const payload of payloads) {
      expect(payload.rows).toEqual([])
      expect(payload.importedFrom).toBe('v2')
    }
  })
})
