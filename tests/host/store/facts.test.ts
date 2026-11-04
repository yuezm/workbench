// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { FactDraft } from '../../../src/kernel/types'
import {
  allFacts,
  appendFacts,
  factsCount,
  factsSince,
  lastSeq,
} from '../../../src/host/store/facts'
import { SAMPLE_AT, createMemoryDb, sample } from './test-support'

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

const created = (): FactDraft => ({
  type: 'workflow.created',
  actor: { kind: 'owner', via: 'ui' },
  at: SAMPLE_AT,
  payload: { workflow: sample.workflow() },
})

describe('facts：只追加的事实日志', () => {
  it('appendFacts 返回带 seq 的事实；actor / cause / hops / payload 往返不丢', () => {
    const db = memory()
    const drafts: FactDraft[] = [
      created(),
      {
        type: 'task.created',
        actor: { kind: 'host', via: 'timer' },
        at: SAMPLE_AT,
        cause: 1,
        hops: 2,
        payload: { task: sample.task() },
      },
    ]

    const facts = appendFacts(db, drafts)

    expect(facts.map((fact) => fact.seq)).toEqual([1, 2])
    expect(facts[0]).toEqual({ ...drafts[0], seq: 1 })
    expect(facts[1]).toEqual({ ...drafts[1], seq: 2 })
    expect(allFacts(db)).toEqual(facts)
    expect(factsSince(db, 1)).toEqual([facts[1]])
    expect(factsSince(db, 2)).toEqual([])
    expect(lastSeq(db)).toBe(2)
    expect(factsCount(db)).toBe(2)
  })

  it('lastSeq 空日志为 0；AUTOINCREMENT 不复用已删的 seq', () => {
    const db = memory()
    expect(lastSeq(db)).toBe(0)
    expect(factsCount(db)).toBe(0)

    appendFacts(db, [created()])
    appendFacts(db, [created()])
    db.prepare('DELETE FROM facts WHERE seq = 2').run()
    const [third] = appendFacts(db, [created()])

    expect(third?.seq).toBe(3)
    expect(factsCount(db)).toBe(2)
    expect(lastSeq(db)).toBe(3)
    expect(factsSince(db, 0).map((fact) => fact.seq)).toEqual([1, 3])
  })
})
